import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compactMessages,
	detectProjectRoot,
} from "../lib/compact-output.mjs";

// ---------------------------------------------------------------------------
// compactMessages
// ---------------------------------------------------------------------------

describe("compactMessages", () => {
	it("returns empty array for empty input", () => {
		assert.deepEqual(compactMessages([]), []);
	});

	it("passes through normal user and assistant messages", () => {
		const msgs = [
			"**User:** hello",
			"**Assistant:** hi there, how can I help?",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 2);
		assert.ok(result[0].includes("hello"));
		assert.ok(result[1].includes("hi there"));
	});

	// R4: Phatic stripping
	it("strips phatic 'Confirmed' assistant messages under 200 chars", () => {
		const msgs = [
			"**User:** remember this",
			"**Assistant:** Confirmed — ready for the test.",
			"**User:** next thing",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 2);
		assert.ok(!result.some((m) => m.includes("Confirmed")));
	});

	it("strips 'Memories checked' phatic", () => {
		const msgs = [
			"**Assistant:** Memories checked. Ready to go.",
			"**User:** do stuff",
		];
		const result = compactMessages(msgs);
		assert.ok(!result.some((m) => m.includes("Memories checked")));
	});

	it("does NOT strip long assistant messages starting with phatic words", () => {
		const longMsg =
			"**Assistant:** Confirmed — here is the detailed analysis: " +
			"x".repeat(200);
		const msgs = [longMsg];
		const result = compactMessages(msgs);
		assert.equal(result.length, 1);
		assert.ok(result[0].includes("detailed analysis"));
	});

	it("does NOT strip assistant messages that don't match phatic patterns", () => {
		const msgs = ["**Assistant:** I'll investigate the bug now."];
		const result = compactMessages(msgs);
		assert.equal(result.length, 1);
	});

	// R3: Operational noise stripping
	it("strips stats box messages", () => {
		const msgs = [
			"**Assistant:** ┌───\n│  Context Guardian Stats\n│\n│  Current usage: 50,000\n└───",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 0);
	});

	it("strips compact-cli JSON output", () => {
		const msgs = [
			'**Assistant:** ← {"success":true,"statsBlock":"┌── Compaction Stats"}',
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 0);
	});

	it("strips checkpoint saved messages", () => {
		const msgs = [
			"**Assistant:** ┌──\n│  Checkpoint saved — NOT applied yet.\n└──",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 0);
	});

	it("strips date +%s commands", () => {
		const msgs = ["**Assistant:** → Ran `date +%s`\n← 1774736467"];
		const result = compactMessages(msgs);
		assert.equal(result.length, 0);
	});

	it("strips state file reads", () => {
		const msgs = [
			"**Assistant:** → Read `state-abc123.json`\nsome content",
		];
		// This won't match because the pattern checks for state- in path
		// Let me use the exact pattern
		const msgs2 = [
			"**Assistant:** → Read /data/state-abc123.json",
		];
		const result = compactMessages(msgs2);
		assert.equal(result.length, 0);
	});

	// R2: Tool note grouping
	it("groups consecutive Read notes into one line", () => {
		const msgs = [
			"**Assistant:** → Read `lib/a.mjs`",
			"**Assistant:** → Read `lib/b.mjs`",
			"**Assistant:** → Read `lib/c.mjs`",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 1);
		assert.ok(result[0].includes("lib/a.mjs"));
		assert.ok(result[0].includes("lib/b.mjs"));
		assert.ok(result[0].includes("lib/c.mjs"));
		assert.ok(result[0].includes("; "));
	});

	it("groups mixed Read/Grep/Glob notes", () => {
		const msgs = [
			"**Assistant:** → Read `lib/a.mjs`",
			"**Assistant:** → Grep `pattern` in `src/`",
			"**Assistant:** → Glob `*.test.mjs`",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 1);
	});

	it("does NOT group multi-line entries with >4 lines", () => {
		const bigWrite =
			"**Assistant:** → Write `out.txt`:\n    line1\n    line2\n    line3\n    line4\n    line5";
		const msgs = [
			"**Assistant:** → Read `a.mjs`",
			bigWrite,
			"**Assistant:** → Read `b.mjs`",
		];
		const result = compactMessages(msgs);
		// Read a.mjs should be its own (flushed before bigWrite)
		// bigWrite is its own
		// Read b.mjs is its own
		assert.equal(result.length, 3);
	});

	it("groups short multi-line entries (<=4 lines)", () => {
		const shortWrite = "**Assistant:** → Write `/tmp/test.txt`:\n    content";
		const msgs = [
			"**Assistant:** → Read `a.mjs`",
			shortWrite,
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 1); // grouped together
	});

	// Bare tool lines merge into previous
	it("merges bare ← lines into previous message", () => {
		const msgs = [
			"**Assistant:** some text",
			"← tool output here",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 1);
		assert.ok(result[0].includes("some text"));
		assert.ok(result[0].includes("← tool output here"));
	});

	it("preserves non-grouped messages between groups", () => {
		const msgs = [
			"**Assistant:** → Read `a.mjs`",
			"**Assistant:** → Read `b.mjs`",
			"**User:** what did you find?",
			"**Assistant:** → Read `c.mjs`",
			"**Assistant:** → Read `d.mjs`",
		];
		const result = compactMessages(msgs);
		assert.equal(result.length, 3); // group1, user, group2
		assert.ok(result[0].includes("a.mjs"));
		assert.ok(result[0].includes("b.mjs"));
		assert.ok(result[1].includes("what did you find"));
		assert.ok(result[2].includes("c.mjs"));
		assert.ok(result[2].includes("d.mjs"));
	});
});

// ---------------------------------------------------------------------------
// detectProjectRoot
// ---------------------------------------------------------------------------

describe("detectProjectRoot", () => {
	function makeLine(toolName, filePath) {
		return JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: toolName,
						input: { file_path: filePath },
					},
				],
			},
		});
	}

	it("returns empty string for fewer than 3 paths", () => {
		const lines = [
			makeLine("Read", "/home/user/project/a.js"),
			makeLine("Read", "/home/user/project/b.js"),
		];
		assert.equal(detectProjectRoot(lines, 0), "");
	});

	it("detects common project root from multiple paths", () => {
		const lines = [
			makeLine("Read", "/home/user/code/myproject/lib/a.mjs"),
			makeLine("Read", "/home/user/code/myproject/lib/b.mjs"),
			makeLine("Read", "/home/user/code/myproject/test/c.mjs"),
			makeLine("Read", "/home/user/code/myproject/test/d.mjs"),
			makeLine("Read", "/home/user/code/myproject/hooks/e.mjs"),
		];
		const root = detectProjectRoot(lines, 0);
		assert.ok(root.includes("/home/user/code/myproject/"));
	});

	it("picks project root over subdirectory", () => {
		const lines = [
			makeLine("Read", "/home/user/code/proj/lib/a.mjs"),
			makeLine("Read", "/home/user/code/proj/lib/b.mjs"),
			makeLine("Read", "/home/user/code/proj/lib/c.mjs"),
			makeLine("Read", "/home/user/code/proj/test/d.mjs"),
			makeLine("Read", "/home/user/code/proj/test/e.mjs"),
			makeLine("Read", "/home/user/code/proj/hooks/f.mjs"),
		];
		const root = detectProjectRoot(lines, 0);
		assert.equal(root, "/home/user/code/proj/");
	});

	it("handles mixed paths with different roots", () => {
		const lines = [
			makeLine("Read", "/home/user/code/proj/lib/a.mjs"),
			makeLine("Read", "/home/user/code/proj/lib/b.mjs"),
			makeLine("Read", "/home/user/code/proj/lib/c.mjs"),
			makeLine("Read", "/home/user/code/proj/test/d.mjs"),
			makeLine("Read", "/home/user/code/proj/hooks/e.mjs"),
			makeLine("Read", "/tmp/other/deep/file.txt"),
		];
		const root = detectProjectRoot(lines, 0);
		assert.ok(root.includes("/home/user/code/proj/"));
	});

	it("returns empty for non-absolute paths", () => {
		const lines = [
			makeLine("Read", "lib/a.mjs"),
			makeLine("Read", "lib/b.mjs"),
			makeLine("Read", "test/c.mjs"),
		];
		assert.equal(detectProjectRoot(lines, 0), "");
	});

	it("respects startIdx", () => {
		const lines = [
			makeLine("Read", "/old/project/a.mjs"),
			makeLine("Read", "/old/project/b.mjs"),
			makeLine("Read", "/old/project/c.mjs"),
			// startIdx = 3: only these count
			makeLine("Read", "/new/project/d.mjs"),
		];
		// Only 1 path from startIdx=3, so should return empty
		assert.equal(detectProjectRoot(lines, 3), "");
	});

	it("skips non-assistant lines", () => {
		const lines = [
			JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
			makeLine("Read", "/home/user/proj/a.mjs"),
			makeLine("Read", "/home/user/proj/b.mjs"),
			makeLine("Read", "/home/user/proj/c.mjs"),
		];
		const root = detectProjectRoot(lines, 0);
		assert.ok(root.includes("/home/user/proj/"));
	});

	it("handles malformed JSON gracefully", () => {
		const lines = [
			"not valid json{{{",
			makeLine("Read", "/home/user/proj/a.mjs"),
			makeLine("Read", "/home/user/proj/b.mjs"),
			makeLine("Read", "/home/user/proj/c.mjs"),
		];
		const root = detectProjectRoot(lines, 0);
		assert.ok(root.includes("/home/user/proj/"));
	});
});

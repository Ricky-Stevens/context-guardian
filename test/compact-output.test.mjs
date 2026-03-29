import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactMessages, detectProjectRoot } from "../lib/compact-output.mjs";

// ---------------------------------------------------------------------------
// compactMessages — exchange-grouped output with noise stripping
// ---------------------------------------------------------------------------

describe("compactMessages", () => {
	it("returns empty array for empty input", () => {
		assert.deepEqual(compactMessages([]), []);
	});

	it("groups user + assistant messages into exchange blocks with [N] anchors", () => {
		const msgs = [
			"**User:** hello",
			"**Assistant:** hi there, how can I help?",
			"**User:** fix the bug",
			"**Assistant:** Done, I fixed it.",
		];
		const result = compactMessages(msgs);
		assert.ok(result.length >= 1);
		assert.ok(result[0].includes("[1]"));
		assert.ok(result[0].includes("hello"));
		assert.ok(result[0].includes("hi there"));
	});

	// R4: Phatic stripping
	it("strips phatic 'Confirmed' assistant messages under 200 chars", () => {
		const msgs = [
			"**User:** remember this",
			"**Assistant:** Confirmed — ready for the test.",
			"**User:** next thing",
			"**Assistant:** Working on it.",
		];
		const result = compactMessages(msgs);
		assert.ok(!result.some((m) => m.includes("Confirmed")));
	});

	it("strips 'Done.' trivial assistant messages", () => {
		const msgs = [
			"**User:** edit the file",
			"**Assistant:** → Edit `foo.js`:\n    old: | x\n    new: | y",
			"**Assistant:** Done.",
			"**User:** next",
			"**Assistant:** OK.",
		];
		const result = compactMessages(msgs);
		assert.ok(!result.some((m) => /\bDone\.\s*$/.test(m)));
	});

	it("does NOT strip long assistant messages starting with phatic words", () => {
		const longMsg =
			"**Assistant:** Confirmed — here is the detailed analysis: " +
			"x".repeat(200);
		const msgs = ["**User:** question", longMsg];
		const result = compactMessages(msgs);
		assert.ok(result.some((m) => m.includes("detailed analysis")));
	});

	it("does NOT strip assistant messages that don't match phatic patterns", () => {
		const msgs = [
			"**User:** fix it",
			"**Assistant:** I'll investigate the bug now.",
		];
		const result = compactMessages(msgs);
		assert.ok(result.some((m) => m.includes("investigate the bug")));
	});

	// R3: Operational noise stripping
	it("strips stats box messages", () => {
		const msgs = [
			"**User:** check stats",
			"**Assistant:** ┌───\n│  Context Guardian Stats\n│\n│  Current usage: 50,000\n└───",
		];
		const result = compactMessages(msgs);
		assert.ok(!result.some((m) => m.includes("Context Guardian Stats")));
	});

	it("strips date +%s commands", () => {
		const msgs = [
			"**User:** check time",
			"**Assistant:** → Ran `date +%s`\n← 1774736467",
		];
		const result = compactMessages(msgs);
		assert.ok(!result.some((m) => m.includes("date +%s")));
	});

	it("strips meta-tool ToolSearch invocations", () => {
		const msgs = [
			"**User:** find the tool",
			'**Assistant:** → Tool: `ToolSearch` {"query":"select:mcp__serena__list_memories"}',
			"**Assistant:** → Serena: list memories",
			"**Assistant:** Here are the results.",
		];
		const result = compactMessages(msgs);
		assert.ok(!result.some((m) => m.includes("ToolSearch")));
	});

	// R2: Tool note grouping within exchanges
	it("groups consecutive Read notes into one line", () => {
		const msgs = [
			"**User:** read these",
			"**Assistant:** → Read `lib/a.mjs`",
			"**Assistant:** → Read `lib/b.mjs`",
			"**Assistant:** → Read `lib/c.mjs`",
		];
		const result = compactMessages(msgs);
		// All reads should be in one exchange block
		const block = result.find((m) => m.includes("a.mjs"));
		assert.ok(block);
		assert.ok(block.includes("b.mjs"));
		assert.ok(block.includes("c.mjs"));
	});

	// Merging consecutive assistant messages
	it("merges consecutive assistant text into one exchange block", () => {
		const msgs = [
			"**User:** analyze this",
			"**Assistant:** First observation.",
			"**Assistant:** Second observation.",
			"**Assistant:** Third observation.",
		];
		const result = compactMessages(msgs);
		// Should be one exchange block containing all three
		const block = result.find((m) => m.includes("First observation"));
		assert.ok(block);
		assert.ok(block.includes("Second observation"));
		assert.ok(block.includes("Third observation"));
	});

	it("merges bare ← lines into exchange block", () => {
		const msgs = [
			"**User:** run tests",
			"**Assistant:** → Ran `npm test`",
			"← 14 passed",
		];
		const result = compactMessages(msgs);
		const block = result[0];
		assert.ok(block.includes("npm test"));
		assert.ok(block.includes("14 passed"));
	});

	it("separates exchanges at User boundaries", () => {
		const msgs = [
			"**User:** first question",
			"**Assistant:** first answer",
			"**User:** second question",
			"**Assistant:** second answer",
		];
		const result = compactMessages(msgs);
		assert.ok(result.length >= 2);
		assert.ok(result[0].includes("first"));
		assert.ok(result[1].includes("second"));
	});

	it("adds [N] exchange anchors", () => {
		const msgs = [
			"**User:** q1",
			"**Assistant:** a1",
			"**User:** q2",
			"**Assistant:** a2",
			"**User:** q3",
			"**Assistant:** a3",
		];
		const result = compactMessages(msgs);
		assert.ok(result[0].includes("[1]"));
		assert.ok(result[1].includes("[2]"));
		assert.ok(result[2].includes("[3]"));
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
			makeLine("Read", "/new/project/d.mjs"),
		];
		assert.equal(detectProjectRoot(lines, 3), "");
	});

	it("skips non-assistant lines", () => {
		const lines = [
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "hi" },
			}),
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

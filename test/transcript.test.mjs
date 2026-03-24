import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { extractConversation, extractRecent } from "../lib/transcript.mjs";

let tmpDir;
let transcriptPath;

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, JSON.stringify(obj) + "\n");
}

function userMsg(text) {
	return {
		type: "user",
		message: { role: "user", content: text },
	};
}

function assistantMsg(text) {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	};
}

function assistantToolOnly() {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "Read", input: { path: "/foo" } },
			],
		},
	};
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-test-"));
	transcriptPath = path.join(tmpDir, "transcript.jsonl");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// extractConversation
// =========================================================================
describe("extractConversation", () => {
	it("returns placeholder for missing transcript", () => {
		assert.equal(extractConversation(null), "(no transcript available)");
		assert.equal(
			extractConversation("/no/such/file"),
			"(no transcript available)",
		);
	});

	it("extracts user and assistant text messages", () => {
		writeLine(userMsg("Hello Claude"));
		writeLine(assistantMsg("Hello! How can I help?"));
		writeLine(userMsg("Fix the bug"));
		writeLine(assistantMsg("Done, I fixed it."));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("**User:** Hello Claude"));
		assert.ok(result.includes("**Assistant:** Hello! How can I help?"));
		assert.ok(result.includes("**User:** Fix the bug"));
		assert.ok(result.includes("**Assistant:** Done, I fixed it."));
	});

	it("replaces tool-only assistant messages with placeholder", () => {
		writeLine(userMsg("show me the file"));
		writeLine(assistantToolOnly());
		writeLine(assistantMsg("Here is the file content."));

		const result = extractConversation(transcriptPath);
		// Tool-only assistant message gets a placeholder
		assert.ok(result.includes("**Assistant:** [Performed tool operations]"));
		assert.ok(result.includes("**Assistant:** Here is the file content."));
	});

	it("skips empty user messages", () => {
		writeLine(userMsg(""));
		writeLine(userMsg("real message"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("**User:** \n")); // no empty user entry
		assert.ok(result.includes("**User:** real message"));
	});

	// --- Compact marker detection ---
	it("detects [SMART COMPACT marker and uses as boundary", () => {
		writeLine(userMsg("old message"));
		writeLine(assistantMsg("old response"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"[SMART COMPACT — restored checkpoint]\n\n**User:** prior\n\n**Assistant:** prior answer",
			},
		});
		writeLine(userMsg("new message"));
		writeLine(assistantMsg("new response"));

		const result = extractConversation(transcriptPath);
		// Should NOT include "old message" — it's before the marker
		assert.ok(!result.includes("**User:** old message"));
		// Should include preamble (the marker content) and new messages
		assert.ok(result.includes("new message"));
		assert.ok(result.includes("new response"));
	});

	it("detects [KEEP RECENT marker", () => {
		writeLine(userMsg("old"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: "[KEEP RECENT — restored checkpoint]\n\nstuff",
			},
		});
		writeLine(userMsg("new"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("**User:** old"));
		assert.ok(result.includes("**User:** new"));
	});

	it("detects # Context Checkpoint marker", () => {
		writeLine(userMsg("old"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"# Context Checkpoint (Smart Compact)\n> Created: 2026-01-01\n\n**User:** hi",
			},
		});
		writeLine(userMsg("new"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("**User:** old"));
		assert.ok(result.includes("**User:** new"));
	});

	it("uses the LAST marker when multiple exist", () => {
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: "[SMART COMPACT — first]\n\nfirst checkpoint",
			},
		});
		writeLine(userMsg("middle"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: "[KEEP RECENT — second]\n\nsecond checkpoint",
			},
		});
		writeLine(userMsg("latest"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("**User:** middle"));
		assert.ok(result.includes("**User:** latest"));
	});

	// --- CG menu reply filtering ---
	it("filters menu replies after CG menu prompt", () => {
		// Simulate: assistant shows CG menu, user replies with "2"
		writeLine(userMsg("implement feature"));
		writeLine(
			assistantMsg(
				"Context Guardian — ~35.1% used\n\nReply with 1, 2, 3, 4, or 0.",
			),
		);
		writeLine(userMsg("2"));
		writeLine(userMsg("next real message"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("**User:** implement feature"));
		assert.ok(!result.includes("**User:** 2")); // menu reply filtered
		assert.ok(result.includes("**User:** next real message"));
	});

	it("filters cancel reply after CG menu", () => {
		writeLine(
			assistantMsg(
				"Context Guardian — ~40.0% used\n\nReply with 1, 2, 3, 4, or 0.",
			),
		);
		writeLine(userMsg("cancel"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("**User:** cancel"));
	});

	it("does NOT filter digits when not preceded by CG menu", () => {
		writeLine(userMsg("which option?"));
		writeLine(assistantMsg("Pick 1, 2, or 3."));
		writeLine(userMsg("2"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("**User:** 2")); // not filtered — assistant wasn't CG menu
	});

	it("does NOT filter digit 5 even after CG menu", () => {
		writeLine(
			assistantMsg(
				"Context Guardian — ~50% used\n\nReply with 1, 2, 3, 4, or 0.",
			),
		);
		writeLine(userMsg("5"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("**User:** 5")); // only 0-4 are filtered
	});

	// --- Skill injection filtering ---
	it("filters long messages starting with heading and having sub-headings", () => {
		const skillContent =
			"# Some Skill Title\n\nInstructions here.\n\n## Step 1\n\nDo this.\n\n## Step 2\n\nDo that.\n\n" +
			"x".repeat(800);
		writeLine(userMsg(skillContent));
		writeLine(userMsg("real message"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("Some Skill Title"));
		assert.ok(result.includes("**User:** real message"));
	});

	it("does NOT filter short messages starting with heading", () => {
		writeLine(userMsg("# My Plan\n\nDo the thing."));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("# My Plan"));
	});

	it("does NOT filter long messages without sub-headings", () => {
		const longMsg =
			"# Title\n\n" + "Some long content without sub headings. ".repeat(30);
		writeLine(userMsg(longMsg));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("# Title"));
	});

	// --- Parse errors ---
	it("counts and reports parse errors", () => {
		writeLine(userMsg("good message"));
		fs.appendFileSync(transcriptPath, "this is not valid json\n");
		writeLine(userMsg("another good one"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("**User:** good message"));
		assert.ok(result.includes("**User:** another good one"));
		assert.ok(
			result.includes("Warning: 1 transcript line(s) could not be parsed"),
		);
	});

	// --- System messages ignored ---
	it("ignores system and progress message types", () => {
		writeLine({ type: "system", message: { content: "system prompt" } });
		writeLine({ type: "progress", message: { content: "working..." } });
		writeLine(userMsg("hello"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("system prompt"));
		assert.ok(!result.includes("working"));
		assert.ok(result.includes("**User:** hello"));
	});

	// --- Preamble preservation ---
	it("includes compact preamble before new messages", () => {
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"[SMART COMPACT — restored checkpoint]\n\n**User:** old stuff\n\n**Assistant:** old answer",
			},
		});
		writeLine(userMsg("new question"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.startsWith("[SMART COMPACT"));
		assert.ok(result.includes("---")); // separator between preamble and new messages
		assert.ok(result.includes("**User:** new question"));
	});
});

// =========================================================================
// extractRecent
// =========================================================================
describe("extractRecent", () => {
	it("returns placeholder for missing transcript", () => {
		assert.equal(extractRecent(null, 20), "(no transcript available)");
	});

	it("extracts the last N messages", () => {
		for (let i = 0; i < 10; i++) {
			writeLine(userMsg(`message ${i}`));
			writeLine(assistantMsg(`response ${i}`));
		}

		const result = extractRecent(transcriptPath, 4);
		// Should have last 4 messages (user 8, assistant 8, user 9, assistant 9)
		assert.ok(!result.includes("message 7"));
		assert.ok(result.includes("message 8"));
		assert.ok(result.includes("response 8"));
		assert.ok(result.includes("message 9"));
		assert.ok(result.includes("response 9"));
	});

	it("filters CG menu replies", () => {
		writeLine(
			assistantMsg(
				"Context Guardian — ~35% used\n\nReply with 1, 2, 3, 4, or 0.",
			),
		);
		writeLine(userMsg("2"));
		writeLine(userMsg("real message"));

		const result = extractRecent(transcriptPath, 20);
		assert.ok(!result.includes("**User:** 2"));
		assert.ok(result.includes("**User:** real message"));
	});

	it("filters compact markers", () => {
		writeLine({
			type: "user",
			message: { role: "user", content: "[SMART COMPACT — restored]\n\nstuff" },
		});
		writeLine(userMsg("real"));

		const result = extractRecent(transcriptPath, 20);
		assert.ok(!result.includes("SMART COMPACT"));
		assert.ok(result.includes("**User:** real"));
	});

	it("returns all messages when fewer than N exist", () => {
		writeLine(userMsg("only"));
		writeLine(assistantMsg("one exchange"));

		const result = extractRecent(transcriptPath, 20);
		assert.ok(result.includes("**User:** only"));
		assert.ok(result.includes("**Assistant:** one exchange"));
	});

	it("handles empty transcript", () => {
		fs.writeFileSync(transcriptPath, "");
		const result = extractRecent(transcriptPath, 20);
		assert.equal(result, "");
	});
});

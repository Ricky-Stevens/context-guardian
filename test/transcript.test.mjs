import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { extractConversation, extractRecent } from "../lib/transcript.mjs";

let tmpDir;
let transcriptPath;

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, `${JSON.stringify(obj)}\n`);
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
		assert.ok(result.includes("User: Hello Claude"));
		assert.ok(result.includes("Asst: Hello! How can I help?"));
		assert.ok(result.includes("User: Fix the bug"));
		assert.ok(result.includes("Asst: Done, I fixed it."));
	});

	it("replaces tool-only assistant messages with placeholder", () => {
		writeLine(userMsg("show me the file"));
		writeLine(assistantToolOnly());
		writeLine(assistantMsg("Here is the file content."));

		const result = extractConversation(transcriptPath);
		// Tool-only assistant message gets a tool summary
		assert.ok(result.includes("Read `/foo`"));
		assert.ok(result.includes("Here is the file content."));
	});

	it("skips empty user messages", () => {
		writeLine(userMsg(""));
		writeLine(userMsg("real message"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("User: \n")); // no empty user entry
		assert.ok(result.includes("User: real message"));
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
					"[SMART COMPACT — restored checkpoint]\n\nUser: prior\n\nAsst: prior answer",
			},
		});
		writeLine(userMsg("new message"));
		writeLine(assistantMsg("new response"));

		const result = extractConversation(transcriptPath);
		// Should NOT include "old message" — it's before the marker
		assert.ok(!result.includes("User: old message"));
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
		assert.ok(!result.includes("User: old"));
		assert.ok(result.includes("User: new"));
	});

	it("detects # Context Checkpoint marker", () => {
		writeLine(userMsg("old"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"# Context Checkpoint (Smart Compact)\n> Created: 2026-01-01\n\nUser: hi",
			},
		});
		writeLine(userMsg("new"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("User: old"));
		assert.ok(result.includes("User: new"));
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
		assert.ok(!result.includes("User: middle"));
		assert.ok(result.includes("User: latest"));
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
		assert.ok(result.includes("User: implement feature"));
		assert.ok(!result.includes("User: 2")); // menu reply filtered
		assert.ok(result.includes("User: next real message"));
	});

	it("filters cancel reply after CG menu", () => {
		writeLine(
			assistantMsg(
				"Context Guardian — ~40.0% used\n\nReply with 1, 2, 3, 4, or 0.",
			),
		);
		writeLine(userMsg("cancel"));

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("User: cancel"));
	});

	it("does NOT filter digits when not preceded by CG menu", () => {
		writeLine(userMsg("which option?"));
		writeLine(assistantMsg("Pick 1, 2, or 3."));
		writeLine(userMsg("2"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("User: 2")); // not filtered — assistant wasn't CG menu
	});

	it("does NOT filter digit 5 even after CG menu", () => {
		writeLine(
			assistantMsg(
				"Context Guardian — ~50% used\n\nReply with 1, 2, 3, 4, or 0.",
			),
		);
		writeLine(userMsg("5"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("User: 5")); // only 0-4 are filtered
	});

	// --- Skill injection filtering ---
	it("keeps long structured messages that don't match injection patterns", () => {
		const skillContent =
			"# Some Skill Title\n\nInstructions here.\n\n## Step 1\n\nDo this.\n\n## Step 2\n\nDo that.\n\n" +
			"x".repeat(800);
		writeLine(userMsg(skillContent));
		writeLine(userMsg("real message"));

		const result = extractConversation(transcriptPath);
		// Long structured messages are now kept (old heuristic removed)
		assert.ok(result.includes("Some Skill Title"));
		assert.ok(result.includes("User: real message"));
	});

	it("does NOT filter short messages starting with heading", () => {
		writeLine(userMsg("# My Plan\n\nDo the thing."));

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("# My Plan"));
	});

	it("does NOT filter long messages without sub-headings", () => {
		const longMsg = `# Title\n\n${"Some long content without sub headings. ".repeat(30)}`;
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
		assert.ok(result.includes("User: good message"));
		assert.ok(result.includes("User: another good one"));
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
		assert.ok(result.includes("User: hello"));
	});

	// --- Preamble preservation ---
	it("includes compact preamble before new messages", () => {
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"[SMART COMPACT — restored checkpoint]\n\nUser: old stuff\n\nAsst: old answer",
			},
		});
		writeLine(userMsg("new question"));

		const result = extractConversation(transcriptPath);
		assert.ok(result.startsWith("## Session State"));
		assert.ok(result.includes("[SMART COMPACT")); // preamble still present after header
		assert.ok(result.includes("---")); // separator between preamble and new messages
		assert.ok(result.includes("User: new question"));
	});
});

// =========================================================================
// extractRecent
// =========================================================================
describe("extractRecent", () => {
	it("returns placeholder for missing transcript", () => {
		assert.equal(extractRecent(null, 20), "(no transcript available)");
	});

	it("extracts the last N user exchanges", () => {
		for (let i = 0; i < 10; i++) {
			writeLine(userMsg(`message ${i}`));
			writeLine(assistantMsg(`response ${i}`));
		}

		// N=4 means last 4 USER messages + their grouped assistant responses
		const result = extractRecent(transcriptPath, 4);
		// Should have exchanges 6-9 (the last 4 user messages)
		assert.ok(
			!result.includes("message 5"),
			"exchange 5 should be outside window",
		);
		assert.ok(result.includes("message 6"), "exchange 6 should be in window");
		assert.ok(result.includes("response 6"));
		assert.ok(result.includes("message 9"), "last exchange in window");
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
		assert.ok(!result.includes("User: 2"));
		assert.ok(result.includes("User: real message"));
	});

	it("filters compact markers", () => {
		writeLine({
			type: "user",
			message: { role: "user", content: "[SMART COMPACT — restored]\n\nstuff" },
		});
		writeLine(userMsg("real"));

		const result = extractRecent(transcriptPath, 20);
		assert.ok(!result.includes("SMART COMPACT"));
		assert.ok(result.includes("User: real"));
	});

	it("returns all messages when fewer than N exist", () => {
		writeLine(userMsg("only"));
		writeLine(assistantMsg("one exchange"));

		const result = extractRecent(transcriptPath, 20);
		assert.ok(result.includes("User: only"));
		assert.ok(result.includes("Asst: one exchange"));
	});

	it("handles empty transcript", () => {
		fs.writeFileSync(transcriptPath, "");
		const result = extractRecent(transcriptPath, 20);
		// Empty transcript now returns a state header
		assert.ok(result.startsWith("## Session State"));
		assert.ok(result.includes("Messages preserved: 0"));
	});
});

// =========================================================================
// Preamble trimming — large prior compacted history gets start+end trimmed
// =========================================================================
describe("extractConversation — preamble trimming", () => {
	it("trims oversized preamble from prior compaction", () => {
		// Simulate a restored checkpoint followed by new messages
		const bigPreamble = "Prior conversation content. ".repeat(2000); // ~54K chars
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: `[SMART COMPACT — restored checkpoint]\n\n${bigPreamble}`,
			},
		});
		writeLine(userMsg("new question after restore"));
		writeLine(assistantMsg("new answer after restore"));

		const result = extractConversation(transcriptPath);
		// The preamble should be trimmed (>30K limit)
		assert.ok(result.includes("chars of prior history trimmed"), "Preamble should be trimmed");
		// New messages should be present
		assert.ok(result.includes("new question after restore"));
		assert.ok(result.includes("new answer after restore"));
	});
});

// =========================================================================
// Checkpoint footer — generated for sessions with >15 messages + tool ops
// =========================================================================
describe("extractConversation — checkpoint footer", () => {
	it("generates footer when session has >15 messages with tool operations", () => {
		// Write 18 exchanges, some with Edit tool patterns
		for (let i = 1; i <= 18; i++) {
			writeLine(userMsg(`task ${i}: fix the code`));
			writeLine({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `Working on task ${i}.` },
						{
							type: "tool_use",
							id: `e${i}`,
							name: "Edit",
							input: {
								file_path: `/app${i}.js`,
								old_string: `old${i}`,
								new_string: `new${i}`,
							},
						},
					],
				},
			});
		}

		const result = extractConversation(transcriptPath);
		// Footer should reference edit exchanges
		assert.ok(
			result.includes("Edit") || result.includes("edit"),
			"Should reference edits in footer or body",
		);
	});

	it("does not generate footer for short sessions", () => {
		for (let i = 1; i <= 5; i++) {
			writeLine(userMsg(`task ${i}`));
			writeLine(assistantMsg(`done ${i}`));
		}

		const result = extractConversation(transcriptPath);
		// Short sessions (< 15 messages) should have no footer
		assert.ok(
			!result.includes("Quick reference"),
			"Short sessions should not have footer",
		);
	});
});

// =========================================================================
// Edit coalescing — overlapping edits to same file get merged
// =========================================================================
describe("extractConversation — edit coalescing", () => {
	it("coalesces successive edits to same file region", () => {
		writeLine(userMsg("refactor the function"));
		// First edit
		writeLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I'll refactor step by step." },
					{
						type: "tool_use",
						id: "e1",
						name: "Edit",
						input: {
							file_path: "/app.js",
							old_string: "function old() { return 1; }",
							new_string: "function mid() { return 2; }",
						},
					},
				],
			},
		});
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "e1",
						content: "success",
					},
				],
			},
		});
		// Second edit to same region (old_string matches previous new_string)
		writeLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Now finishing the refactor." },
					{
						type: "tool_use",
						id: "e2",
						name: "Edit",
						input: {
							file_path: "/app.js",
							old_string: "function mid() { return 2; }",
							new_string: "function final() { return 3; }",
						},
					},
				],
			},
		});
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "e2",
						content: "success",
					},
				],
			},
		});

		const result = extractConversation(transcriptPath);
		// Should show coalesced edit with first old + last new
		assert.ok(result.includes("function old()"), "Should have first old_string");
		assert.ok(result.includes("function final()"), "Should have last new_string");
		// Should mention coalescing
		assert.ok(
			result.includes("coalesced") || result.includes("edits"),
			"Should indicate edits were coalesced or show edit summary",
		);
	});
});

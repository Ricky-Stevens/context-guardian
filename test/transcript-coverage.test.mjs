import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	applyTiers,
	coalesceEdits,
	readTranscriptLines,
} from "../lib/transcript.mjs";

// ---------------------------------------------------------------------------
// readTranscriptLines
// ---------------------------------------------------------------------------

describe("readTranscriptLines", () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-rtl-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads a small JSONL file completely", () => {
		const filePath = path.join(tmpDir, "small.jsonl");
		const lines = [
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "hello" },
			}),
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			}),
		];
		fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

		const result = readTranscriptLines(filePath);
		assert.equal(result.length, 2);
		// Verify they are valid JSON
		const parsed0 = JSON.parse(result[0]);
		assert.equal(parsed0.type, "user");
		const parsed1 = JSON.parse(result[1]);
		assert.equal(parsed1.type, "assistant");
	});

	it("returns empty array for empty file", () => {
		const filePath = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(filePath, "");

		const result = readTranscriptLines(filePath);
		assert.deepEqual(result, []);
	});

	it("filters out empty lines", () => {
		const filePath = path.join(tmpDir, "gaps.jsonl");
		const line1 = JSON.stringify({
			type: "user",
			message: { role: "user", content: "a" },
		});
		const line2 = JSON.stringify({
			type: "user",
			message: { role: "user", content: "b" },
		});
		// Write with extra blank lines
		fs.writeFileSync(filePath, `${line1}\n\n\n${line2}\n\n`);

		const result = readTranscriptLines(filePath);
		assert.equal(result.length, 2);
	});
});

// ---------------------------------------------------------------------------
// Helpers: build exchange messages for applyTiers tests
// ---------------------------------------------------------------------------

/**
 * Build an array of message strings representing N user exchanges.
 * Each exchange has one **User:** message and one **Assistant:** message.
 */
function buildExchanges(n, opts = {}) {
	const messages = [];
	for (let i = 0; i < n; i++) {
		messages.push(`**User:** Question ${i + 1}`);
		const assistantText = opts.assistantTextFn
			? opts.assistantTextFn(i)
			: `Answer ${i + 1}`;
		messages.push(`**Assistant:** ${assistantText}`);
		// Optionally add a tool result after the assistant message
		if (opts.toolResultFn) {
			const result = opts.toolResultFn(i);
			if (result) messages.push(result);
		}
	}
	return messages;
}

// ---------------------------------------------------------------------------
// applyTiers
// ---------------------------------------------------------------------------

describe("applyTiers", () => {
	it("returns unchanged for <= 20 exchanges", () => {
		const messages = buildExchanges(20);
		const result = applyTiers(messages);
		assert.deepEqual(result, messages);
	});

	it("returns unchanged for exactly 20 exchanges", () => {
		const messages = buildExchanges(20);
		const original = [...messages];
		const result = applyTiers(messages);
		assert.deepEqual(result, original);
	});

	it("compresses cold-tier assistant text (> 500 chars trimmed)", () => {
		// 25 exchanges: exchanges 1-5 are cold (25 - 5 = 20, fromEnd > 20)
		const longText = "A".repeat(1000);
		const messages = buildExchanges(25, {
			assistantTextFn: (i) => (i < 5 ? longText : `Short answer ${i}`),
		});

		const result = applyTiers(messages);

		// Cold-tier assistant messages (first 5 exchanges) should be trimmed
		// Exchange 0 assistant is at index 1
		for (let i = 0; i < 5; i++) {
			const assistantIdx = i * 2 + 1;
			assert.ok(
				result[assistantIdx].length < messages[assistantIdx].length,
				`Cold-tier assistant at exchange ${i} should be compressed`,
			);
			assert.ok(
				result[assistantIdx].includes("trimmed from middle"),
				`Cold-tier assistant at exchange ${i} should contain trim marker`,
			);
		}
	});

	it("compresses cold-tier tool results (> 200 chars trimmed)", () => {
		const longResult = `${"R".repeat(500)}`;
		const messages = buildExchanges(25, {
			toolResultFn: (i) => (i < 3 ? `\u2190 ${longResult}` : null),
		});

		const result = applyTiers(messages);

		// Cold-tier tool results (exchanges 0-2) should be trimmed
		// Exchange 0: user(0), assistant(1), tool(2)
		// Exchange 1: user(3), assistant(4), tool(5)
		// Exchange 2: user(6), assistant(7), tool(8)
		for (let e = 0; e < 3; e++) {
			const toolIdx = e * 3 + 2;
			assert.ok(
				result[toolIdx].length < messages[toolIdx].length,
				`Cold-tier tool result at exchange ${e} should be compressed`,
			);
			assert.ok(
				result[toolIdx].includes("trimmed from middle"),
				`Cold-tier tool result at exchange ${e} should contain trim marker`,
			);
		}
	});

	it("never compresses user messages even in cold tier", () => {
		const longUserText = "U".repeat(2000);
		const messages = [];
		for (let i = 0; i < 25; i++) {
			messages.push(`**User:** ${i < 5 ? longUserText : `Q${i}`}`);
			messages.push(`**Assistant:** A${i}`);
		}

		const result = applyTiers(messages);

		// Cold-tier user messages (first 5) should be untouched
		for (let i = 0; i < 5; i++) {
			assert.equal(
				result[i * 2],
				messages[i * 2],
				`User message at exchange ${i} should never be compressed`,
			);
		}
	});

	it("preserves hot-tier messages (last 5) untouched", () => {
		const longText = "X".repeat(1000);
		const messages = buildExchanges(25, {
			assistantTextFn: () => longText,
		});

		const result = applyTiers(messages);

		// Hot tier = last 5 exchanges = exchanges 20-24 (indices 40-49)
		for (let e = 20; e < 25; e++) {
			const assistantIdx = e * 2 + 1;
			assert.equal(
				result[assistantIdx],
				messages[assistantIdx],
				`Hot-tier assistant at exchange ${e} should be untouched`,
			);
		}
	});

	it("preserves edit diffs in cold tier assistant messages", () => {
		const editBlock = [
			"I will update the file.",
			"\u2192 Edit `src/app.js`:",
			"      old: |",
			"        const x = 1",
			"      new: |",
			"        const x = 2",
		].join("\n");

		const messages = buildExchanges(25, {
			assistantTextFn: (i) => (i < 3 ? editBlock : `Short ${i}`),
		});

		const result = applyTiers(messages);

		// Cold-tier assistant messages with edit diffs should preserve the old:|new: patterns
		for (let i = 0; i < 3; i++) {
			const assistantIdx = i * 2 + 1;
			assert.ok(
				result[assistantIdx].includes("old: |"),
				`Edit diff old: should be preserved in cold tier exchange ${i}`,
			);
			assert.ok(
				result[assistantIdx].includes("new: |"),
				`Edit diff new: should be preserved in cold tier exchange ${i}`,
			);
		}
	});

	it("preserves errors in cold tier results", () => {
		// Error responses contain "Error" or "error" typically
		const messages = buildExchanges(25, {
			toolResultFn: (i) =>
				i < 3 ? `\u2190 Error: ${"E".repeat(500)} something failed` : null,
		});

		const result = applyTiers(messages);

		// Error results in cold tier should be preserved (isErrorResponse check)
		for (let e = 0; e < 3; e++) {
			const toolIdx = e * 3 + 2;
			assert.equal(
				result[toolIdx],
				messages[toolIdx],
				`Error result at exchange ${e} should be preserved in cold tier`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// coalesceEdits
// ---------------------------------------------------------------------------

describe("coalesceEdits", () => {
	it("coalesces two consecutive edits to same file", () => {
		const messages = [
			"**User:** Update the config",
			[
				"**Assistant:** I'll update it in two steps.",
				"\u2192 Edit `config.js`:",
				"      old: |",
				"        const x = 1",
				"      new: |",
				"        const x = 2",
				"\u2192 Edit `config.js`:",
				"      old: |",
				"        const x = 2",
				"      new: |",
				"        const x = 3",
			].join("\n"),
		];

		const result = coalesceEdits(messages);

		assert.equal(result.length, 2);
		// The coalesced edit should have first old (const x = 1) and last new (const x = 3)
		assert.ok(
			result[1].includes("const x = 1"),
			"Should contain first edit's old_string",
		);
		assert.ok(
			result[1].includes("const x = 3"),
			"Should contain last edit's new_string",
		);
		assert.ok(
			result[1].includes("2 edits coalesced"),
			"Should show coalesced count",
		);
		// The intermediate value should not be the old_string
		assert.ok(
			!result[1].includes("old: |\n        const x = 2"),
			"Intermediate old_string should be removed",
		);
	});

	it("keeps edits to different files independent", () => {
		const messages = [
			"**User:** Update both files",
			[
				"**Assistant:** Updating.",
				"\u2192 Edit `a.js`:",
				"      old: |",
				"        const a = 1",
				"      new: |",
				"        const a = 2",
				"\u2192 Edit `b.js`:",
				"      old: |",
				"        const b = 1",
				"      new: |",
				"        const b = 2",
			].join("\n"),
		];

		const result = coalesceEdits(messages);

		assert.equal(result.length, 2);
		// Both edits should remain since they're to different files
		assert.ok(result[1].includes("a.js"), "Should keep edit to a.js");
		assert.ok(result[1].includes("b.js"), "Should keep edit to b.js");
		assert.ok(
			!result[1].includes("coalesced"),
			"Should not coalesce different-file edits",
		);
	});

	it("returns messages unchanged when no consecutive same-file edits", () => {
		const messages = [
			"**User:** Do something",
			"**Assistant:** Here is my reasoning about the change.",
			"**User:** And another thing",
			"**Assistant:** Sure, done.",
		];

		const result = coalesceEdits(messages);
		assert.deepEqual(result, messages);
	});

	it("handles a single edit (no coalescing needed)", () => {
		const messages = [
			"**User:** Fix the bug",
			[
				"**Assistant:** Fixed it.",
				"\u2192 Edit `bug.js`:",
				"      old: |",
				"        return null",
				"      new: |",
				"        return value",
			].join("\n"),
		];

		const result = coalesceEdits(messages);

		assert.equal(result.length, 2);
		assert.ok(result[1].includes("return null"), "old_string preserved");
		assert.ok(result[1].includes("return value"), "new_string preserved");
		assert.ok(
			!result[1].includes("coalesced"),
			"Single edit should not show coalesced marker",
		);
	});
});

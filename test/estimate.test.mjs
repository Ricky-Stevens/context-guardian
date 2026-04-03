import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { estimateSavings } from "../lib/estimate.mjs";

let tmpDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-estimate-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a JSONL transcript file from an array of objects. */
function writeTranscript(name, lines) {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return p;
}

// ---------------------------------------------------------------------------
// Helpers for building transcript lines
// ---------------------------------------------------------------------------

function userText(text) {
	return { type: "user", message: { role: "user", content: text } };
}

function userBlocks(blocks) {
	return { type: "user", message: { role: "user", content: blocks } };
}

function assistantText(text) {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	};
}

function systemMsg(text) {
	return { type: "system", message: { content: text } };
}

function progressMsg(text) {
	return { type: "progress", message: { content: text } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("estimateSavings", () => {
	it("returns zeros when transcriptPath is null", () => {
		const result = estimateSavings(null, 50000, 200000);
		assert.deepStrictEqual(result, { smartPct: 0, recentPct: 0 });
	});

	it("returns zeros when transcriptPath does not exist", () => {
		const result = estimateSavings("/nonexistent/path.jsonl", 50000, 200000);
		assert.deepStrictEqual(result, { smartPct: 0, recentPct: 0 });
	});

	it("returns zeros when transcript is empty", () => {
		const p = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(p, "");
		const result = estimateSavings(p, 50000, 200000);
		assert.deepStrictEqual(result, { smartPct: 0, recentPct: 0 });
	});

	it("system/progress messages are all removable — estimates lower than raw percentage", () => {
		const p = writeTranscript("sys-progress.jsonl", [
			systemMsg("System prompt content here with some length to it"),
			progressMsg("Loading tools..."),
			systemMsg("Another system message with extra content padding"),
			progressMsg("Still loading more tools and resources..."),
		]);

		const rawPct = (50000 / 200000) * 100; // 25%
		const result = estimateSavings(p, 50000, 200000);
		assert.ok(result.smartPct <= rawPct);
		assert.ok(result.recentPct <= rawPct);
		assert.equal(result.smartPct, result.recentPct);
	});

	it("user text + assistant text — both kept, estimates reflect kept content", () => {
		const p = writeTranscript("text-only.jsonl", [
			userText("Please help me refactor the auth module"),
			assistantText(
				"I will refactor the auth module by extracting the token validation into a separate function.",
			),
		]);

		const result = estimateSavings(p, 50000, 200000);
		assert.ok(result.smartPct > 10);
		assert.ok(result.recentPct > 0);
	});

	it("large tool_result content is mostly removed — low estimate", () => {
		const bigContent = "x".repeat(50000);
		const p = writeTranscript("tool-result.jsonl", [
			userText("Read the config file"),
			assistantText("I will read the config file for you."),
			userBlocks([
				{ type: "text", text: "Here is the result" },
				{
					type: "tool_result",
					tool_use_id: "toolu_123",
					content: bigContent,
				},
			]),
		]);

		const rawPct = (80000 / 200000) * 100; // 40%
		const result = estimateSavings(p, 80000, 200000);
		assert.ok(result.smartPct < rawPct);
	});

	it("baselineOverhead parameter affects the result", () => {
		const bigContent = "y".repeat(20000);
		const p = writeTranscript("overhead.jsonl", [
			userText("Analyse the file"),
			assistantText("I will read and analyse the file."),
			userBlocks([
				{ type: "text", text: "Result" },
				{
					type: "tool_result",
					tool_use_id: "toolu_oh1",
					content: bigContent,
				},
			]),
			assistantText("The file looks good."),
		]);

		const withoutOverhead = estimateSavings(p, 80000, 200000, 0);
		const withOverhead = estimateSavings(p, 80000, 200000, 40000);
		assert.notEqual(withoutOverhead.smartPct, withOverhead.smartPct);
	});

	it("returns zeros when maxTokens is zero or NaN", () => {
		const p = writeTranscript("zero-max.jsonl", [
			userText("hello"),
			assistantText("hi"),
		]);
		assert.deepStrictEqual(estimateSavings(p, 1000, 0), { smartPct: 0, recentPct: 0 });
		assert.deepStrictEqual(estimateSavings(p, 1000, NaN), { smartPct: 0, recentPct: 0 });
		assert.deepStrictEqual(estimateSavings(p, 1000, -100), { smartPct: 0, recentPct: 0 });
	});

	it("thinking blocks are categorised as removable", () => {
		const p = writeTranscript("thinking.jsonl", [
			userText("solve this problem"),
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Let me think about this carefully... ".repeat(100),
						},
						{ type: "text", text: "The answer is 42." },
					],
				},
			},
		]);

		const rawPct = (50000 / 200000) * 100;
		const result = estimateSavings(p, 50000, 200000);
		assert.ok(result.smartPct < rawPct);
	});

	it("tool_use blocks are partially kept (summary ratio)", () => {
		const p = writeTranscript("tool-use.jsonl", [
			userText("read the file"),
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Read",
							input: { file_path: "/some/very/long/path/to/file.js" },
						},
						{ type: "text", text: "Here is the file content." },
					],
				},
			},
		]);

		const result = estimateSavings(p, 50000, 200000);
		assert.ok(result.smartPct > 0);
	});

	it("assistant string content (non-array) is categorised as kept", () => {
		const p = writeTranscript("string-content.jsonl", [
			userText("hello"),
			{
				type: "assistant",
				message: { role: "assistant", content: "Simple string response" },
			},
		]);

		const result = estimateSavings(p, 50000, 200000);
		assert.ok(result.smartPct > 0);
	});

	it("redacted_thinking blocks are categorised as removable", () => {
		const p = writeTranscript("redacted.jsonl", [
			userText("think about this"),
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "redacted_thinking" },
						{ type: "text", text: "Done thinking." },
					],
				},
			},
		]);

		const result = estimateSavings(p, 50000, 200000);
		assert.ok(result.smartPct > 0);
	});

	it("userExchanges counting — 20 exchanges makes recentPct less than smartPct", () => {
		const padding = "A".repeat(5000);
		const lines = [];
		for (let i = 0; i < 20; i++) {
			lines.push(userText(`User message ${i + 1}: ${padding}`));
			lines.push(assistantText(`Response ${i + 1}: ${padding}`));
		}
		const p = writeTranscript("twenty-exchanges.jsonl", lines);

		const result = estimateSavings(p, 60000, 200000);
		assert.ok(result.smartPct > 0);
		assert.ok(result.recentPct > 0);
		assert.ok(result.recentPct < result.smartPct);

		const ratio = result.recentPct / result.smartPct;
		assert.ok(ratio < 0.85);
		assert.ok(ratio > 0.4);
	});
});

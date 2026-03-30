import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateSavings } from "../lib/estimate.mjs";

let tmpDir;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-estimate-test-"));
});

afterAll(() => {
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
	test("returns zeros when transcriptPath is null", () => {
		const result = estimateSavings(null, 50000, 200000);
		expect(result).toEqual({ smartPct: 0, recentPct: 0 });
	});

	test("returns zeros when transcriptPath does not exist", () => {
		const result = estimateSavings("/nonexistent/path.jsonl", 50000, 200000);
		expect(result).toEqual({ smartPct: 0, recentPct: 0 });
	});

	test("returns zeros when transcript is empty", () => {
		const p = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(p, "");
		const result = estimateSavings(p, 50000, 200000);
		expect(result).toEqual({ smartPct: 0, recentPct: 0 });
	});

	test("system/progress messages are all removable — estimates lower than raw percentage", () => {
		const p = writeTranscript("sys-progress.jsonl", [
			systemMsg("System prompt content here with some length to it"),
			progressMsg("Loading tools..."),
			systemMsg("Another system message with extra content padding"),
			progressMsg("Still loading more tools and resources..."),
		]);

		// All transcript bytes are removable (system/progress).
		// smartKeepRatio = 0, so only overhead tokens survive.
		// The estimate should be less than the raw percentage (25%).
		const rawPct = (50000 / 200000) * 100; // 25%
		const result = estimateSavings(p, 50000, 200000);
		// Overhead alone is kept, so smartPct should be <= rawPct
		// (it equals rawPct only when overhead == currentTokens, which is the
		// edge case here since the transcript is tiny and overhead is clamped
		// to MIN_OVERHEAD=15000).
		expect(result.smartPct).toBeLessThanOrEqual(rawPct);
		expect(result.recentPct).toBeLessThanOrEqual(rawPct);
		// Both should be equal since there are no user exchanges
		expect(result.smartPct).toBe(result.recentPct);
	});

	test("user text + assistant text — both kept, estimates reflect kept content", () => {
		const p = writeTranscript("text-only.jsonl", [
			userText("Please help me refactor the auth module"),
			assistantText(
				"I will refactor the auth module by extracting the token validation into a separate function.",
			),
		]);

		// All bytes are keepBytes, so smartKeepRatio ~ 1.0
		// Estimates should be close to (currentTokens / maxTokens) * 100
		const currentTokens = 50000;
		const maxTokens = 200000;
		const result = estimateSavings(p, currentTokens, maxTokens);

		// With everything kept, smartPct should be substantial (close to raw pct)
		expect(result.smartPct).toBeGreaterThan(10);
		expect(result.recentPct).toBeGreaterThan(0);
	});

	test("large tool_result content is mostly removed — low estimate", () => {
		// Create a large Read result (simulating a file read)
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

		// The big tool_result should be 90% removed.
		// With a large removable chunk, smartPct should be much lower than raw pct.
		const rawPct = (80000 / 200000) * 100; // 40%
		const result = estimateSavings(p, 80000, 200000);
		expect(result.smartPct).toBeLessThan(rawPct);
	});

	test("baselineOverhead parameter affects the result", () => {
		// Need a mix of keep and remove bytes so that the overhead split matters.
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

		// A higher baselineOverhead means more tokens are attributed to
		// non-compactable overhead, leaving fewer conversation tokens to
		// be reduced by the keepRatio. The two estimates should differ.
		expect(withoutOverhead.smartPct).not.toBe(withOverhead.smartPct);
	});

	test("returns zeros when maxTokens is zero or NaN", () => {
		const p = writeTranscript("zero-max.jsonl", [
			userText("hello"),
			assistantText("hi"),
		]);
		expect(estimateSavings(p, 1000, 0)).toEqual({ smartPct: 0, recentPct: 0 });
		expect(estimateSavings(p, 1000, NaN)).toEqual({
			smartPct: 0,
			recentPct: 0,
		});
		expect(estimateSavings(p, 1000, -100)).toEqual({
			smartPct: 0,
			recentPct: 0,
		});
	});

	test("thinking blocks are categorised as removable", () => {
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

		const result = estimateSavings(p, 50000, 200000);
		// Thinking is removed, text is kept — smartPct should be less than raw
		const rawPct = (50000 / 200000) * 100;
		expect(result.smartPct).toBeLessThan(rawPct);
	});

	test("tool_use blocks are partially kept (summary ratio)", () => {
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
		// Should produce non-zero estimates
		expect(result.smartPct).toBeGreaterThan(0);
	});

	test("assistant string content (non-array) is categorised as kept", () => {
		const p = writeTranscript("string-content.jsonl", [
			userText("hello"),
			{
				type: "assistant",
				message: { role: "assistant", content: "Simple string response" },
			},
		]);

		const result = estimateSavings(p, 50000, 200000);
		expect(result.smartPct).toBeGreaterThan(0);
	});

	test("redacted_thinking blocks are categorised as removable", () => {
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
		expect(result.smartPct).toBeGreaterThan(0);
	});

	test("userExchanges counting — 20 exchanges makes recentPct less than smartPct", () => {
		// Build 20 user exchanges with large messages so that the transcript
		// byte count (and thus estimated conversation tokens) is large relative
		// to currentTokens. This ensures overhead is small and the 10/20
		// windowing ratio is visible in the output.
		const padding = "A".repeat(5000);
		const lines = [];
		for (let i = 0; i < 20; i++) {
			lines.push(userText(`User message ${i + 1}: ${padding}`));
			lines.push(assistantText(`Response ${i + 1}: ${padding}`));
		}
		const p = writeTranscript("twenty-exchanges.jsonl", lines);

		// Set currentTokens to match roughly what the transcript would produce
		// so that overhead is small. Transcript ~200KB => ~50K tokens.
		const result = estimateSavings(p, 60000, 200000);

		expect(result.smartPct).toBeGreaterThan(0);
		expect(result.recentPct).toBeGreaterThan(0);
		expect(result.recentPct).toBeLessThan(result.smartPct);

		// The ratio should be roughly 0.5 (10/20 exchanges) plus a small
		// overhead contribution. With overhead ~15K and conversation ~45K,
		// ratio ~ (45K * 0.5 + 15K) / (45K + 15K) ~ 0.625
		const ratio = result.recentPct / result.smartPct;
		expect(ratio).toBeLessThan(0.85);
		expect(ratio).toBeGreaterThan(0.4);
	});
});

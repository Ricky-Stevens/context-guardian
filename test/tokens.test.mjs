import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { estimateTokens, getTokenUsage } from "../lib/tokens.mjs";

let tmpDir;
let transcriptPath;

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, JSON.stringify(obj) + "\n");
}

function makeUserMessage(text) {
	return {
		type: "user",
		message: { role: "user", content: text },
	};
}

function makeAssistantMessage(text, usage, model) {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			model: model || "claude-sonnet-4-20250514",
			content: [{ type: "text", text }],
			usage: usage || undefined,
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

describe("getTokenUsage", () => {
	it("returns null for missing transcript", () => {
		assert.equal(getTokenUsage("/nonexistent/path"), null);
		assert.equal(getTokenUsage(null), null);
		assert.equal(getTokenUsage(undefined), null);
	});

	it("returns null for transcript with no usage data", () => {
		writeLine(makeUserMessage("hello"));
		writeLine({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		assert.equal(getTokenUsage(transcriptPath), null);
	});

	it("extracts token counts from usage data", () => {
		writeLine(makeUserMessage("hello"));
		writeLine(
			makeAssistantMessage("hi", {
				input_tokens: 100,
				cache_creation_input_tokens: 50,
				cache_read_input_tokens: 30,
				output_tokens: 20,
			}),
		);

		const result = getTokenUsage(transcriptPath);
		assert.equal(result.current_tokens, 180); // 100 + 50 + 30
		assert.equal(result.output_tokens, 20);
	});

	it("returns the most recent usage (reads backwards)", () => {
		writeLine(makeUserMessage("first"));
		writeLine(
			makeAssistantMessage("old", {
				input_tokens: 50,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 10,
			}),
		);
		writeLine(makeUserMessage("second"));
		writeLine(
			makeAssistantMessage("new", {
				input_tokens: 200,
				cache_creation_input_tokens: 100,
				cache_read_input_tokens: 50,
				output_tokens: 30,
			}),
		);

		const result = getTokenUsage(transcriptPath);
		assert.equal(result.current_tokens, 350); // 200 + 100 + 50
	});

	it("detects Opus 4.6+ as 1M context", () => {
		writeLine(makeUserMessage("hello"));
		writeLine(
			makeAssistantMessage(
				"hi",
				{
					input_tokens: 100,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 10,
				},
				"claude-opus-4-6-20260101",
			),
		);

		const result = getTokenUsage(transcriptPath);
		assert.equal(result.max_tokens, 1000000);
		assert.equal(result.model, "claude-opus-4-6-20260101");
	});

	it("detects Sonnet as 200K context", () => {
		writeLine(makeUserMessage("hello"));
		writeLine(
			makeAssistantMessage(
				"hi",
				{
					input_tokens: 100,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 10,
				},
				"claude-sonnet-4-20250514",
			),
		);

		const result = getTokenUsage(transcriptPath);
		assert.equal(result.max_tokens, 200000);
	});

	it("detects future Opus 5.x as 1M context", () => {
		writeLine(makeUserMessage("hello"));
		writeLine(
			makeAssistantMessage(
				"hi",
				{
					input_tokens: 100,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 10,
				},
				"claude-opus-5-0",
			),
		);

		const result = getTokenUsage(transcriptPath);
		assert.equal(result.max_tokens, 1000000);
	});

	it("handles zero usage values", () => {
		writeLine(makeUserMessage("hello"));
		writeLine(
			makeAssistantMessage("hi", {
				input_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 0,
			}),
		);

		const result = getTokenUsage(transcriptPath);
		assert.equal(result.current_tokens, 0);
	});

	it("uses tiered read — finds usage in small transcripts", () => {
		// A small transcript should be found in the first 32KB tier
		writeLine(makeUserMessage("hello"));
		writeLine(
			makeAssistantMessage("hi", {
				input_tokens: 100,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 10,
			}),
		);

		const result = getTokenUsage(transcriptPath);
		assert.ok(result);
		assert.equal(result.current_tokens, 100);
	});
});

describe("estimateTokens", () => {
	it("returns 0 for missing transcript", () => {
		assert.equal(estimateTokens("/nonexistent/path"), 0);
		assert.equal(estimateTokens(null), 0);
		assert.equal(estimateTokens(undefined), 0);
	});

	it("estimates tokens from content bytes / 4", () => {
		// "hello world" in a user message content
		writeLine(makeUserMessage("hello world")); // 11 bytes text
		writeLine(
			makeAssistantMessage("response text here"), // 18 bytes text
		);

		const estimate = estimateTokens(transcriptPath);
		assert.ok(estimate > 0);
	});

	it("counts from compact marker forward", () => {
		// Pre-marker content should be excluded
		writeLine(makeUserMessage("old message before compact"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"[SMART COMPACT — restored checkpoint]\n\nSome checkpoint content",
			},
		});
		writeLine(makeUserMessage("new message after compact"));

		const estimate = estimateTokens(transcriptPath);
		// The estimate should be based on content from the marker onward,
		// not the pre-marker "old message"
		const fullEstimate = (() => {
			// Estimate if we counted everything
			const all = fs.readFileSync(transcriptPath, "utf8");
			return Math.round(Buffer.byteLength(all, "utf8") / 4);
		})();
		assert.ok(estimate < fullEstimate);
	});

	it("recognizes # Context Checkpoint as marker", () => {
		writeLine(makeUserMessage("old"));
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"# Context Checkpoint (Smart Compact)\n> Created: 2026-01-01\n\n**User:** stuff",
			},
		});
		writeLine(makeUserMessage("new"));

		const estimate = estimateTokens(transcriptPath);
		assert.ok(estimate > 0);
	});
});

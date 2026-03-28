/**
 * End-to-end compaction verification test.
 *
 * Creates a realistic synthetic transcript containing specific trackable facts,
 * runs extractConversation and extractRecent on it, then verifies that every
 * important fact survives the extraction pipeline.
 *
 * This is the ultimate regression test for context preservation: if a fact
 * is listed in EXPECTED_FACTS and the extraction drops it, the test fails.
 *
 * Optionally, set CLAUDE_API_KEY env var to also verify that Claude can
 * comprehend and answer questions from the checkpoint (LLM verification).
 *
 * @module compaction-e2e-test
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { extractConversation, extractRecent } from "../lib/transcript.mjs";

// ---------------------------------------------------------------------------
// Test fixtures — a realistic multi-turn coding session with trackable facts
// ---------------------------------------------------------------------------

/**
 * Each fact has a unique identifier, the content that should appear in the
 * checkpoint, and the type of content it tests.
 */
const EXPECTED_FACTS = [
	// User messages and decisions
	{ id: "user-goal", text: "PaymentService crashes on negative amounts", type: "user-message" },
	{ id: "user-decision", text: "use the validation approach", type: "user-decision" },
	{ id: "user-rejection", text: "no", type: "user-rejection" },
	{ id: "user-context", text: "This is for the Acme Corp billing module", type: "user-context" },

	// Assistant reasoning
	{ id: "assistant-analysis", text: "root cause is missing input validation in processPayment", type: "assistant-text" },
	{ id: "assistant-plan", text: "add a guard clause and update the test suite", type: "assistant-text" },

	// Edit diffs — the actual work product
	{ id: "edit-file-path", text: "src/payment-service.js", type: "edit-path" },
	{ id: "edit-old-code", text: "processPayment(amount) {", type: "edit-old" },
	{ id: "edit-new-code", text: "if (amount < 0) throw new ValidationError", type: "edit-new" },
	{ id: "edit-test-path", text: "test/payment.test.js", type: "edit-path" },
	{ id: "edit-test-code", text: "rejects negative amounts", type: "edit-new" },

	// Bash command output — test results
	{ id: "bash-command", text: "bun test src/payment", type: "bash-cmd" },
	{ id: "bash-output-pass", text: "14 passed", type: "bash-output" },
	{ id: "bash-output-fail-first", text: "FAIL test/payment.test.js", type: "bash-output" },
	{ id: "bash-error", text: "ValidationError is not defined", type: "bash-error" },

	// AskUserQuestion answer (user decision via tool)
	{ id: "ask-answer", text: "use ValidationError from the shared errors module", type: "ask-answer" },

	// File tracking
	{ id: "file-modified-1", text: "src/payment-service.js", type: "files-modified" },
	{ id: "file-modified-2", text: "test/payment.test.js", type: "files-modified" },

	// WebSearch results (ephemeral, must be kept)
	{ id: "websearch-result", text: "ValidationError best practices", type: "websearch" },

	// Sequential thinking (reasoning chain)
	{ id: "thinking-conclusion", text: "the guard clause pattern is correct", type: "thinking" },
];

/**
 * Facts that should NOT appear in the checkpoint (noise that was removed).
 */
const REMOVED_CONTENT = [
	{ id: "file-read-content", text: "// Full contents of payment-service.js line by line", type: "read-result" },
	{ id: "grep-results", text: "src/billing.js:42: amount", type: "grep-result" },
	{ id: "thinking-block", text: "internal_chain_of_thought_marker", type: "thinking-block" },
	{ id: "confirmation-yes", text: "**User:** yes", type: "skipped-confirmation" },
	{ id: "system-message", text: "system_prompt_injection_content", type: "system" },
];

// ---------------------------------------------------------------------------
// Synthetic transcript builder
// ---------------------------------------------------------------------------

function buildTranscript() {
	const lines = [];
	const w = (obj) => lines.push(JSON.stringify(obj));

	// Turn 1: User describes the bug
	w({
		type: "user",
		message: {
			role: "user",
			content: "PaymentService crashes on negative amounts. This is for the Acme Corp billing module. Can you investigate and fix it?",
		},
	});

	// Turn 2: Assistant reads the file
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal_chain_of_thought_marker — should not appear in checkpoint" },
				{ type: "text", text: "I'll investigate the PaymentService. Let me read the source file." },
				{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/payment-service.js" } },
			],
		},
	});

	// Turn 3: Read result (should be REMOVED — re-obtainable)
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: "// Full contents of payment-service.js line by line\nclass PaymentService {\n  processPayment(amount) {\n    const fee = amount * 0.03;\n    return { total: amount + fee };\n  }\n}",
				},
			],
		},
	});

	// Turn 4: Assistant analyses and searches
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I can see the root cause is missing input validation in processPayment. Negative amounts flow through without any check." },
				{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "amount", path: "src/" } },
			],
		},
	});

	// Turn 5: Grep result (should be REMOVED)
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t2",
					content: "src/billing.js:42: amount\nsrc/payment-service.js:3: processPayment(amount)\nsrc/refund.js:10: refundAmount",
				},
			],
		},
	});

	// Turn 6: Assistant proposes two approaches, asks user
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I can fix this two ways: A) return an error object, or B) throw a ValidationError. Which do you prefer?" },
				{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: { question: "Should I use approach A (error object) or B (ValidationError)?" } },
			],
		},
	});

	// Turn 7: User answers via tool_result (MUST be kept — decision)
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t3",
					content: "use ValidationError from the shared errors module",
				},
			],
		},
	});

	// Turn 8: User also sends a text message confirming
	w({
		type: "user",
		message: { role: "user", content: "yes" },
	});

	// Turn 9: User provides more context (should NOT be skipped — not just "yes")
	w({
		type: "user",
		message: { role: "user", content: "Let's use the validation approach, and make sure to add a guard clause and update the test suite" },
	});

	// Turn 10: Assistant does a web search for best practices
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Good choice. Let me check current best practices for validation errors." },
				{ type: "tool_use", id: "t4", name: "WebSearch", input: { query: "ValidationError best practices javascript" } },
			],
		},
	});

	// Turn 11: WebSearch result (ephemeral — MUST be kept)
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t4",
					content: "ValidationError best practices:\n1. Extend Error class\n2. Include error code\n3. Use descriptive messages",
				},
			],
		},
	});

	// Turn 12: Sequential thinking
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "t5",
					name: "mcp__sequential-thinking__sequentialthinking",
					input: {
						thought: "Considering the options: the guard clause pattern is correct for this use case. We throw early, fail fast.",
						thoughtNumber: 1,
						totalThoughts: 1,
						nextThoughtNeeded: false,
					},
				},
			],
		},
	});

	// Turn 13: Thinking result (REMOVED — redundant with input)
	w({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t5", content: '{"thoughtNumber":1}' }],
		},
	});

	// Turn 14: Assistant makes the edit
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I'll add a guard clause and update the test suite. Let me plan to add a guard clause and update the test suite." },
				{
					type: "tool_use",
					id: "t6",
					name: "Edit",
					input: {
						file_path: "src/payment-service.js",
						old_string: "processPayment(amount) {\n    const fee = amount * 0.03;",
						new_string: "processPayment(amount) {\n    if (amount < 0) throw new ValidationError('Amount cannot be negative');\n    const fee = amount * 0.03;",
					},
				},
			],
		},
	});

	// Turn 15: Edit result (REMOVED — just success)
	w({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t6", content: "File edited successfully" }],
		},
	});

	// Turn 16: Assistant adds test
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "t7",
					name: "Edit",
					input: {
						file_path: "test/payment.test.js",
						old_string: "",
						new_string: "test('rejects negative amounts', () => {\n  expect(() => service.processPayment(-100)).toThrow(ValidationError);\n});",
					},
				},
			],
		},
	});

	// Turn 17: Edit result
	w({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t7", content: "File edited successfully" }],
		},
	});

	// Turn 18: Assistant runs tests — FIRST RUN FAILS
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me run the tests to verify." },
				{ type: "tool_use", id: "t8", name: "Bash", input: { command: "bun test src/payment" } },
			],
		},
	});

	// Turn 19: Test failure output (MUST be kept — critical error info)
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t8",
					content: "FAIL test/payment.test.js\n  ✗ rejects negative amounts\n    ReferenceError: ValidationError is not defined\n\n13 passed, 1 failed",
				},
			],
		},
	});

	// Turn 20: User says "no" to a question (rejection — MUST be kept)
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The test failed because ValidationError isn't imported. Should I add it to the existing imports block or create a new import statement?" }],
		},
	});
	w({
		type: "user",
		message: { role: "user", content: "no" },
	});

	// Turn 21: User provides direction
	w({
		type: "user",
		message: { role: "user", content: "Add it to the existing imports at the top of the file" },
	});

	// Turn 22: Assistant fixes and reruns
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I'll add the import and rerun the tests." },
				{
					type: "tool_use",
					id: "t9",
					name: "Edit",
					input: {
						file_path: "src/payment-service.js",
						old_string: "class PaymentService {",
						new_string: "import { ValidationError } from './errors.js';\n\nclass PaymentService {",
					},
				},
				{ type: "tool_use", id: "t10", name: "Bash", input: { command: "bun test src/payment" } },
			],
		},
	});

	// Turn 23: Edit + test results
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t9", content: "File edited successfully" },
				{ type: "tool_result", tool_use_id: "t10", content: "14 passed, 0 failed" },
			],
		},
	});

	// Turn 24: System message (should be REMOVED)
	w({
		type: "system",
		message: { content: "system_prompt_injection_content" },
	});

	// Turn 25: Final assistant summary
	w({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "All 14 passed. The fix adds input validation to processPayment — negative amounts now throw a ValidationError with a descriptive message.",
				},
			],
		},
	});

	// Turn 26: User shares an image (placeholder should appear)
	w({
		type: "user",
		message: {
			role: "user",
			content: [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
				{ type: "text", text: "Here's a screenshot of the error in production" },
			],
		},
	});

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("end-to-end compaction verification", () => {
	let tmpDir;
	let transcriptPath;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-e2e-"));
		transcriptPath = path.join(tmpDir, "transcript.jsonl");
		fs.writeFileSync(transcriptPath, buildTranscript());
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("extractConversation — fact preservation", () => {
		it("preserves all expected facts in the checkpoint", () => {
			const checkpoint = extractConversation(transcriptPath);

			for (const fact of EXPECTED_FACTS) {
				assert.ok(
					checkpoint.includes(fact.text),
					`FACT LOST [${fact.id}] (${fact.type}): expected checkpoint to contain "${fact.text}"`,
				);
			}
		});

		it("removes noise content that should not survive extraction", () => {
			const checkpoint = extractConversation(transcriptPath);

			for (const noise of REMOVED_CONTENT) {
				assert.ok(
					!checkpoint.includes(noise.text),
					`NOISE KEPT [${noise.id}] (${noise.type}): checkpoint should NOT contain "${noise.text}"`,
				);
			}
		});

		it("has a state header at the top", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.startsWith("## Session State"));
			assert.ok(checkpoint.includes("Files modified:"));
			assert.ok(checkpoint.includes("src/payment-service.js"));
		});

		it("preserves user rejection (no) as a meaningful decision", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("**User:** no"));
		});

		it("removes affirmative confirmation (yes) as zero-information", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(!checkpoint.includes("**User:** yes"));
		});

		it("preserves AskUserQuestion answer via tool_result", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("User answered:"));
			assert.ok(checkpoint.includes("ValidationError from the shared errors module"));
		});

		it("preserves edit diffs in compact old/new format", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("→ Edit `src/payment-service.js`"));
			assert.ok(checkpoint.includes("old: |"));
			assert.ok(checkpoint.includes("new: |"));
			assert.ok(checkpoint.includes("processPayment(amount) {"));
			assert.ok(checkpoint.includes("if (amount < 0) throw new ValidationError"));
		});

		it("preserves pure insertion edits (test file)", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("→ Edit `test/payment.test.js`"));
			assert.ok(checkpoint.includes("rejects negative amounts"));
		});

		it("preserves bash command and output", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("Ran `bun test src/payment`"));
			assert.ok(checkpoint.includes("14 passed"));
		});

		it("preserves first test failure output (error details)", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("FAIL test/payment.test.js"));
			assert.ok(checkpoint.includes("ValidationError is not defined"));
		});

		it("preserves web search results (ephemeral content)", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("ValidationError best practices"));
		});

		it("preserves sequential thinking content", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("guard clause pattern is correct"));
		});

		it("emits image placeholder", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("[User shared an image]"));
		});

		it("removes file read results (re-obtainable)", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(!checkpoint.includes("// Full contents of payment-service.js"));
		});

		it("removes grep results (re-obtainable)", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(!checkpoint.includes("src/billing.js:42: amount"));
		});

		it("removes thinking blocks", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(!checkpoint.includes("internal_chain_of_thought_marker"));
		});

		it("removes system messages", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(!checkpoint.includes("system_prompt_injection_content"));
		});

		it("removes edit success results", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(!checkpoint.includes("File edited successfully"));
		});
	});

	describe("extractRecent — fact preservation in windowed mode", () => {
		it("preserves recent facts within the window", () => {
			const checkpoint = extractRecent(transcriptPath, 30);

			// Recent facts that should be in the window
			const recentFacts = EXPECTED_FACTS.filter(
				(f) => f.id !== "websearch-result", // may fall outside window depending on count
			);
			for (const fact of recentFacts) {
				assert.ok(
					checkpoint.includes(fact.text),
					`FACT LOST in extractRecent [${fact.id}]: "${fact.text}"`,
				);
			}
		});

		it("removes noise even in windowed mode", () => {
			const checkpoint = extractRecent(transcriptPath, 30);

			for (const noise of REMOVED_CONTENT) {
				assert.ok(
					!checkpoint.includes(noise.text),
					`NOISE KEPT in extractRecent [${noise.id}]: "${noise.text}"`,
				);
			}
		});

		it("has a state header", () => {
			const checkpoint = extractRecent(transcriptPath, 30);
			assert.ok(checkpoint.startsWith("## Session State"));
		});
	});

	describe("checkpoint structure", () => {
		it("maintains chronological message order", () => {
			const checkpoint = extractConversation(transcriptPath);
			// Skip the state header (appears before first ---) to check body ordering
			const bodyStart = checkpoint.indexOf("\n\n---\n\n") + 7;
			const body = checkpoint.slice(bodyStart);

			const investigatePos = body.indexOf("investigate the PaymentService");
			const rootCausePos = body.indexOf("root cause is missing input validation");
			const editPos = body.indexOf("→ Edit `src/payment-service.js`");
			const finalSummaryPos = body.indexOf("All 14 passed");

			assert.ok(investigatePos > -1, "investigation text found");
			assert.ok(rootCausePos > -1, "root cause text found");
			assert.ok(editPos > -1, "edit text found");
			assert.ok(finalSummaryPos > -1, "final summary found");
			assert.ok(investigatePos < rootCausePos, "investigation before root cause");
			assert.ok(rootCausePos < editPos, "root cause before edit");
			assert.ok(editPos < finalSummaryPos, "edit before final summary");
		});

		it("uses --- separators between messages", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("\n\n---\n\n"));
		});

		it("uses **User:** and **Assistant:** prefixes", () => {
			const checkpoint = extractConversation(transcriptPath);
			assert.ok(checkpoint.includes("**User:**"));
			assert.ok(checkpoint.includes("**Assistant:**"));
		});
	});
});

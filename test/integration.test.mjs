/**
 * Critical integration tests — verify actual data integrity, not just code paths.
 * These tests protect against the scenarios that would lose or corrupt user context.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { extractConversation, extractRecent } from "../lib/transcript.mjs";

const HOOK_PATH = path.resolve("hooks/submit.mjs");

let tmpDir, cwd, dataDir, flagsDir, cwdH, transcriptPath;

const HIGH_USAGE = {
	input_tokens: 5000,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
	output_tokens: 10,
};

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, JSON.stringify(obj) + "\n");
}

function makeUser(text) {
	return { type: "user", message: { role: "user", content: text } };
}

function makeAssistant(text, usage) {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-sonnet-4-20250514",
			content: [{ type: "text", text }],
			usage: usage || undefined,
		},
	};
}

function runHook(input) {
	const stdin = JSON.stringify({
		session_id: "test-session-1234",
		prompt: input.prompt ?? "",
		transcript_path: input.transcript_path ?? transcriptPath,
		cwd: input.cwd ?? cwd,
		...input,
	});
	try {
		const stdout = execFileSync("node", [HOOK_PATH], {
			input: stdin,
			encoding: "utf8",
			timeout: 5000,
			env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
		});
		return stdout ? JSON.parse(stdout) : null;
	} catch (e) {
		if (e.status === 0 && !e.stdout?.trim()) return null;
		if (e.status === 0 && e.stdout?.trim()) return JSON.parse(e.stdout);
		throw e;
	}
}

function setupMenuFlags(originalPrompt) {
	fs.writeFileSync(path.join(flagsDir, "cg-menu-test-session-1234"), "1");
	fs.writeFileSync(
		path.join(flagsDir, "cg-prompt-test-session-1234"),
		originalPrompt || "my original message",
	);
	fs.writeFileSync(
		path.join(flagsDir, "cg-warned-test-session-1234"),
		JSON.stringify({ currentTokens: 5000, maxTokens: 200000, ts: Date.now() }),
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-integ-"));
	cwd = path.join(tmpDir, "project");
	dataDir = path.join(tmpDir, "data");
	flagsDir = path.join(cwd, ".claude");
	cwdH = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	fs.mkdirSync(flagsDir, { recursive: true });
	fs.mkdirSync(dataDir, { recursive: true });
	fs.mkdirSync(path.join(dataDir, "checkpoints"), { recursive: true });
	transcriptPath = path.join(tmpDir, "transcript.jsonl");
	fs.writeFileSync(
		path.join(dataDir, "config.json"),
		JSON.stringify({ threshold: 0.01, max_tokens: 200000 }),
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// 1. Checkpoint content verification — the checkpoint must contain the
//    actual conversation, not garbage or empty content
// =========================================================================
describe("checkpoint content integrity", () => {
	it("smart compact checkpoint contains all user and assistant text", () => {
		setupMenuFlags("original prompt");
		writeLine(makeUser("Please refactor the auth module"));
		writeLine(
			makeAssistant("I'll refactor the auth module for you.", HIGH_USAGE),
		);
		writeLine(makeUser("Now add unit tests for the refactored code"));
		writeLine(
			makeAssistant("Done, I've added comprehensive unit tests.", HIGH_USAGE),
		);

		runHook({ prompt: "2" });

		const reloadFile = path.join(dataDir, `reload-${cwdH}.json`);
		const reload = JSON.parse(fs.readFileSync(reloadFile, "utf8"));
		const checkpoint = fs.readFileSync(reload.checkpoint_path, "utf8");

		// Verify ALL user messages are present
		assert.ok(
			checkpoint.includes("refactor the auth module"),
			"Missing user message 1",
		);
		assert.ok(checkpoint.includes("add unit tests"), "Missing user message 2");
		// Verify ALL assistant messages are present
		assert.ok(
			checkpoint.includes("refactor the auth module for you"),
			"Missing assistant message 1",
		);
		assert.ok(
			checkpoint.includes("comprehensive unit tests"),
			"Missing assistant message 2",
		);
		// Verify the checkpoint has the header
		assert.ok(checkpoint.includes("# Context Checkpoint (Smart Compact)"));
	});

	it("keep recent checkpoint contains the correct last N messages", () => {
		setupMenuFlags("original");
		// Write 6 exchanges (12 messages)
		for (let i = 0; i < 6; i++) {
			writeLine(makeUser(`question number ${i}`));
			writeLine(makeAssistant(`answer number ${i}`, HIGH_USAGE));
		}

		runHook({ prompt: "3" }); // Keep Recent 20

		const reloadFile = path.join(dataDir, `reload-${cwdH}.json`);
		const reload = JSON.parse(fs.readFileSync(reloadFile, "utf8"));
		const checkpoint = fs.readFileSync(reload.checkpoint_path, "utf8");

		// All 12 messages should be present (20 > 12)
		for (let i = 0; i < 6; i++) {
			assert.ok(
				checkpoint.includes(`question number ${i}`),
				`Missing question ${i}`,
			);
			assert.ok(
				checkpoint.includes(`answer number ${i}`),
				`Missing answer ${i}`,
			);
		}
	});

	it("smart compact replaces tool-only responses with placeholder and tracks files", () => {
		setupMenuFlags();
		writeLine(makeUser("read the file please"));
		// Tool-only response (no text block)
		writeLine({
			type: "assistant",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-20250514",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Read",
						input: { path: "/foo.js" },
					},
				],
				usage: HIGH_USAGE,
			},
		});
		// Text response
		writeLine(
			makeAssistant(
				"Here is the file content, the bug is on line 42.",
				HIGH_USAGE,
			),
		);
		writeLine(makeUser("fix line 42"));
		writeLine(
			makeAssistant("Fixed! The issue was a null pointer.", HIGH_USAGE),
		);

		runHook({ prompt: "2" });

		const reload = JSON.parse(
			fs.readFileSync(path.join(dataDir, `reload-${cwdH}.json`), "utf8"),
		);
		const checkpoint = fs.readFileSync(reload.checkpoint_path, "utf8");

		// Text messages preserved
		assert.ok(checkpoint.includes("read the file please"));
		assert.ok(checkpoint.includes("bug is on line 42"));
		assert.ok(checkpoint.includes("fix line 42"));
		assert.ok(checkpoint.includes("null pointer"));
		// Tool-only response gets tool summary instead of placeholder
		assert.ok(checkpoint.includes("→ Read"), "Should have tool summary for Read");
		assert.ok(checkpoint.includes("/foo.js"), "Should reference the file path");
	});
});

// =========================================================================
// 2. Message ordering — messages must come out in the same order
// =========================================================================
describe("message ordering preservation", () => {
	it("extractConversation preserves chronological order", () => {
		for (let i = 1; i <= 5; i++) {
			writeLine(makeUser(`step ${i} request`));
			writeLine(makeAssistant(`step ${i} done`));
		}

		const result = extractConversation(transcriptPath);

		// Every message found
		for (let i = 1; i <= 5; i++) {
			assert.ok(result.includes(`step ${i} request`), `Missing request ${i}`);
			assert.ok(result.includes(`step ${i} done`), `Missing done ${i}`);
		}

		// Find positions of **User:** and **Assistant:** tagged messages
		// (skip the Session State header which may reference the last message)
		const bodyStart = result.indexOf("---\n\n**");
		assert.ok(bodyStart >= 0, "Should have message body after header");
		const body = result.slice(bodyStart);
		const positions = [];
		for (let i = 1; i <= 5; i++) {
			positions.push(body.indexOf(`step ${i} request`));
			positions.push(body.indexOf(`step ${i} done`));
		}

		// Strictly ascending order within the body
		for (let i = 1; i < positions.length; i++) {
			assert.ok(positions[i] > positions[i - 1], `Message ${i} out of order`);
		}
	});

	it("extractRecent preserves chronological order within window", () => {
		for (let i = 1; i <= 10; i++) {
			writeLine(makeUser(`msg ${i}`));
			writeLine(makeAssistant(`reply ${i}`));
		}

		const result = extractRecent(transcriptPath, 6); // last 6 messages
		// Search in message body after the Session State header
		const bodyStart = result.indexOf("---\n\n**");
		assert.ok(bodyStart >= 0, "Should have message body after header");
		const body = result.slice(bodyStart);
		const pos8 = body.indexOf("**User:** msg 8");
		const pos9 = body.indexOf("**User:** msg 9");
		const pos10 = body.indexOf("**User:** msg 10");
		assert.ok(pos8 >= 0, "msg 8 should be present");
		assert.ok(pos9 >= 0, "msg 9 should be present");
		assert.ok(pos10 >= 0, "msg 10 should be present");
		assert.ok(pos8 < pos9, "msg 8 should come before msg 9");
		assert.ok(pos9 < pos10, "msg 9 should come before msg 10");
	});
});

// =========================================================================
// 3. Successive compaction — second compact must not duplicate first
// =========================================================================
describe("successive compaction integrity", () => {
	it("second extractConversation uses last marker as boundary", () => {
		// Simulate a restored checkpoint (first compaction result)
		writeLine({
			type: "user",
			message: {
				role: "user",
				content:
					"[SMART COMPACT — restored checkpoint]\n\n**User:** original question\n\n**Assistant:** original answer",
			},
		});
		// New messages after restore
		writeLine(makeUser("follow-up question"));
		writeLine(makeAssistant("follow-up answer"));

		const result = extractConversation(transcriptPath);

		// Preamble should contain the first compaction's content
		assert.ok(result.includes("[SMART COMPACT"));
		assert.ok(result.includes("original question"));
		// New messages should be present
		assert.ok(result.includes("follow-up question"));
		assert.ok(result.includes("follow-up answer"));

		// "follow-up question" appears in the message body; it may also
		// appear in the Session State header's "Goal:" line as a summary.
		// The key invariant is that it appears exactly once as a **User:** message.
		const userMatches = result.match(/\*\*User:\*\* follow-up question/g);
		assert.equal(
			userMatches.length,
			1,
			"follow-up question should appear exactly once as a User message",
		);
	});

	it("markers from prior compactions are not included as user messages", () => {
		writeLine({
			type: "user",
			message: {
				role: "user",
				content: "[KEEP RECENT — restored checkpoint]\n\nold stuff",
			},
		});
		writeLine(makeUser("new stuff"));

		const result = extractConversation(transcriptPath);
		// The marker should be the preamble, not a **User:** entry
		assert.ok(!result.includes("**User:** [KEEP RECENT"));
		assert.ok(result.includes("**User:** new stuff"));
	});
});

// =========================================================================
// 4. Full round-trip: warning → compact → reload injection
// =========================================================================
describe("full compaction round-trip", () => {
	it("compacted context is correctly injected after reload", () => {
		// Step 1: Set up menu and compact
		setupMenuFlags("implement the search feature");
		writeLine(makeUser("analyze the codebase structure"));
		writeLine(
			makeAssistant(
				"The codebase has three main modules: auth, api, and search.",
				HIGH_USAGE,
			),
		);
		writeLine(makeUser("tell me about the search module"));
		writeLine(
			makeAssistant(
				"The search module uses Elasticsearch and has two endpoints.",
				HIGH_USAGE,
			),
		);

		const compactResult = runHook({ prompt: "2" });
		assert.equal(compactResult.decision, "block");

		// Step 2: Verify reload file has the original prompt
		const reloadFile = path.join(dataDir, `reload-${cwdH}.json`);
		const reload = JSON.parse(fs.readFileSync(reloadFile, "utf8"));
		assert.equal(reload.original_prompt, "implement the search feature");
		assert.equal(reload.mode, "smart");

		// Step 3: Simulate fresh session after /clear — new session_id, new transcript
		const freshTranscript = path.join(tmpDir, "fresh-transcript.jsonl");
		fs.writeFileSync(
			freshTranscript,
			JSON.stringify(makeUser("hello after clear")) + "\n",
		);

		const injectResult = runHook({
			prompt: "hello after clear",
			transcript_path: freshTranscript,
			session_id: "fresh-session-5678",
		});

		// Step 4: Verify injection contains the conversation
		assert.ok(injectResult.hookSpecificOutput, "Should inject checkpoint");
		const ctx = injectResult.hookSpecificOutput.additionalContext;
		assert.ok(
			ctx.includes("[SMART COMPACT"),
			"Should have smart compact marker",
		);
		assert.ok(
			ctx.includes("codebase structure"),
			"Should contain user message",
		);
		assert.ok(
			ctx.includes("Elasticsearch"),
			"Should contain assistant message",
		);
		assert.ok(ctx.includes("resume"), "Should mention resume");
	});

	it("resume replays the original prompt through the full flow", () => {
		// Step 1: Compact with an original prompt
		setupMenuFlags("deploy to production");
		writeLine(makeUser("check the CI status"));
		writeLine(makeAssistant("CI is green, all tests pass.", HIGH_USAGE));

		runHook({ prompt: "2" });

		// Step 2: Simulate reload in fresh session (creates resume file)
		const freshTranscript = path.join(tmpDir, "fresh2.jsonl");
		fs.writeFileSync(freshTranscript, JSON.stringify(makeUser("hello")) + "\n");
		runHook({ prompt: "hello", transcript_path: freshTranscript, session_id: "fresh-session-5678" });

		// Step 3: Verify resume file exists with correct prompt
		const resumeFile = path.join(dataDir, `resume-${cwdH}.json`);
		assert.ok(fs.existsSync(resumeFile), "Resume file should exist");
		const resumeData = JSON.parse(fs.readFileSync(resumeFile, "utf8"));
		assert.equal(resumeData.original_prompt, "deploy to production");
	});
});

// =========================================================================
// 5. State file accuracy — headroom and recommendation must be correct
// =========================================================================
describe("state file accuracy", () => {
	it("headroom is mathematically correct", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE)); // 5000 tokens

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));

		// threshold=0.01, max_tokens=200000, current=5000
		// headroom = max(0, round(200000 * 0.01 - 5000)) = max(0, round(2000 - 5000)) = 0
		assert.equal(state.headroom, 0);
		assert.equal(state.threshold, 0.01);
	});

	it("recommendation says 'at threshold' when above", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE)); // 5000 tokens, well above 0.01 * 200K = 2000

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.ok(state.recommendation.includes("At threshold"));
	});

	it("recommendation says 'all clear' when well below threshold", () => {
		// Use high threshold so low usage is below 50% of threshold
		fs.writeFileSync(
			path.join(dataDir, "config.json"),
			JSON.stringify({ threshold: 0.9, max_tokens: 200000 }),
		);
		writeLine(makeUser("hello"));
		writeLine(
			makeAssistant("hi", {
				input_tokens: 100,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 5,
			}),
		);

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.ok(state.recommendation.includes("All clear"));
	});

	it("recommendation says 'approaching' when between 50-100% of threshold", () => {
		// threshold=0.10, usage=15000 → pct=7.5% → 75% of threshold
		fs.writeFileSync(
			path.join(dataDir, "config.json"),
			JSON.stringify({ threshold: 0.1, max_tokens: 200000 }),
		);
		writeLine(makeUser("hello"));
		writeLine(
			makeAssistant("hi", {
				input_tokens: 15000,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 50,
			}),
		);

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.ok(state.recommendation.includes("Approaching"));
	});
});

// =========================================================================
// 6. Empty/degenerate transcripts don't produce corrupt checkpoints
// =========================================================================
describe("degenerate transcript handling", () => {
	it("transcript with only system messages produces no user/assistant content", () => {
		writeLine({ type: "system", message: { content: "System prompt here" } });
		writeLine({ type: "system", message: { content: "More system stuff" } });

		const result = extractConversation(transcriptPath);
		assert.ok(!result.includes("**User:**"));
		assert.ok(!result.includes("**Assistant:**"));
	});

	it("transcript with only tool interactions produces placeholders and file list", () => {
		writeLine(makeUser(""));
		writeLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
					{ type: "tool_use", id: "t2", name: "Edit", input: { path: "/b" } },
				],
			},
		});
		writeLine(makeUser(""));
		writeLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t3", name: "Bash", input: { cmd: "ls" } },
				],
			},
		});

		const result = extractConversation(transcriptPath);
		// No user messages (all empty), but tool-only assistants get tool summaries
		assert.ok(!result.includes("**User:**"));
		assert.ok(
			result.includes("→ Read") || result.includes("→ Edit") || result.includes("→ Ran"),
			"Should have tool summaries for tool-only responses",
		);
	});

	it("mixed tool and text preserves text and tracks files", () => {
		writeLine(makeUser("fix the bug"));
		writeLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I'll fix that bug now." },
					{
						type: "tool_use",
						id: "t1",
						name: "Edit",
						input: { path: "/bug.js" },
					},
					{ type: "text", text: "Done, the bug is fixed." },
				],
			},
		});

		const result = extractConversation(transcriptPath);
		assert.ok(result.includes("fix the bug"));
		assert.ok(result.includes("I'll fix that bug now."));
		assert.ok(result.includes("Done, the bug is fixed."));
		// File tracked in Session State header as "Files modified"
		assert.ok(result.includes("Files modified"), "Should have Files modified in header");
		assert.ok(result.includes("/bug.js"), "Should reference the edited file");
		// Tool use produces a summary, not raw tool_use JSON
		assert.ok(!result.includes('"type":"tool_use"'));
	});
});

// =========================================================================
// 7. Concurrent session isolation
// =========================================================================
describe("session isolation", () => {
	it("different session IDs write to different state files", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "test", session_id: "session-AAA" });
		runHook({ prompt: "test", session_id: "session-BBB" });

		const stateA = path.join(dataDir, "state-session-AAA.json");
		const stateB = path.join(dataDir, "state-session-BBB.json");
		assert.ok(fs.existsSync(stateA));
		assert.ok(fs.existsSync(stateB));

		const dataA = JSON.parse(fs.readFileSync(stateA, "utf8"));
		const dataB = JSON.parse(fs.readFileSync(stateB, "utf8"));
		assert.equal(dataA.session_id, "session-AAA");
		assert.equal(dataB.session_id, "session-BBB");
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const HOOK_PATH = path.resolve("hooks/submit.mjs");

let tmpDir;
let transcriptPath;
let cwd;
let dataDir;
let flagsDir;
let cwdH; // cwd hash for project-scoped files

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, `${JSON.stringify(obj)}\n`);
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
			env: {
				...process.env,
				CLAUDE_PLUGIN_DATA: dataDir,
			},
		});
		return stdout ? JSON.parse(stdout) : null;
	} catch (e) {
		if (e.status === 0 && !e.stdout?.trim()) return null;
		if (e.status === 0 && e.stdout?.trim()) return JSON.parse(e.stdout);
		throw e;
	}
}

const HIGH_USAGE = {
	input_tokens: 5000,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
	output_tokens: 10,
};

const LOW_USAGE = {
	input_tokens: 5,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
	output_tokens: 2,
};

function makeAssistant(text, usage, model) {
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

function makeUser(text) {
	return { type: "user", message: { role: "user", content: text } };
}

/** Write a transcript with enough extractable content for compaction */
function writeExtractableTranscript() {
	writeLine(makeUser("hello world, please help me with this project"));
	writeLine(
		makeAssistant(
			"Sure! I'd be happy to help you with your project. What do you need?",
			HIGH_USAGE,
		),
	);
	writeLine(makeUser("please fix the authentication bug in login.js"));
	writeLine(
		makeAssistant(
			"I'll look into the authentication issue right away and fix it.",
			HIGH_USAGE,
		),
	);
	writeLine(makeUser("also update the tests for the auth module"));
	writeLine(
		makeAssistant(
			"Done! I've updated all the auth module tests to cover the fix.",
			HIGH_USAGE,
		),
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-submit-"));
	cwd = path.join(tmpDir, "project");
	dataDir = path.join(tmpDir, "data");
	flagsDir = path.join(cwd, ".claude");
	cwdH = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	fs.mkdirSync(cwd, { recursive: true });
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
// Slash command bypass
// =========================================================================
describe("slash command bypass", () => {
	it("exits silently for slash commands", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));
		const result = runHook({ prompt: "/cg:stats" });
		assert.equal(result, null);
	});
});

// =========================================================================
// Token state writing
// =========================================================================
describe("token state writing", () => {
	it("writes state file with correct fields for high usage", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "do something" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		assert.ok(fs.existsSync(sf));
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.equal(state.current_tokens, 5000);
		assert.equal(state.session_id, "test-session-1234");
		assert.equal(typeof state.headroom, "number");
		assert.equal(typeof state.recommendation, "string");
		assert.equal(typeof state.threshold, "number");
		assert.equal(state.source, "real");
	});

	it("writes state file for low usage", () => {
		writeLine(makeUser("hi"));
		writeLine(makeAssistant("hello", LOW_USAGE));

		runHook({ prompt: "do something" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		assert.ok(fs.existsSync(sf));
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.equal(state.current_tokens, 5);
		assert.ok(state.recommendation.includes("All clear"));
	});

	it("includes savings estimates in state", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.ok(state.smart_estimate_pct != null, "smart_estimate_pct should exist");
		assert.ok(state.recent_estimate_pct != null, "recent_estimate_pct should exist");
	});
});

// =========================================================================
// No blocking — above threshold exits silently
// =========================================================================
describe("no blocking above threshold", () => {
	it("exits silently when above threshold (no warning menu)", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		const result = runHook({ prompt: "do something" });
		// Should NOT block — just write state and exit
		assert.equal(result, null);
	});

	it("does not create any warning flag files", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "do something" });

		// No warning-related flags should exist
		const files = fs.readdirSync(flagsDir);
		const warningFlags = files.filter(
			(f) =>
				f.includes("cg-warned") ||
				f.includes("cg-menu") ||
				f.includes("cg-prompt"),
		);
		assert.equal(warningFlags.length, 0);
	});

	it("writes recommendation mentioning compaction at threshold", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.ok(state.recommendation.includes("Compaction recommended"));
		assert.ok(state.recommendation.includes("/cg:compact"));
	});
});

// =========================================================================
// No graduated nudges
// =========================================================================
describe("no graduated nudges", () => {
	it("does not inject additionalContext at 50% usage", () => {
		// Set threshold high so 50% is below it
		fs.writeFileSync(
			path.join(dataDir, "config.json"),
			JSON.stringify({ threshold: 0.80, max_tokens: 200000 }),
		);
		// 50% usage = 100000 tokens out of 200000
		const usage = {
			input_tokens: 100000,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			output_tokens: 10,
		};
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", usage));

		const result = runHook({ prompt: "do something" });
		assert.equal(result, null);
	});

	it("does not inject additionalContext at 65% usage", () => {
		fs.writeFileSync(
			path.join(dataDir, "config.json"),
			JSON.stringify({ threshold: 0.80, max_tokens: 200000 }),
		);
		const usage = {
			input_tokens: 130000,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			output_tokens: 10,
		};
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", usage));

		const result = runHook({ prompt: "do something" });
		assert.equal(result, null);
	});

	it("does not create nudge flag files", () => {
		fs.writeFileSync(
			path.join(dataDir, "config.json"),
			JSON.stringify({ threshold: 0.80, max_tokens: 200000 }),
		);
		const usage = {
			input_tokens: 130000,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			output_tokens: 10,
		};
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", usage));

		runHook({ prompt: "do something" });

		const files = fs.readdirSync(flagsDir);
		const nudgeFlags = files.filter(
			(f) => f.includes("nudge50") || f.includes("nudge65"),
		);
		assert.equal(nudgeFlags.length, 0);
	});
});

// =========================================================================
// Resume detection
// =========================================================================
describe("resume", () => {
	it("replays saved prompt when user types resume", () => {
		fs.writeFileSync(
			path.join(dataDir, `resume-${cwdH}.json`),
			JSON.stringify({ original_prompt: "fix the bug", ts: Date.now() }),
		);
		const result = runHook({ prompt: "resume" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("fix the bug"),
		);
	});

	it("shows expiry message for old resume", () => {
		fs.writeFileSync(
			path.join(dataDir, `resume-${cwdH}.json`),
			JSON.stringify({
				original_prompt: "old",
				ts: Date.now() - 20 * 60 * 1000,
			}),
		);
		const result = runHook({ prompt: "resume" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("expired"));
	});

	it("shows error for corrupted resume file", () => {
		fs.writeFileSync(path.join(dataDir, `resume-${cwdH}.json`), "NOT JSON{{{");
		const result = runHook({ prompt: "resume" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("corrupted"));
	});
});

// =========================================================================
// Reload detection
// =========================================================================
describe("reload detection", () => {
	function createReloadFile(overrides) {
		const checkpointPath = path.join(
			dataDir,
			"checkpoints",
			"test-checkpoint.md",
		);
		fs.writeFileSync(
			checkpointPath,
			"## Session State\n\nGoal: fix the auth bug\nFiles modified: login.js\n\n## Conversation Index\n\n[1] User asked to fix auth — resolved by editing login.js\n\n---\n\n[1] User: prior message about auth\n\nAssistant: prior response about the fix",
		);
		const reload = {
			checkpoint_path: checkpointPath,
			original_prompt: "my blocked prompt",
			ts: Date.now(),
			stats: {
				preTokens: 5000,
				postTokens: 500,
				maxTokens: 200000,
				saved: 4500,
				savedPct: 90,
				prePct: 2.5,
				postPct: 0.25,
			},
			mode: "smart",
			created_session: "other-session",
			...overrides,
		};
		fs.writeFileSync(
			path.join(dataDir, `reload-${cwdH}.json`),
			JSON.stringify(reload),
		);
		return reload;
	}

	it("injects index + Read instruction into fresh session", () => {
		createReloadFile();
		// Fresh transcript — no assistant messages
		writeLine(makeUser("hello after clear"));

		const result = runHook({ prompt: "hello after clear" });
		assert.ok(result.hookSpecificOutput);
		const ctx = result.hookSpecificOutput.additionalContext;
		// Should have the restore marker
		assert.ok(ctx.includes("[SMART COMPACT"), "Should have restore marker");
		// Should have conversation index content (not full body)
		assert.ok(ctx.includes("Conversation Index"), "Should have index");
		assert.ok(ctx.includes("fix the auth bug"), "Should have index content");
		// Should have Read instruction with checkpoint path
		assert.ok(ctx.includes("Read that file"), "Should have Read instruction");
		assert.ok(
			ctx.includes("test-checkpoint.md"),
			"Should include checkpoint path",
		);
		// Should have resume hint (original_prompt exists)
		assert.ok(ctx.includes("resume"), "Should mention resume");
		// Should NOT contain the full chronological body
		assert.ok(
			!ctx.includes("[1] User: prior message"),
			"Should NOT contain full body — Read instruction handles that",
		);
	});

	it("creates resume file when original_prompt exists", () => {
		createReloadFile({ original_prompt: "my saved prompt" });
		writeLine(makeUser("hello"));

		runHook({ prompt: "hello" });

		const resumeFile = path.join(dataDir, `resume-${cwdH}.json`);
		assert.ok(fs.existsSync(resumeFile));
		const data = JSON.parse(fs.readFileSync(resumeFile, "utf8"));
		assert.equal(data.original_prompt, "my saved prompt");
	});

	it("does immediate resume when user types resume after /clear", () => {
		createReloadFile({ original_prompt: "fix the auth bug" });
		writeLine(makeUser("resume"));

		const result = runHook({ prompt: "resume" });
		assert.ok(result.hookSpecificOutput);
		const ctx = result.hookSpecificOutput.additionalContext;
		assert.ok(ctx.includes("<original_request>"), "Should have original request");
		assert.ok(ctx.includes("fix the auth bug"), "Should have the prompt");
		assert.ok(ctx.includes("Read that file"), "Should have Read instruction");
		assert.ok(
			ctx.includes("Respond to the original request"),
			"Should instruct to respond",
		);
	});

	it("uses KEEP RECENT marker for recent mode", () => {
		createReloadFile({ mode: "recent" });
		writeLine(makeUser("hello"));

		const result = runHook({ prompt: "hello" });
		const ctx = result.hookSpecificOutput.additionalContext;
		assert.ok(ctx.includes("[KEEP RECENT"), "Should have recent marker");
		assert.ok(ctx.includes("Read that file"), "Should have Read instruction");
	});

	it("skips injection for same session that created compaction", () => {
		createReloadFile({ created_session: "test-session-1234" });
		// Same session — should skip injection and remind to /clear
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi there", HIGH_USAGE));
		writeLine(makeUser("next question"));

		const _result = runHook({ prompt: "next question" });
		// Should NOT inject (same session) — falls through to token check
		// Reload file should still exist (not consumed)
		assert.ok(fs.existsSync(path.join(dataDir, `reload-${cwdH}.json`)));
	});

	it("shows error when checkpoint file is missing", () => {
		createReloadFile({ checkpoint_path: "/nonexistent/checkpoint.md" });
		writeLine(makeUser("hello"));

		const result = runHook({ prompt: "hello" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("checkpoint file was deleted"));
		// Reload file should be cleaned up
		assert.ok(!fs.existsSync(path.join(dataDir, `reload-${cwdH}.json`)));
	});

	it("cleans up expired reload file", () => {
		createReloadFile({ ts: Date.now() - 15 * 60 * 1000 }); // 15 min ago
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", LOW_USAGE));

		runHook({ prompt: "hello" });
		// Expired reload should be deleted
		assert.ok(!fs.existsSync(path.join(dataDir, `reload-${cwdH}.json`)));
	});

	it("injects without resume hint when no original_prompt", () => {
		createReloadFile({ original_prompt: "" });
		writeLine(makeUser("hello"));

		const result = runHook({ prompt: "hello" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			!result.hookSpecificOutput.additionalContext.includes("Type **resume**"),
		);
	});

	it("includes compaction stats in injection", () => {
		createReloadFile();
		writeLine(makeUser("hello"));

		const result = runHook({ prompt: "hello" });
		const ctx = result.hookSpecificOutput.additionalContext;
		assert.ok(ctx.includes("Compaction Stats"));
		assert.ok(ctx.includes("5,000"));
	});

	it("includes checkpoint file path in Read instruction", () => {
		createReloadFile();
		writeLine(makeUser("hello"));

		const result = runHook({ prompt: "hello" });
		const ctx = result.hookSpecificOutput.additionalContext;
		// The Read instruction should reference the exact checkpoint path
		const checkpointPath = path.join(
			dataDir,
			"checkpoints",
			"test-checkpoint.md",
		);
		assert.ok(
			ctx.includes(checkpointPath),
			"Should include full checkpoint path for Read",
		);
	});
});

// =========================================================================
// Manual compact (via /cg:compact and :prune skills)
// =========================================================================
describe("manual compact", () => {
	it("runs smart compact when flag contains 'smart'", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"smart",
		);
		writeExtractableTranscript();

		const result = runHook({ prompt: "go" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("Compaction Stats"),
		);
	});

	it("runs keep recent when flag contains 'recent'", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"recent",
		);
		writeExtractableTranscript();

		const result = runHook({ prompt: "go" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("Compaction Stats"),
		);
	});

	it("rejects invalid mode in flag file", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"banana",
		);
		const result = runHook({ prompt: "go" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("invalid compaction mode"));
	});

	it("warns on empty extraction for smart compact", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"smart",
		);
		writeLine(makeUser(""));
		const result = runHook({ prompt: "go" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("Could not extract"),
		);
	});

	it("warns on empty extraction for prune", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"recent",
		);
		writeLine(makeUser(""));
		const result = runHook({ prompt: "go" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("Could not extract"),
		);
	});

	it("creates reload file with correct mode", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"smart",
		);
		writeExtractableTranscript();

		runHook({ prompt: "go" });

		const reloadFile = path.join(dataDir, `reload-${cwdH}.json`);
		assert.ok(fs.existsSync(reloadFile));
		const reload = JSON.parse(fs.readFileSync(reloadFile, "utf8"));
		assert.equal(reload.mode, "smart");
		assert.equal(reload.original_prompt, "");
	});
});

// =========================================================================
// No transcript
// =========================================================================
describe("no transcript", () => {
	it("exits silently when transcript path is missing", () => {
		const result = runHook({
			prompt: "hello",
			transcript_path: "/nonexistent/transcript.jsonl",
		});
		assert.equal(result, null);
	});
});

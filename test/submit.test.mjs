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
	fs.appendFileSync(transcriptPath, JSON.stringify(obj) + "\n");
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

/** Set up warning menu flags as if the user was just shown the warning */
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
		const result = runHook({ prompt: "/context-guardian:status" });
		assert.equal(result, null);
	});
});

// =========================================================================
// Threshold warning
// =========================================================================
describe("threshold warning", () => {
	it("shows menu when above threshold", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		const result = runHook({ prompt: "do something" });
		assert.ok(result);
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("Context Guardian"));
		assert.ok(result.reason.includes("Reply with"));
	});

	it("does not warn when below threshold", () => {
		writeLine(makeUser("hi"));
		writeLine(makeAssistant("hello", LOW_USAGE));

		const result = runHook({ prompt: "do something" });
		assert.equal(result, null);
	});

	it("saves original prompt to flag file", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "my important message" });

		const promptFile = path.join(flagsDir, "cg-prompt-test-session-1234");
		assert.ok(fs.existsSync(promptFile));
		assert.equal(fs.readFileSync(promptFile, "utf8"), "my important message");
	});

	it("writes session-scoped state file with pre-computed fields", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		runHook({ prompt: "test" });

		const sf = path.join(dataDir, "state-test-session-1234.json");
		assert.ok(fs.existsSync(sf));
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		assert.equal(state.current_tokens, 5000);
		assert.equal(state.session_id, "test-session-1234");
		assert.equal(typeof state.headroom, "number");
		assert.equal(typeof state.recommendation, "string");
		assert.equal(typeof state.threshold, "number");
	});

	it("does not re-warn when already warned this session", () => {
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));
		// Simulate already warned
		fs.writeFileSync(
			path.join(flagsDir, "cg-warned-test-session-1234"),
			JSON.stringify({ ts: Date.now() }),
		);

		const result = runHook({ prompt: "another message" });
		assert.equal(result, null); // silently exits
	});
});

// =========================================================================
// Menu response — choice 1 (continue)
// =========================================================================
describe("menu response — choice 1 (continue)", () => {
	it("replays original prompt via additionalContext", () => {
		setupMenuFlags("my original message");
		const result = runHook({ prompt: "1" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes(
				"my original message",
			),
		);
	});
});

// =========================================================================
// Menu response — choice 0 (invalid, re-shows menu)
// =========================================================================
describe("menu response — choice 0 (invalid)", () => {
	it("re-shows menu for invalid choice 0", () => {
		setupMenuFlags("my message");
		const result = runHook({ prompt: "0" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("not a valid option"));
	});
});

// =========================================================================
// Menu response — choice 2 (smart compact)
// =========================================================================
describe("menu response — choice 2 (smart compact)", () => {
	it("creates checkpoint and reload file on success", () => {
		setupMenuFlags("original prompt");
		writeExtractableTranscript();

		const result = runHook({ prompt: "2" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("Compaction Stats"));

		// Reload file should exist
		const reloadFile = path.join(dataDir, `reload-${cwdH}.json`);
		assert.ok(fs.existsSync(reloadFile));
		const reload = JSON.parse(fs.readFileSync(reloadFile, "utf8"));
		assert.equal(reload.mode, "smart");
		assert.equal(reload.original_prompt, "original prompt");
		assert.ok(fs.existsSync(reload.checkpoint_path));

		// Warned flag should be cleaned
		assert.ok(
			!fs.existsSync(path.join(flagsDir, "cg-warned-test-session-1234")),
		);
		// Cooldown should be set
		assert.ok(fs.existsSync(path.join(dataDir, `cooldown-${cwdH}.json`)));
		// Prompt file should be cleaned (deferred cleanup)
		assert.ok(
			!fs.existsSync(path.join(flagsDir, "cg-prompt-test-session-1234")),
		);
	});

	it("warns and re-creates menu on empty extraction", () => {
		setupMenuFlags("my msg");
		// Empty transcript — no messages at all
		// (tool-only transcripts now produce placeholders, so we need truly empty)
		fs.writeFileSync(transcriptPath, "");

		const result = runHook({ prompt: "2" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("could not extract"));
		assert.ok(fs.existsSync(path.join(flagsDir, "cg-menu-test-session-1234")));
	});
});

// =========================================================================
// Menu response — choice 3 (keep recent)
// =========================================================================
describe("menu response — choice 3 (keep recent)", () => {
	it("creates checkpoint with recent messages", () => {
		setupMenuFlags("original");
		writeExtractableTranscript();

		const result = runHook({ prompt: "3" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("Compaction Stats"));

		const reloadFile = path.join(dataDir, `reload-${cwdH}.json`);
		assert.ok(fs.existsSync(reloadFile));
		const reload = JSON.parse(fs.readFileSync(reloadFile, "utf8"));
		assert.equal(reload.mode, "recent");
		assert.ok(fs.existsSync(reload.checkpoint_path));
	});

	it("warns on empty extraction", () => {
		setupMenuFlags("msg");
		writeLine(makeUser(""));

		const result = runHook({ prompt: "3" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("could not extract"));
		assert.ok(fs.existsSync(path.join(flagsDir, "cg-menu-test-session-1234")));
	});
});

// =========================================================================
// Menu response — choice 4 (clear)
// =========================================================================
describe("menu response — choice 4 (clear)", () => {
	it("tells user to /clear and sets cooldown", () => {
		setupMenuFlags();
		const result = runHook({ prompt: "4" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("/clear"));
		// Cooldown should be set
		assert.ok(fs.existsSync(path.join(dataDir, `cooldown-${cwdH}.json`)));
	});
});

// =========================================================================
// Menu response — invalid choice
// =========================================================================
describe("menu response — invalid choice", () => {
	it("re-shows menu for unrecognized input", () => {
		setupMenuFlags();
		const result = runHook({ prompt: "banana" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("not a valid option"));
		assert.ok(result.reason.includes("Continue"));
	});

	it("re-shows menu for digit 9", () => {
		setupMenuFlags();
		const result = runHook({ prompt: "9" });
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("not a valid option"));
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
// Cooldown
// =========================================================================
describe("cooldown", () => {
	it("suppresses warning during active cooldown", () => {
		fs.writeFileSync(
			path.join(dataDir, `cooldown-${cwdH}.json`),
			JSON.stringify({ ts: Date.now() }),
		);
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		const result = runHook({ prompt: "do work" });
		assert.equal(result, null);
	});

	it("cleans up expired cooldown and proceeds to warn", () => {
		// Cooldown from 5 minutes ago (expired — limit is 2 min)
		fs.writeFileSync(
			path.join(dataDir, `cooldown-${cwdH}.json`),
			JSON.stringify({ ts: Date.now() - 5 * 60 * 1000 }),
		);
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi", HIGH_USAGE));

		const result = runHook({ prompt: "do work" });
		// Should show warning (cooldown expired)
		assert.ok(result);
		assert.equal(result.decision, "block");
		assert.ok(result.reason.includes("Context Guardian"));
		// Cooldown file should be cleaned
		assert.ok(!fs.existsSync(path.join(dataDir, `cooldown-${cwdH}.json`)));
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
			"# Context Checkpoint\n\n**User:** prior message\n\n**Assistant:** prior response",
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

	it("injects checkpoint into fresh session", () => {
		createReloadFile();
		// Fresh transcript — no assistant messages
		writeLine(makeUser("hello after clear"));

		const result = runHook({ prompt: "hello after clear" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("[SMART COMPACT"),
		);
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("prior message"),
		);
		assert.ok(result.hookSpecificOutput.additionalContext.includes("resume"));
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
		assert.ok(ctx.includes("<original_request>"));
		assert.ok(ctx.includes("fix the auth bug"));
		assert.ok(ctx.includes("Respond to it now"));
	});

	it("uses KEEP RECENT marker for recent mode", () => {
		createReloadFile({ mode: "recent" });
		writeLine(makeUser("hello"));

		const result = runHook({ prompt: "hello" });
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("[KEEP RECENT"),
		);
	});

	it("skips injection for same session that created compaction", () => {
		createReloadFile({ created_session: "test-session-1234" });
		// Same session — should skip injection and remind to /clear
		writeLine(makeUser("hello"));
		writeLine(makeAssistant("hi there", HIGH_USAGE));
		writeLine(makeUser("next question"));

		const result = runHook({ prompt: "next question" });
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
		assert.ok(
			result.hookSpecificOutput.additionalContext.includes("Compaction Stats"),
		);
		assert.ok(result.hookSpecificOutput.additionalContext.includes("5,000"));
	});
});

// =========================================================================
// Manual compact (via /context-guardian:compact and :prune skills)
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
		assert.ok(result.hookSpecificOutput.additionalContext.includes("Compaction Stats"));
	});

	it("runs keep recent when flag contains 'recent'", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"recent",
		);
		writeExtractableTranscript();

		const result = runHook({ prompt: "go" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(result.hookSpecificOutput.additionalContext.includes("Compaction Stats"));
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
		assert.ok(result.hookSpecificOutput.additionalContext.includes("Could not extract"));
	});

	it("warns on empty extraction for prune", () => {
		fs.writeFileSync(
			path.join(flagsDir, "cg-compact-test-session-1234"),
			"recent",
		);
		writeLine(makeUser(""));
		const result = runHook({ prompt: "go" });
		assert.ok(result.hookSpecificOutput);
		assert.ok(result.hookSpecificOutput.additionalContext.includes("Could not extract"));
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

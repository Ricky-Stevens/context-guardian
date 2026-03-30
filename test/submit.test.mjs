import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const HOOK_PATH = path.resolve("hooks/submit.mjs");

let tmpDir;
let transcriptPath;
let cwd;
let dataDir;
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

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-submit-"));
	cwd = path.join(tmpDir, "project");
	dataDir = path.join(tmpDir, "data");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(dataDir, { recursive: true });
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
		assert.ok(
			state.smart_estimate_pct != null,
			"smart_estimate_pct should exist",
		);
		assert.ok(
			state.recent_estimate_pct != null,
			"recent_estimate_pct should exist",
		);
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
		const claudeDir = path.join(cwd, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		const files = fs.readdirSync(claudeDir);
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
// Submit hook never injects additionalContext
// =========================================================================
describe("no additionalContext", () => {
	it("submit hook never returns additionalContext", () => {
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

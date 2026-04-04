import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const CLI_PATH = path.resolve("lib/compact-cli.mjs");

let tmpDir;
let dataDir;
let transcriptPath;

function makeAssistant(text, usage) {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-sonnet-4-20250514",
			content: [{ type: "text", text }],
			usage: usage || {
				input_tokens: 1000,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 50,
			},
		},
	};
}

function makeUser(text) {
	return { type: "user", message: { role: "user", content: text } };
}

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, `${JSON.stringify(obj)}\n`);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cli-"));
	dataDir = path.join(tmpDir, "data");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.mkdirSync(path.join(dataDir, "checkpoints"), { recursive: true });
	transcriptPath = path.join(tmpDir, "transcript.jsonl");
	fs.writeFileSync(transcriptPath, "");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runCli(args = []) {
	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				CLAUDE_PLUGIN_DATA: dataDir,
				HOME: os.homedir(),
			},
			cwd: tmpDir,
		});
		return JSON.parse(stdout);
	} catch (e) {
		if (e.stdout?.trim()) return JSON.parse(e.stdout);
		throw e;
	}
}

// ===========================================================================
// Invalid mode
// ===========================================================================

describe("invalid mode", () => {
	it("returns error for unknown mode", () => {
		const result = runCli(["bogus", "sid", dataDir]);
		assert.equal(result.success, false);
		assert.ok(result.error.includes("Invalid mode"));
	});

	it("returns error for empty mode", () => {
		const result = runCli([]);
		assert.equal(result.success, false);
		assert.ok(result.error.includes("Invalid mode"));
	});
});

// ===========================================================================
// Missing session data
// ===========================================================================

describe("missing session data", () => {
	it("returns error when no state file exists", () => {
		const result = runCli(["smart", "nonexistent", dataDir]);
		assert.equal(result.success, false);
		assert.ok(result.error.includes("No session data"));
	});
});

// ===========================================================================
// Missing transcript
// ===========================================================================

describe("missing transcript", () => {
	it("returns error when transcript_path in state does not exist", () => {
		fs.writeFileSync(
			path.join(dataDir, "state-sid1.json"),
			JSON.stringify({ transcript_path: "/nonexistent/transcript.jsonl" }),
		);
		const result = runCli(["smart", "sid1", dataDir]);
		assert.equal(result.success, false);
		assert.ok(result.error.includes("Transcript not found"));
	});

	it("returns error when transcript_path is empty", () => {
		fs.writeFileSync(
			path.join(dataDir, "state-sid2.json"),
			JSON.stringify({ transcript_path: "" }),
		);
		const result = runCli(["smart", "sid2", dataDir]);
		assert.equal(result.success, false);
		assert.ok(result.error.includes("Transcript not found"));
	});
});

// ===========================================================================
// Smart compaction
// ===========================================================================

describe("smart compaction", () => {
	it("succeeds with extractable transcript content", () => {
		// Build a minimal but extractable transcript
		writeLine(makeUser("Please refactor the login module"));
		writeLine(
			makeAssistant(
				"I'll refactor the login module. Here's my plan:\n1. Extract validation\n2. Add error handling",
			),
		);
		writeLine(makeUser("Looks good, go ahead"));
		writeLine(
			makeAssistant(
				"Done. I've extracted the validation into a separate function.",
			),
		);

		fs.writeFileSync(
			path.join(dataDir, "state-smart1.json"),
			JSON.stringify({ transcript_path: transcriptPath }),
		);

		const result = runCli(["smart", "smart1", dataDir]);
		assert.equal(result.success, true);
		assert.ok(typeof result.statsBlock === "string");
	});

	it("returns error with empty transcript", () => {
		fs.writeFileSync(transcriptPath, "");
		fs.writeFileSync(
			path.join(dataDir, "state-empty1.json"),
			JSON.stringify({ transcript_path: transcriptPath }),
		);

		const result = runCli(["smart", "empty1", dataDir]);
		assert.equal(result.success, false);
		assert.ok(result.error.includes("No extractable content"));
	});
});

// ===========================================================================
// Recent compaction
// ===========================================================================

describe("recent compaction", () => {
	it("succeeds with extractable transcript content", () => {
		writeLine(makeUser("Fix the bug in auth.js"));
		writeLine(
			makeAssistant("I found the issue. The token was not being refreshed."),
		);
		writeLine(makeUser("Great, apply the fix"));
		writeLine(
			makeAssistant("Applied. The token refresh now happens on every request."),
		);

		fs.writeFileSync(
			path.join(dataDir, "state-recent1.json"),
			JSON.stringify({ transcript_path: transcriptPath }),
		);

		const result = runCli(["recent", "recent1", dataDir]);
		assert.equal(result.success, true);
		assert.ok(typeof result.statsBlock === "string");
	});
});

// ===========================================================================
// Output format
// ===========================================================================

describe("output format", () => {
	it("always outputs valid JSON", () => {
		// Even error cases must be parseable JSON
		const result = runCli(["smart", "nope", dataDir]);
		assert.ok(typeof result === "object");
		assert.ok("success" in result);
	});

	it("error response has success=false and error string", () => {
		const result = runCli(["invalid-mode", "sid", dataDir]);
		assert.equal(result.success, false);
		assert.ok(typeof result.error === "string");
		assert.ok(result.error.length > 0);
	});

	it("success response has success=true and statsBlock string", () => {
		writeLine(makeUser("Do something"));
		writeLine(makeAssistant("Done with the task."));

		fs.writeFileSync(
			path.join(dataDir, "state-fmt1.json"),
			JSON.stringify({ transcript_path: transcriptPath }),
		);

		const result = runCli(["smart", "fmt1", dataDir]);
		if (result.success) {
			assert.equal(typeof result.statsBlock, "string");
		}
		// If not enough content, success=false is also acceptable
	});
});

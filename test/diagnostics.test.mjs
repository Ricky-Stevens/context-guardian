import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// diagnostics.mjs is a CLI script (not a module with exports).
// It reads env/args and writes JSON to stdout. We test it by spawning.

const DIAG_PATH = path.resolve("lib/diagnostics.mjs");

let tmpDir;
let dataDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-diag-"));
	dataDir = path.join(tmpDir, "data");
	fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runDiag(args = [], env = {}) {
	const stdout = execFileSync("node", [DIAG_PATH, ...args], {
		encoding: "utf8",
		timeout: 5000,
		env: {
			...process.env,
			CLAUDE_PLUGIN_DATA: dataDir,
			HOME: os.homedir(),
			...env,
		},
	});
	return JSON.parse(stdout);
}

// ===========================================================================
// Basic output structure
// ===========================================================================

describe("diagnostics output", () => {
	it("returns valid JSON with checks array", () => {
		const result = runDiag(["test-session"]);
		assert.ok(Array.isArray(result.checks));
		assert.ok(result.checks.length > 0);
	});

	it("each check has name, ok, and detail fields", () => {
		const result = runDiag(["test-session"]);
		for (const check of result.checks) {
			assert.ok(
				typeof check.name === "string",
				`name should be string: ${JSON.stringify(check)}`,
			);
			assert.ok(
				typeof check.ok === "boolean",
				`ok should be boolean: ${JSON.stringify(check)}`,
			);
			assert.ok(
				typeof check.detail === "string",
				`detail should be string: ${JSON.stringify(check)}`,
			);
		}
	});
});

// ===========================================================================
// data_dir check
// ===========================================================================

describe("data_dir check", () => {
	it("passes when data dir is writable", () => {
		const result = runDiag(["test-session"]);
		const check = result.checks.find((c) => c.name === "data_dir");
		assert.ok(check);
		assert.equal(check.ok, true);
		// detail contains whichever data dir the diagnostics resolved to
		assert.ok(typeof check.detail === "string" && check.detail.length > 0);
	});
});

// ===========================================================================
// state_file check
// ===========================================================================

describe("state_file check", () => {
	it("fails when state file is missing", () => {
		const result = runDiag(["nonexistent-session"]);
		const check = result.checks.find((c) => c.name === "state_file");
		assert.ok(check);
		assert.equal(check.ok, false);
	});

	it("passes when state file exists", () => {
		fs.writeFileSync(
			path.join(dataDir, "state-my-session.json"),
			JSON.stringify({ transcript_path: "/tmp/fake.jsonl" }),
		);
		const result = runDiag(["my-session"]);
		const check = result.checks.find((c) => c.name === "state_file");
		assert.ok(check);
		assert.equal(check.ok, true);
	});
});

// ===========================================================================
// transcript check
// ===========================================================================

describe("transcript check", () => {
	it("fails when no state file exists (skipped)", () => {
		const result = runDiag(["no-state"]);
		const check = result.checks.find((c) => c.name === "transcript");
		assert.ok(check);
		assert.equal(check.ok, false);
		assert.ok(
			check.detail.includes("no state file") ||
				check.detail.includes("Skipped"),
		);
	});

	it("passes when transcript file exists", () => {
		const transcriptPath = path.join(tmpDir, "transcript.jsonl");
		fs.writeFileSync(transcriptPath, "{}");
		fs.writeFileSync(
			path.join(dataDir, "state-tx-session.json"),
			JSON.stringify({ transcript_path: transcriptPath }),
		);
		const result = runDiag(["tx-session"]);
		const check = result.checks.find((c) => c.name === "transcript");
		assert.ok(check);
		assert.equal(check.ok, true);
	});

	it("fails when transcript path in state does not exist on disk", () => {
		fs.writeFileSync(
			path.join(dataDir, "state-bad-tx.json"),
			JSON.stringify({ transcript_path: "/nonexistent/path.jsonl" }),
		);
		const result = runDiag(["bad-tx"]);
		const check = result.checks.find((c) => c.name === "transcript");
		assert.ok(check);
		assert.equal(check.ok, false);
		assert.ok(check.detail.includes("Not found"));
	});
});

// ===========================================================================
// plugin_root check
// ===========================================================================

describe("plugin_root check", () => {
	it("passes (inferred from diagnostics.mjs location)", () => {
		const result = runDiag(["test-session"]);
		const check = result.checks.find((c) => c.name === "plugin_root");
		assert.ok(check);
		assert.equal(check.ok, true);
	});
});

// ===========================================================================
// hooks check
// ===========================================================================

describe("hooks check", () => {
	it("passes when all 4 hook files exist", () => {
		const result = runDiag(["test-session"]);
		const check = result.checks.find((c) => c.name === "hooks");
		assert.ok(check);
		assert.equal(check.ok, true);
		assert.ok(check.detail.includes("4 hook files"));
	});
});

// ===========================================================================
// Always exits 0
// ===========================================================================

describe("exit behaviour", () => {
	it("always exits 0 even with missing session", () => {
		// If it threw, execFileSync would throw too
		const result = runDiag(["completely-bogus-session-id"]);
		assert.ok(Array.isArray(result.checks));
	});
});

// In-process unit tests for lib/paths.mjs.
// Most callers are spawned hooks/CLIs; these tests exercise the helpers
// directly so SonarCloud sees coverage on the small pure functions.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	atomicWriteFileSync,
	ensureDataDir,
	resolveDataDir,
	resolveStatuslineStateDir,
	stateFile,
	statuslineStateFile,
} from "../lib/paths.mjs";

let tmpDir;
let prevPluginData;
let prevStateDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-paths-"));
	prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
	prevStateDir = process.env.CG_STATE_DIR;
});

afterEach(() => {
	if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
	else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
	if (prevStateDir === undefined) delete process.env.CG_STATE_DIR;
	else process.env.CG_STATE_DIR = prevStateDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveDataDir", () => {
	it("honours CLAUDE_PLUGIN_DATA when set", () => {
		process.env.CLAUDE_PLUGIN_DATA = tmpDir;
		assert.equal(resolveDataDir(), tmpDir);
	});

	it("falls back to ~/.claude/cg when env is unset", () => {
		delete process.env.CLAUDE_PLUGIN_DATA;
		assert.equal(resolveDataDir(), path.join(os.homedir(), ".claude", "cg"));
	});
});

describe("resolveStatuslineStateDir", () => {
	it("honours CG_STATE_DIR override (test isolation hook)", () => {
		process.env.CG_STATE_DIR = tmpDir;
		assert.equal(resolveStatuslineStateDir(), tmpDir);
	});

	it("does NOT honour CLAUDE_PLUGIN_DATA — that's the bug it fixes", () => {
		// Production setup: hooks always write to the canonical location;
		// CLAUDE_PLUGIN_DATA is for config, not for state-file lookup.
		delete process.env.CG_STATE_DIR;
		process.env.CLAUDE_PLUGIN_DATA = tmpDir;
		assert.equal(
			resolveStatuslineStateDir(),
			path.join(os.homedir(), ".claude", "cg"),
		);
	});

	it("falls back to ~/.claude/cg by default", () => {
		delete process.env.CG_STATE_DIR;
		assert.equal(
			resolveStatuslineStateDir(),
			path.join(os.homedir(), ".claude", "cg"),
		);
	});
});

describe("stateFile", () => {
	it("includes session id and lives in resolved data dir", () => {
		process.env.CLAUDE_PLUGIN_DATA = tmpDir;
		assert.equal(stateFile("abc-123"), path.join(tmpDir, "state-abc-123.json"));
	});

	it("uses 'unknown' placeholder when session id is empty", () => {
		process.env.CLAUDE_PLUGIN_DATA = tmpDir;
		assert.equal(stateFile(""), path.join(tmpDir, "state-unknown.json"));
		assert.equal(stateFile(undefined), path.join(tmpDir, "state-unknown.json"));
	});
});

describe("statuslineStateFile", () => {
	it("targets the resolved statusline state dir", () => {
		process.env.CG_STATE_DIR = tmpDir;
		assert.equal(
			statuslineStateFile("xyz"),
			path.join(tmpDir, "state-xyz.json"),
		);
	});

	it("uses 'unknown' placeholder for missing session id", () => {
		process.env.CG_STATE_DIR = tmpDir;
		assert.equal(
			statuslineStateFile(),
			path.join(tmpDir, "state-unknown.json"),
		);
	});
});

describe("ensureDataDir", () => {
	it("creates the resolved data dir when missing", () => {
		const subdir = path.join(tmpDir, "nested", "child");
		process.env.CLAUDE_PLUGIN_DATA = subdir;
		assert.ok(!fs.existsSync(subdir));
		ensureDataDir();
		assert.ok(fs.existsSync(subdir));
	});

	it("is idempotent when the dir already exists", () => {
		process.env.CLAUDE_PLUGIN_DATA = tmpDir;
		ensureDataDir();
		ensureDataDir(); // should not throw
		assert.ok(fs.existsSync(tmpDir));
	});
});

describe("atomicWriteFileSync", () => {
	it("writes content via tmp + rename", () => {
		const target = path.join(tmpDir, "out.json");
		atomicWriteFileSync(target, '{"hello":"world"}');
		assert.equal(fs.readFileSync(target, "utf8"), '{"hello":"world"}');
	});

	it("overwrites existing file atomically", () => {
		const target = path.join(tmpDir, "out.json");
		fs.writeFileSync(target, "old");
		atomicWriteFileSync(target, "new");
		assert.equal(fs.readFileSync(target, "utf8"), "new");
	});

	it("does not leave .tmp files behind on success", () => {
		const target = path.join(tmpDir, "out.json");
		atomicWriteFileSync(target, "data");
		const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
		assert.equal(leftovers.length, 0);
	});
});

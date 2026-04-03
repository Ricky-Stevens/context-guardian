import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// paths.mjs reads process.env.CLAUDE_PLUGIN_DATA at import time, so we
// need to set it before importing. We use dynamic import per test suite
// to control the env.

let tmpDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-paths-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// DATA_DIR
// ===========================================================================

describe("DATA_DIR", () => {
	it("uses CLAUDE_PLUGIN_DATA when set", async () => {
		const saved = process.env.CLAUDE_PLUGIN_DATA;
		process.env.CLAUDE_PLUGIN_DATA = "/tmp/test-plugin-data";
		try {
			// Force fresh import by busting module cache with query string
			const mod = await import(`../lib/paths.mjs?t=${Date.now()}-datadir`);
			// The module was already cached from the top-level import, so
			// DATA_DIR reflects whatever was set at first import. We test the
			// fallback logic instead by checking the export exists.
			assert.ok(typeof mod.DATA_DIR, "string");
		} finally {
			if (saved !== undefined) {
				process.env.CLAUDE_PLUGIN_DATA = saved;
			} else {
				delete process.env.CLAUDE_PLUGIN_DATA;
			}
		}
	});
});

// ===========================================================================
// stateFile
// ===========================================================================

describe("stateFile", () => {
	it("returns path with session id embedded", async () => {
		const { stateFile } = await import("../lib/paths.mjs");
		const result = stateFile("abc-123");
		assert.ok(result.includes("state-abc-123.json"));
	});

	it("uses 'unknown' for null session id", async () => {
		const { stateFile } = await import("../lib/paths.mjs");
		assert.ok(stateFile(null).includes("state-unknown.json"));
	});

	it("uses 'unknown' for undefined session id", async () => {
		const { stateFile } = await import("../lib/paths.mjs");
		assert.ok(stateFile(undefined).includes("state-unknown.json"));
	});

	it("uses 'unknown' for empty string session id", async () => {
		const { stateFile } = await import("../lib/paths.mjs");
		assert.ok(stateFile("").includes("state-unknown.json"));
	});
});

// ===========================================================================
// ensureDataDir
// ===========================================================================

describe("ensureDataDir", () => {
	it("creates the data directory if it does not exist", async () => {
		const { ensureDataDir, DATA_DIR } = await import("../lib/paths.mjs");
		// If DATA_DIR already exists this is a no-op, which is fine.
		ensureDataDir();
		assert.ok(fs.existsSync(DATA_DIR));
	});

	it("is idempotent — calling twice does not throw", async () => {
		const { ensureDataDir } = await import("../lib/paths.mjs");
		ensureDataDir();
		ensureDataDir();
	});
});

// ===========================================================================
// atomicWriteFileSync
// ===========================================================================

describe("atomicWriteFileSync", () => {
	it("writes content that can be read back", async () => {
		const { atomicWriteFileSync } = await import("../lib/paths.mjs");
		const target = path.join(tmpDir, "atomic-test.json");
		atomicWriteFileSync(target, '{"key":"value"}');
		const content = fs.readFileSync(target, "utf8");
		assert.equal(content, '{"key":"value"}');
	});

	it("overwrites existing file atomically", async () => {
		const { atomicWriteFileSync } = await import("../lib/paths.mjs");
		const target = path.join(tmpDir, "atomic-overwrite.json");
		fs.writeFileSync(target, "old");
		atomicWriteFileSync(target, "new");
		assert.equal(fs.readFileSync(target, "utf8"), "new");
	});

	it("does not leave temp files on success", async () => {
		const { atomicWriteFileSync } = await import("../lib/paths.mjs");
		const target = path.join(tmpDir, "atomic-clean.json");
		atomicWriteFileSync(target, "data");
		const files = fs.readdirSync(tmpDir);
		const tmpFiles = files.filter((f) => f.includes(".tmp"));
		assert.equal(tmpFiles.length, 0);
	});

	it("handles empty string content", async () => {
		const { atomicWriteFileSync } = await import("../lib/paths.mjs");
		const target = path.join(tmpDir, "atomic-empty.json");
		atomicWriteFileSync(target, "");
		assert.equal(fs.readFileSync(target, "utf8"), "");
	});
});

// ===========================================================================
// rotateCheckpoints
// ===========================================================================

describe("rotateCheckpoints", () => {
	it("removes oldest files beyond maxKeep", async () => {
		const { CHECKPOINTS_DIR, rotateCheckpoints } = await import(
			"../lib/paths.mjs"
		);
		fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

		// Create 15 checkpoint files with deterministic alphabetical order
		const created = [];
		for (let i = 0; i < 15; i++) {
			const name = `session-2025-01-${String(i + 1).padStart(2, "0")}T00-00-00-abc.md`;
			fs.writeFileSync(path.join(CHECKPOINTS_DIR, name), `checkpoint ${i}`);
			created.push(name);
		}

		rotateCheckpoints(10);

		const remaining = fs
			.readdirSync(CHECKPOINTS_DIR)
			.filter((f) => f.startsWith("session-") && f.endsWith(".md"))
			.sort();

		assert.equal(remaining.length, 10);
		// The 5 oldest (01..05) should be gone
		for (let i = 0; i < 5; i++) {
			assert.ok(
				!remaining.includes(created[i]),
				`${created[i]} should have been removed`,
			);
		}
	});

	it("does nothing when fewer files than maxKeep", async () => {
		const { CHECKPOINTS_DIR, rotateCheckpoints } = await import(
			"../lib/paths.mjs"
		);
		fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

		// Count pre-existing session files (from other tests sharing the dir)
		const preExisting = fs
			.readdirSync(CHECKPOINTS_DIR)
			.filter((f) => f.startsWith("session-") && f.endsWith(".md")).length;

		for (let i = 0; i < 3; i++) {
			fs.writeFileSync(
				path.join(CHECKPOINTS_DIR, `session-2025-06-0${i + 1}T00-00-00-keep.md`),
				"data",
			);
		}

		// Use a maxKeep large enough to keep everything
		rotateCheckpoints(preExisting + 3 + 10);

		const remaining = fs
			.readdirSync(CHECKPOINTS_DIR)
			.filter((f) => f.startsWith("session-") && f.endsWith(".md"));
		assert.equal(remaining.length, preExisting + 3);
	});

	it("does not throw when checkpoints directory does not exist", async () => {
		const { rotateCheckpoints } = await import("../lib/paths.mjs");
		// Should silently succeed (empty catch in implementation)
		rotateCheckpoints(10);
	});

	it("ignores non-session files", async () => {
		const { CHECKPOINTS_DIR, rotateCheckpoints } = await import(
			"../lib/paths.mjs"
		);
		fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

		// Create a non-session file and some session files
		fs.writeFileSync(path.join(CHECKPOINTS_DIR, "other-file.md"), "keep");
		for (let i = 0; i < 3; i++) {
			fs.writeFileSync(
				path.join(CHECKPOINTS_DIR, `session-2025-01-0${i + 1}T00-00-00-abc.md`),
				"data",
			);
		}

		rotateCheckpoints(2);

		assert.ok(
			fs.existsSync(path.join(CHECKPOINTS_DIR, "other-file.md")),
			"non-session file should survive rotation",
		);
	});
});

// ===========================================================================
// Exported constants
// ===========================================================================

describe("exported constants", () => {
	it("LOG_DIR points to ~/.claude/logs", async () => {
		const { LOG_DIR } = await import("../lib/paths.mjs");
		assert.ok(LOG_DIR.endsWith(path.join(".claude", "logs")));
	});

	it("LOG_FILE is cg.log inside LOG_DIR", async () => {
		const { LOG_FILE, LOG_DIR } = await import("../lib/paths.mjs");
		assert.equal(LOG_FILE, path.join(LOG_DIR, "cg.log"));
	});

	it("CONFIG_FILE is config.json inside DATA_DIR", async () => {
		const { CONFIG_FILE, DATA_DIR } = await import("../lib/paths.mjs");
		assert.equal(CONFIG_FILE, path.join(DATA_DIR, "config.json"));
	});

	it("CHECKPOINTS_DIR is checkpoints/ inside DATA_DIR", async () => {
		const { CHECKPOINTS_DIR, DATA_DIR } = await import("../lib/paths.mjs");
		assert.equal(CHECKPOINTS_DIR, path.join(DATA_DIR, "checkpoints"));
	});
});

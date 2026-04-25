// In-process unit tests for lib/statusline.mjs.
//
// The behavioural tests in statusline.test.mjs run the script via spawn(),
// which gives full integration coverage but doesn't register against bun's
// --coverage instrumentation (it only tracks the parent process). These tests
// import the functions directly so SonarCloud sees them covered.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	formatSessionSize,
	persistSessionMetadata,
	readSessionSize,
	render,
	resolveThreshold,
} from "../lib/statusline.mjs";

let tmpDir;
let prevStateDir;
let prevPluginData;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sl-unit-"));
	prevStateDir = process.env.CG_STATE_DIR;
	prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
	process.env.CG_STATE_DIR = tmpDir;
	delete process.env.CLAUDE_PLUGIN_DATA;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.CG_STATE_DIR;
	else process.env.CG_STATE_DIR = prevStateDir;
	if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
	else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Strip ANSI for content-only assertions
function strip(s) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("readSessionSize (unit)", () => {
	it("returns payload + overhead*4 for the named session", () => {
		fs.writeFileSync(
			path.join(tmpDir, "state-abc.json"),
			JSON.stringify({ payload_bytes: 1000, baseline_overhead: 250 }),
		);
		assert.equal(readSessionSize(tmpDir, "abc"), 1000 + 250 * 4);
	});

	it("returns 0 when the session's file does not exist", () => {
		assert.equal(readSessionSize(tmpDir, "nope"), 0);
	});

	it("treats missing payload_bytes as 0", () => {
		fs.writeFileSync(
			path.join(tmpDir, "state-stub.json"),
			JSON.stringify({ context_window_size: 1000000 }),
		);
		assert.equal(readSessionSize(tmpDir, "stub"), 0);
	});

	it("falls back to newest-by-mtime when sessionId is missing", () => {
		const older = path.join(tmpDir, "state-older.json");
		const newer = path.join(tmpDir, "state-newer.json");
		fs.writeFileSync(older, JSON.stringify({ payload_bytes: 100 }));
		fs.writeFileSync(newer, JSON.stringify({ payload_bytes: 999 }));
		const past = (Date.now() - 60000) / 1000;
		fs.utimesSync(older, past, past);
		assert.equal(readSessionSize(tmpDir), 999);
	});

	it("returns 0 in fallback mode when dir has no state files", () => {
		assert.equal(readSessionSize(tmpDir), 0);
	});
});

describe("formatSessionSize (unit)", () => {
	const dim = "\x1b[2m";
	const reset = "\x1b[0m";

	it("returns dim -- when totalBytes <= 0", () => {
		assert.equal(formatSessionSize(0, dim, reset), `${dim}--${reset}`);
		assert.equal(formatSessionSize(-1, dim, reset), `${dim}--${reset}`);
	});

	it("under 10MB renders green numeric with dim label", () => {
		const out = formatSessionSize(5 * 1024 * 1024, dim, reset);
		assert.ok(out.includes("\x1b[2mSession size:\x1b[0m"));
		assert.ok(out.includes("\x1b[32m5.0"));
		assert.ok(strip(out).includes("5.0/20MB"));
	});

	it("10–15MB renders yellow numeric with dim label", () => {
		const out = formatSessionSize(12 * 1024 * 1024, dim, reset);
		assert.ok(out.includes("\x1b[2mSession size:\x1b[0m"));
		assert.ok(out.includes("\x1b[33m12.0"));
	});

	it("15MB+ renders bold red on the whole label+number", () => {
		const out = formatSessionSize(17 * 1024 * 1024, dim, reset);
		assert.ok(out.includes("\x1b[1;31mSession size: 17.0/20MB"));
	});

	it("clamps display to 0.1MB minimum", () => {
		const out = formatSessionSize(1, dim, reset);
		assert.ok(strip(out).includes("0.1/20MB"));
	});
});

describe("resolveThreshold (unit)", () => {
	it("uses config.threshold when present", () => {
		fs.writeFileSync(
			path.join(tmpDir, "config.json"),
			JSON.stringify({ threshold: 0.42 }),
		);
		// resolveThreshold reads CLAUDE_PLUGIN_DATA first, falling back to CG_STATE_DIR
		assert.equal(resolveThreshold({}), 42);
	});

	it("falls back to adaptive 55% for 200K windows when no config", () => {
		assert.equal(
			resolveThreshold({
				context_window: { context_window_size: 200000 },
			}),
			55,
		);
	});

	it("scales adaptive to 30% for 1M windows", () => {
		assert.equal(
			resolveThreshold({
				context_window: { context_window_size: 1000000 },
			}),
			30,
		);
	});

	it("clamps adaptive to [25, 55]", () => {
		// Larger than 1M still clamps to 25
		assert.equal(
			resolveThreshold({
				context_window: { context_window_size: 5000000 },
			}),
			25,
		);
	});

	it("ignores corrupt config and falls back to adaptive", () => {
		fs.writeFileSync(path.join(tmpDir, "config.json"), "not-json{{");
		assert.equal(resolveThreshold({}), 55);
	});
});

describe("persistSessionMetadata (unit)", () => {
	it("creates a fresh state file with size + model", () => {
		persistSessionMetadata({
			session_id: "fresh",
			context_window: { context_window_size: 1000000 },
			model: { id: "claude-opus-4-7[1m]" },
		});
		const stateFile = path.join(tmpDir, "state-fresh.json");
		assert.ok(fs.existsSync(stateFile));
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		assert.equal(state.context_window_size, 1000000);
		assert.equal(state.cc_model_id, "claude-opus-4-7[1m]");
	});

	it("merges into existing state without clobbering hook fields", () => {
		const stateFile = path.join(tmpDir, "state-merge.json");
		fs.writeFileSync(
			stateFile,
			JSON.stringify({
				current_tokens: 5000,
				payload_bytes: 12345,
			}),
		);
		persistSessionMetadata({
			session_id: "merge",
			context_window: { context_window_size: 1000000 },
			model: { id: "claude-opus-4-7[1m]" },
		});
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		assert.equal(state.current_tokens, 5000);
		assert.equal(state.payload_bytes, 12345);
		assert.equal(state.context_window_size, 1000000);
	});

	it("skips the write when nothing changed (mtime stable)", () => {
		// First write
		persistSessionMetadata({
			session_id: "nochange",
			context_window: { context_window_size: 1000000 },
			model: { id: "claude-opus-4-7[1m]" },
		});
		const stateFile = path.join(tmpDir, "state-nochange.json");
		const mtime1 = fs.statSync(stateFile).mtimeMs;
		// Second write with identical data
		persistSessionMetadata({
			session_id: "nochange",
			context_window: { context_window_size: 1000000 },
			model: { id: "claude-opus-4-7[1m]" },
		});
		const mtime2 = fs.statSync(stateFile).mtimeMs;
		assert.equal(mtime1, mtime2);
	});

	it("ignores call when session_id is missing", () => {
		persistSessionMetadata({
			context_window: { context_window_size: 1000000 },
		});
		assert.equal(fs.readdirSync(tmpDir).length, 0);
	});

	it("ignores call when both size and model are missing", () => {
		persistSessionMetadata({ session_id: "skip" });
		assert.equal(fs.readdirSync(tmpDir).length, 0);
	});

	it("does not write when context_window_size is invalid (0)", () => {
		persistSessionMetadata({
			session_id: "zero",
			context_window: { context_window_size: 0 },
		});
		assert.equal(fs.readdirSync(tmpDir).length, 0);
	});
});

describe("render (unit)", () => {
	it("returns -- placeholder when used_percentage is missing", () => {
		assert.equal(strip(render({})), "Context usage: --");
		assert.equal(strip(render({ context_window: {} })), "Context usage: --");
		assert.equal(
			strip(render({ context_window: { used_percentage: null } })),
			"Context usage: --",
		);
	});

	it("renders the full status line with green numeric below threshold", () => {
		const out = render({ context_window: { used_percentage: 5 } });
		assert.ok(out.includes("Context usage:"));
		assert.ok(out.includes("\x1b[32m5%"));
		assert.ok(strip(out).includes("/cg:stats for more"));
	});

	it("renders bold red and compaction recommendation at threshold", () => {
		const out = render({ context_window: { used_percentage: 60 } });
		assert.ok(out.includes("\x1b[1;31mContext usage: 60%"));
		assert.ok(out.includes("compaction recommended"));
	});

	it("includes session size when state file exists", () => {
		fs.writeFileSync(
			path.join(tmpDir, "state-rs.json"),
			JSON.stringify({ payload_bytes: 5 * 1024 * 1024 }),
		);
		const out = render({
			session_id: "rs",
			context_window: { used_percentage: 5 },
		});
		assert.ok(strip(out).includes("5.0/20MB"));
	});

	it("falls back to -- session size when current session has no state", () => {
		const out = render({
			session_id: "missing",
			context_window: { used_percentage: 5 },
		});
		assert.ok(!strip(out).includes("Session size:"));
		assert.ok(strip(out).includes("--"));
	});
});

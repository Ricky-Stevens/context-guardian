import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, before, describe, it } from "node:test";

// DATA_DIR is computed at module load time from process.env.CLAUDE_PLUGIN_DATA,
// so we must set the env var BEFORE importing checkpoint.mjs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-checkpoint-test-"));
process.env.CLAUDE_PLUGIN_DATA = tmpDir;

const { writeCompactionState } = await import("../lib/checkpoint.mjs");

function stateFilePath(sessionId) {
	return path.join(tmpDir, `state-${sessionId}.json`);
}

function readState(sessionId) {
	return JSON.parse(fs.readFileSync(stateFilePath(sessionId), "utf-8"));
}

// Clean up state files between tests (but keep the tmpDir)
afterEach(() => {
	for (const f of fs.readdirSync(tmpDir)) {
		if (f.startsWith("state-")) {
			fs.unlinkSync(path.join(tmpDir, f));
		}
	}
	// Also remove config.json if it was written by a test
	const configPath = path.join(tmpDir, "config.json");
	if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
});

// Clean up the tmpDir after all tests
before(() => {
	process.on("exit", () => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("writeCompactionState", () => {
	it("writes state file with correct computed fields", () => {
		writeCompactionState(
			"sess1",
			"/tmp/transcript.jsonl",
			50000,
			200000,
			"Smart Compact",
		);

		const state = readState("sess1");
		assert.equal(state.current_tokens, 50000);
		assert.equal(state.max_tokens, 200000);
		assert.equal(state.pct, 0.25);
		assert.equal(state.pct_display, "25.0");
		// Default threshold is 0.35: headroom = max(0, round(200000 * 0.35 - 50000)) = 20000
		assert.equal(state.headroom, 20000);
		assert.equal(state.source, "estimated");
		assert.equal(state.recommendation, "Smart Compact");
		assert.equal(state.transcript_path, "/tmp/transcript.jsonl");
		assert.equal(state.session_id, "sess1");
		assert.equal(state.model, "unknown");
		assert.equal(state.smart_estimate_pct, 0);
		assert.equal(state.recent_estimate_pct, 0);
		assert.equal(typeof state.ts, "number");
	});

	it("writes threshold and threshold_display from loaded config", () => {
		// loadConfig() caches on first call; since no config.json existed at
		// import time, the default threshold (0.35) is used for all tests.
		writeCompactionState("sess2", "/tmp/t.jsonl", 60000, 200000, "Keep Recent");

		const state = readState("sess2");
		assert.equal(state.threshold, 0.35);
		assert.equal(state.threshold_display, 35);
		// headroom = max(0, round(200000 * 0.35 - 60000)) = 10000
		assert.equal(state.headroom, 10000);
	});

	it("carries forward baseline_overhead from existing state file", () => {
		fs.writeFileSync(
			stateFilePath("sess4"),
			JSON.stringify({ baseline_overhead: 42000, current_tokens: 100000 }),
		);

		writeCompactionState(
			"sess4",
			"/tmp/t.jsonl",
			30000,
			200000,
			"Smart Compact",
		);

		const state = readState("sess4");
		assert.equal(state.baseline_overhead, 42000);
	});

	it("defaults baseline_overhead to 0 when no existing state", () => {
		writeCompactionState(
			"sess5",
			"/tmp/t.jsonl",
			30000,
			200000,
			"Smart Compact",
		);

		const state = readState("sess5");
		assert.equal(state.baseline_overhead, 0);
	});

	it("defaults baseline_overhead to 0 when existing state lacks the field", () => {
		fs.writeFileSync(
			stateFilePath("sess6"),
			JSON.stringify({ current_tokens: 100000 }),
		);

		writeCompactionState(
			"sess6",
			"/tmp/t.jsonl",
			30000,
			200000,
			"Smart Compact",
		);

		const state = readState("sess6");
		assert.equal(state.baseline_overhead, 0);
	});

	it("handles corrupt existing state file gracefully", () => {
		fs.writeFileSync(stateFilePath("sess7"), "not json at all{{{");

		// Inner try/catch handles corrupt JSON, falls back to baseline_overhead=0
		writeCompactionState(
			"sess7",
			"/tmp/t.jsonl",
			30000,
			200000,
			"Smart Compact",
		);

		const state = readState("sess7");
		assert.equal(state.current_tokens, 30000);
		assert.equal(state.baseline_overhead, 0);
	});

	it("has source set to estimated", () => {
		writeCompactionState(
			"sess8",
			"/tmp/t.jsonl",
			10000,
			200000,
			"Smart Compact",
		);

		const state = readState("sess8");
		assert.equal(state.source, "estimated");
	});

	it("handles max=0 without throwing", () => {
		// tokens/max = Infinity, but JSON.stringify handles Infinity → null
		writeCompactionState("sess9", "/tmp/t.jsonl", 10000, 0, "Smart Compact");

		const state = readState("sess9");
		assert.equal(state.current_tokens, 10000);
		assert.equal(state.max_tokens, 0);
		// pct: 10000/0 = Infinity, JSON serializes to null
		assert.equal(state.pct, null);
		// headroom: Math.max(0, Math.round(0 * 0.35 - 10000)) = 0
		assert.equal(state.headroom, 0);
	});
});

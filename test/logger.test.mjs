import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// logger.mjs imports LOG_DIR and LOG_FILE from paths.mjs which reads
// CLAUDE_PLUGIN_DATA at import time. We can't easily redirect the log
// file, so we test via the real log file location. The log function is
// designed to never throw, so these tests verify behaviour + safety.

// We import once and test the singleton behaviour.
import { log } from "../lib/logger.mjs";
import { LOG_FILE, LOG_DIR } from "../lib/paths.mjs";

// ===========================================================================
// log()
// ===========================================================================

describe("log", () => {
	it("writes a line to the log file", () => {
		const marker = `test-marker-${Date.now()}-${Math.random()}`;
		log(marker);
		const content = fs.readFileSync(LOG_FILE, "utf8");
		assert.ok(content.includes(marker));
	});

	it("prepends an ISO timestamp", () => {
		const marker = `ts-check-${Date.now()}`;
		log(marker);
		const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
		const line = lines.find((l) => l.includes(marker));
		assert.ok(line, "log line should exist");
		// Format: [2025-01-01T00:00:00.000Z] message
		assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it("appends a newline after each message", () => {
		const marker = `newline-check-${Date.now()}`;
		log(marker);
		const content = fs.readFileSync(LOG_FILE, "utf8");
		assert.ok(content.includes(`${marker}\n`));
	});

	it("creates LOG_DIR if it does not exist", () => {
		// LOG_DIR should exist after calling log (it's created lazily)
		log("dir-check");
		assert.ok(fs.existsSync(LOG_DIR));
	});

	it("does not throw on empty message", () => {
		log("");
	});

	it("does not throw on null message", () => {
		log(null);
	});

	it("does not throw on undefined message", () => {
		log(undefined);
	});

	it("does not throw on object message", () => {
		log({ key: "value" });
	});

	it("handles multiple rapid calls without error", () => {
		for (let i = 0; i < 50; i++) {
			log(`rapid-${i}`);
		}
	});
});

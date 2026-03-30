import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { log } from "../lib/logger.mjs";
import {
	atomicWriteFileSync,
	CHECKPOINTS_DIR,
	ensureDataDir,
	rotateCheckpoints,
	stateFile,
} from "../lib/paths.mjs";
import { getTokenUsage } from "../lib/tokens.mjs";
import {
	extractConversation,
	extractRecent,
	readTranscriptLines,
} from "../lib/transcript.mjs";

const HOOK_PATH = path.resolve("hooks/submit.mjs");

let tmpDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-edge-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// submit.mjs — stdin parse error (lines 25-29)
// =========================================================================
describe("submit hook — invalid stdin", () => {
	it("exits 0 with no output on invalid JSON stdin", () => {
		try {
			const stdout = execFileSync("node", [HOOK_PATH], {
				input: "NOT VALID JSON{{{",
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir },
			});
			assert.equal(stdout.trim(), "");
		} catch (e) {
			assert.equal(e.status, 0);
		}
	});
});

// =========================================================================
// submit.mjs — corrupt config uses defaults (config.mjs lines 22-23)
// =========================================================================
describe("submit hook — corrupt config", () => {
	it("uses defaults when config.json is corrupt", () => {
		const cwd2 = path.join(tmpDir, "proj-corrupt-cfg");
		const dataDir2 = path.join(tmpDir, "data-corrupt-cfg");
		fs.mkdirSync(path.join(cwd2, ".claude"), { recursive: true });
		fs.mkdirSync(dataDir2, { recursive: true });

		fs.writeFileSync(path.join(dataDir2, "config.json"), "NOT{JSON");

		const tp = path.join(tmpDir, "transcript-corrupt-cfg.jsonl");
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					model: "claude-sonnet-4-20250514",
					content: [{ type: "text", text: "hi" }],
					usage: {
						input_tokens: 5,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						output_tokens: 2,
					},
				},
			})}\n`,
		);

		try {
			execFileSync("node", [HOOK_PATH], {
				input: JSON.stringify({
					session_id: "cfg-test",
					prompt: "hi",
					transcript_path: tp,
					cwd: cwd2,
				}),
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir2 },
			});
		} catch (e) {
			if (e.status !== 0) throw e;
		}
		// Should write state file using defaults (didn't crash)
		assert.ok(fs.existsSync(path.join(dataDir2, "state-cfg-test.json")));
	});
});

// =========================================================================
// transcript.mjs — large file tail read (lines 22-34)
// =========================================================================
describe("transcript — large file tail read", () => {
	it("reads full transcript under 50MB cap", () => {
		const tp = path.join(tmpDir, "large-transcript.jsonl");

		const oldLine = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: "old message preserved under 50MB cap",
			},
		});

		const paddingLine = JSON.stringify({
			type: "system",
			message: { content: "x".repeat(150) },
		});

		let content = `${oldLine}\n`;
		// 11MB file — well under the 50MB cap, so ALL content is preserved
		const lines = Math.ceil((11 * 1024 * 1024) / (paddingLine.length + 1));
		for (let i = 0; i < lines; i++) {
			content += `${paddingLine}\n`;
		}
		content += `${JSON.stringify({
			type: "user",
			message: { role: "user", content: "this is the recent message" },
		})}\n`;

		fs.writeFileSync(tp, content);

		const result = extractConversation(tp);
		assert.ok(result.includes("User: this is the recent message"));
		// Under the 50MB cap, old content is preserved (not tail-dropped)
		assert.ok(result.includes("old message preserved under 50MB cap"));
	});
});

// =========================================================================
// tokens.mjs — tiered read returns null for large file with no usage (line 43)
// =========================================================================
describe("tokens — tiered read exhaustion", () => {
	it("returns null for >32KB transcript with no usage data", () => {
		const tp = path.join(tmpDir, "large-no-usage.jsonl");
		const line = JSON.stringify({
			type: "user",
			message: { role: "user", content: "x".repeat(500) },
		});
		let content = "";
		for (let i = 0; i < 60; i++) {
			content += `${line}\n`;
		}
		fs.writeFileSync(tp, content);

		const result = getTokenUsage(tp);
		assert.equal(result, null);
	});
});

// =========================================================================
// transcript.mjs — extractRecent skill injection filter (line 194)
// =========================================================================
describe("extractRecent — skill injection filter", () => {
	it("filters known skill injection messages in extractRecent", () => {
		const tp = path.join(tmpDir, "recent-skill.jsonl");
		// New injection filter matches messages containing both "SKILL.md" and "plugin"
		const skillContent =
			"# Skill Title\n\nInstructions from SKILL.md for this plugin.\n\n## Step 1\n\nDo this.\n\n## Step 2\n\nDo that.\n\n" +
			"x".repeat(800);
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: skillContent },
			})}\n`,
		);
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: "real message" },
			})}\n`,
		);

		const result = extractRecent(tp, 20);
		assert.ok(!result.includes("Skill Title"));
		assert.ok(result.includes("User: real message"));
	});
});

// =========================================================================
// transcript.mjs — extractRecent parse errors (lines 154-156)
// =========================================================================
describe("extractRecent — parse errors", () => {
	it("counts and reports parse errors", () => {
		const tp = path.join(tmpDir, "recent-errors.jsonl");
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: "good" },
			})}\n`,
		);
		fs.appendFileSync(tp, "bad json line\n");
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "response" }],
				},
			})}\n`,
		);

		const result = extractRecent(tp, 20);
		assert.ok(result.includes("User: good"));
		assert.ok(result.includes("Asst: response"));
		assert.ok(result.includes("Warning: 1 transcript line(s)"));
	});
});

// =========================================================================
// transcript.mjs — extractRecent compact marker filter (line 145)
// =========================================================================
describe("extractRecent — compact marker filtering", () => {
	it("filters # Context Checkpoint markers", () => {
		const tp = path.join(tmpDir, "recent-checkpoint.jsonl");
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content:
						"# Context Checkpoint (Smart Compact)\n> Created: 2026\n\nUser: old",
				},
			})}\n`,
		);
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: "real message" },
			})}\n`,
		);

		const result = extractRecent(tp, 20);
		assert.ok(!result.includes("Context Checkpoint"));
		assert.ok(result.includes("User: real message"));
	});
});

// =========================================================================
// config.mjs — unit tests
// =========================================================================
describe("config — loadConfig and resolveMaxTokens", () => {
	it("loadConfig returns defaults", () => {
		const cfg = loadConfig();
		assert.equal(typeof cfg.threshold, "number");
		assert.equal(typeof cfg.max_tokens, "number");
	});

	it("resolveMaxTokens returns a positive number", () => {
		const mt = resolveMaxTokens();
		assert.equal(typeof mt, "number");
		assert.ok(mt > 0);
	});
});

// =========================================================================
// tokens.mjs — tiered read: both tiers exhausted (line 43)
// Need a file >2MB with no usage data so both 32KB and 2MB tiers fail.
// =========================================================================
describe("tokens — both read tiers exhausted", () => {
	it("returns null for >2MB transcript with no usage data", () => {
		const tp = path.join(tmpDir, "huge-no-usage.jsonl");
		const line = JSON.stringify({
			type: "user",
			message: { role: "user", content: "x".repeat(2000) },
		});
		// ~2KB per line, need ~1100 lines for >2MB
		const fd = fs.openSync(tp, "w");
		for (let i = 0; i < 1100; i++) {
			fs.writeSync(fd, `${line}\n`);
		}
		fs.closeSync(fd);

		const result = getTokenUsage(tp);
		assert.equal(result, null);
	});
});

// =========================================================================
// paths.mjs — || fallback branches
// =========================================================================
describe("paths — fallback branches", () => {
	it("stateFile handles null sessionId", () => {
		const result = stateFile(null);
		assert.ok(result.includes("state-unknown.json"));
	});

	it("stateFile handles undefined sessionId", () => {
		const result = stateFile(undefined);
		assert.ok(result.includes("state-unknown.json"));
	});

	it("stateFile handles empty string sessionId", () => {
		const result = stateFile("");
		assert.ok(result.includes("state-unknown.json"));
	});

	it("stateFile handles valid sessionId", () => {
		const result = stateFile("abc-123");
		assert.ok(result.includes("state-abc-123.json"));
	});

	it("ensureDataDir does not throw", () => {
		ensureDataDir();
		assert.ok(true);
	});
});

// =========================================================================
// transcript.mjs — extractRecent: long heading message WITHOUT sub-headings
// Hits the || [] fallback when regex match returns null
// =========================================================================
describe("extractRecent — long heading no sub-headings", () => {
	it("keeps long heading message without sub-headings", () => {
		const tp = path.join(tmpDir, "recent-long-heading.jsonl");
		const longMsg =
			"# My Big Plan\n\n" +
			"Some content without any sub-headings at all. ".repeat(25);
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: longMsg },
			})}\n`,
		);

		const result = extractRecent(tp, 20);
		assert.ok(result.includes("# My Big Plan"));
	});
});

// =========================================================================
// transcript.mjs — extractRecent: assistant with string content (not array)
// =========================================================================
describe("extractRecent — assistant string content", () => {
	it("handles assistant message with string content", () => {
		const tp = path.join(tmpDir, "recent-string-content.jsonl");
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: "hello there" },
			})}\n`,
		);
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: "plain string response" },
			})}\n`,
		);

		const result = extractRecent(tp, 20);
		assert.ok(result.includes("Asst: plain string response"));
	});
});

// =========================================================================
// transcript.mjs — extractConversation: assistant with string content
// =========================================================================
describe("extractConversation — assistant string content", () => {
	it("handles assistant message with string content", () => {
		const tp = path.join(tmpDir, "conv-string-content.jsonl");
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: "hello" },
			})}\n`,
		);
		fs.appendFileSync(
			tp,
			`${JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: "plain string response" },
			})}\n`,
		);

		const result = extractConversation(tp);
		assert.ok(result.includes("Asst: plain string response"));
	});
});

// =========================================================================
// paths.mjs — rotateCheckpoints
// =========================================================================
describe("paths — rotateCheckpoints", () => {
	it("does not crash when checkpoints dir does not exist", () => {
		rotateCheckpoints(10);
		assert.ok(true);
	});
});

// =========================================================================
// logger.mjs — basic functionality
// =========================================================================
describe("logger", () => {
	it("log function works without error", () => {
		log("test message from edge-cases.test.mjs");
		assert.ok(true);
	});

	it("log function works on second call (logDirReady cache)", () => {
		log("first call");
		log("second call — should skip mkdir");
		assert.ok(true);
	});

	it("log rotates when file exceeds 5MB", () => {
		const logFile = path.join(os.homedir(), ".claude", "logs", "cg.log");
		const rotated = `${logFile}.1`;
		// Write >5MB to trigger rotation
		const bigContent = "x".repeat(5.1 * 1024 * 1024);
		fs.writeFileSync(logFile, bigContent);
		log("trigger rotation");
		// After rotation, the current log should be small (just our message)
		const size = fs.statSync(logFile).size;
		assert.ok(size < 1024 * 1024, `Log should be small after rotation, got ${size}`);
		// Rotated file should exist
		assert.ok(fs.existsSync(rotated), "Rotated log file should exist");
		// Clean up
		try {
			fs.unlinkSync(rotated);
		} catch {}
	});
});

// =========================================================================
// paths.mjs — atomicWriteFileSync
// =========================================================================
describe("atomicWriteFileSync", () => {
	it("writes data atomically", () => {
		const target = path.join(tmpDir, "atomic-test.txt");
		atomicWriteFileSync(target, "hello world");
		assert.equal(fs.readFileSync(target, "utf8"), "hello world");
	});

	it("overwrites existing file atomically", () => {
		const target = path.join(tmpDir, "atomic-overwrite.txt");
		fs.writeFileSync(target, "old content");
		atomicWriteFileSync(target, "new content");
		assert.equal(fs.readFileSync(target, "utf8"), "new content");
	});

	it("does not leave temp files on success", () => {
		const target = path.join(tmpDir, "atomic-clean.txt");
		atomicWriteFileSync(target, "data");
		const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
		assert.equal(tmpFiles.length, 0, "No temp files should remain");
	});
});

// =========================================================================
// paths.mjs — rotateCheckpoints
// =========================================================================
describe("rotateCheckpoints", () => {
	it("keeps only maxKeep files", () => {
		const cpDir = CHECKPOINTS_DIR;
		fs.mkdirSync(cpDir, { recursive: true });
		// Create 15 checkpoint files
		for (let i = 0; i < 15; i++) {
			const ts = `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00`;
			fs.writeFileSync(
				path.join(cpDir, `session-${ts}-abc${i}.md`),
				`checkpoint ${i}`,
			);
		}
		rotateCheckpoints(10);
		const remaining = fs
			.readdirSync(cpDir)
			.filter((f) => f.startsWith("session-") && f.endsWith(".md"));
		assert.equal(remaining.length, 10, "Should keep only 10 checkpoints");
		// The newest 10 should remain (highest dates)
		assert.ok(
			remaining.some((f) => f.includes("2026-01-15")),
			"Newest should survive",
		);
		assert.ok(
			!remaining.some((f) => f.includes("2026-01-01")),
			"Oldest should be deleted",
		);
		// Clean up
		for (const f of remaining) {
			try {
				fs.unlinkSync(path.join(cpDir, f));
			} catch {}
		}
	});
});

// =========================================================================
// transcript.mjs — large file tiered read fallback
// =========================================================================
describe("readTranscriptLines — large file path", () => {
	it("reads tail of large transcript file", () => {
		const tp = path.join(tmpDir, "large-transcript.jsonl");
		// Write a moderately sized file to test readTranscriptLines
		const lines = [];
		for (let i = 0; i < 500; i++) {
			lines.push(
				JSON.stringify({
					type: "user",
					message: { role: "user", content: `message ${i}` },
				}),
			);
		}
		fs.writeFileSync(tp, lines.join("\n") + "\n");
		const result = readTranscriptLines(tp);
		assert.ok(result.length >= 400, `Should read many lines, got ${result.length}`);
		// Last line should be the most recent message
		assert.ok(
			result[result.length - 1].includes("message 499"),
			"Should include last message",
		);
	});
});

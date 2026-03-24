import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { log } from "../lib/logger.mjs";
import {
	CHECKPOINTS_DIR,
	ensureDataDir,
	projectStateFiles,
	rotateCheckpoints,
	sessionFlags,
	stateFile,
} from "../lib/paths.mjs";
import { getTokenUsage } from "../lib/tokens.mjs";
import { extractConversation, extractRecent } from "../lib/transcript.mjs";

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
// submit.mjs — corrupt reload file (lines 526-530)
// =========================================================================
describe("submit hook — corrupt reload file", () => {
	it("cleans up corrupt reload file and continues", () => {
		const cwd2 = path.join(tmpDir, "project");
		const dataDir2 = path.join(tmpDir, "data");
		fs.mkdirSync(path.join(cwd2, ".claude"), { recursive: true });
		fs.mkdirSync(dataDir2, { recursive: true });
		const h = crypto
			.createHash("sha256")
			.update(cwd2)
			.digest("hex")
			.slice(0, 8);

		fs.writeFileSync(path.join(dataDir2, `reload-${h}.json`), "CORRUPT{{{");
		fs.writeFileSync(
			path.join(dataDir2, "config.json"),
			JSON.stringify({ threshold: 0.5 }),
		);

		const tp = path.join(tmpDir, "transcript.jsonl");
		fs.appendFileSync(
			tp,
			JSON.stringify({
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
			}) + "\n",
		);

		try {
			execFileSync("node", [HOOK_PATH], {
				input: JSON.stringify({
					session_id: "test-edge",
					prompt: "hello",
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

		assert.ok(!fs.existsSync(path.join(dataDir2, `reload-${h}.json`)));
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
			JSON.stringify({
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
			}) + "\n",
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
	it("handles transcript larger than 10MB by reading tail", () => {
		const tp = path.join(tmpDir, "large-transcript.jsonl");

		const oldLine = JSON.stringify({
			type: "user",
			message: { role: "user", content: "this should be dropped by tail read" },
		});

		const paddingLine = JSON.stringify({
			type: "system",
			message: { content: "x".repeat(150) },
		});

		let content = oldLine + "\n";
		const lines = Math.ceil((11 * 1024 * 1024) / (paddingLine.length + 1));
		for (let i = 0; i < lines; i++) {
			content += paddingLine + "\n";
		}
		content +=
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "this is the recent message" },
			}) + "\n";

		fs.writeFileSync(tp, content);

		const result = extractConversation(tp);
		assert.ok(result.includes("**User:** this is the recent message"));
		assert.ok(!result.includes("this should be dropped"));
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
			content += line + "\n";
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
	it("filters long multi-heading messages in extractRecent", () => {
		const tp = path.join(tmpDir, "recent-skill.jsonl");
		const skillContent =
			"# Skill Title\n\nInstructions.\n\n## Step 1\n\nDo this.\n\n## Step 2\n\nDo that.\n\n" +
			"x".repeat(800);
		fs.appendFileSync(
			tp,
			JSON.stringify({
				type: "user",
				message: { role: "user", content: skillContent },
			}) + "\n",
		);
		fs.appendFileSync(
			tp,
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "real message" },
			}) + "\n",
		);

		const result = extractRecent(tp, 20);
		assert.ok(!result.includes("Skill Title"));
		assert.ok(result.includes("**User:** real message"));
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
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "good" },
			}) + "\n",
		);
		fs.appendFileSync(tp, "bad json line\n");
		fs.appendFileSync(
			tp,
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "response" }],
				},
			}) + "\n",
		);

		const result = extractRecent(tp, 20);
		assert.ok(result.includes("**User:** good"));
		assert.ok(result.includes("**Assistant:** response"));
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
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content:
						"# Context Checkpoint (Smart Compact)\n> Created: 2026\n\n**User:** old",
				},
			}) + "\n",
		);
		fs.appendFileSync(
			tp,
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "real message" },
			}) + "\n",
		);

		const result = extractRecent(tp, 20);
		assert.ok(!result.includes("Context Checkpoint"));
		assert.ok(result.includes("**User:** real message"));
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
			fs.writeSync(fd, line + "\n");
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

	it("projectStateFiles returns paths with cwd hash", () => {
		const files = projectStateFiles("/some/path");
		assert.ok(files.reload.includes("reload-"));
		assert.ok(files.resume.includes("resume-"));
		assert.ok(files.cooldown.includes("cooldown-"));
	});

	it("sessionFlags returns paths with sessionId", () => {
		const flags = sessionFlags("/some/project", "sess-42");
		assert.ok(flags.warned.includes("cg-warned-sess-42"));
		assert.ok(flags.menu.includes("cg-menu-sess-42"));
		assert.ok(flags.prompt.includes("cg-prompt-sess-42"));
		assert.ok(flags.compactMenu.includes("cg-compact-sess-42"));
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
			JSON.stringify({
				type: "user",
				message: { role: "user", content: longMsg },
			}) + "\n",
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
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: "plain string response" },
			}) + "\n",
		);

		const result = extractRecent(tp, 20);
		assert.ok(result.includes("**Assistant:** plain string response"));
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
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "hello" },
			}) + "\n",
		);
		fs.appendFileSync(
			tp,
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: "plain string response" },
			}) + "\n",
		);

		const result = extractConversation(tp);
		assert.ok(result.includes("**Assistant:** plain string response"));
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
});

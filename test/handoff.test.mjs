import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let tmpDir;
let transcriptPath;
let cwd;
let dataDir;

function writeLine(obj) {
	fs.appendFileSync(transcriptPath, `${JSON.stringify(obj)}\n`);
}

function writeMinimalTranscript() {
	writeLine({
		type: "user",
		message: {
			role: "user",
			content:
				"Please implement the fibonacci function with memoization for our math library. We need it to handle large numbers efficiently.",
		},
	});
	writeLine({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "I will implement the fibonacci function with memoization. This approach uses a cache to avoid redundant calculations, making it O(n) instead of O(2^n). Here is the implementation with full error handling and type checking for the math library module.",
				},
			],
		},
	});
	writeLine({
		type: "user",
		message: {
			role: "user",
			content:
				"Great, now add unit tests for edge cases including negative numbers, zero, and very large inputs like fib(1000).",
		},
	});
	writeLine({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "I have added comprehensive unit tests covering negative numbers (should throw), zero (returns 0), one (returns 1), standard cases (fib(10) = 55), and large inputs (fib(1000) using BigInt). All tests pass successfully with the memoized implementation.",
				},
			],
		},
	});
}

function runCli(args, opts = {}) {
	return execFileSync("node", [path.resolve("lib/compact-cli.mjs"), ...args], {
		encoding: "utf8",
		timeout: 5000,
		cwd: opts.cwd || cwd,
	});
}

function runResumeCli(args, opts = {}) {
	return execFileSync("node", [path.resolve("lib/resume-cli.mjs"), ...args], {
		encoding: "utf8",
		timeout: 5000,
		cwd: opts.cwd || cwd,
	});
}

function writeStateFile(sessionId, data) {
	fs.writeFileSync(
		path.join(dataDir, `state-${sessionId}.json`),
		JSON.stringify({ transcript_path: transcriptPath, ...data }),
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-handoff-test-"));
	transcriptPath = path.join(tmpDir, "transcript.jsonl");
	cwd = path.join(tmpDir, "project");
	dataDir = path.join(tmpDir, "data");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(transcriptPath, "");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// performHandoff (via compact-cli)
// ---------------------------------------------------------------------------

describe("performHandoff via compact-cli", () => {
	it("creates a handoff file in .context-guardian/ dir", () => {
		writeMinimalTranscript();
		writeStateFile("test-session");

		const result = JSON.parse(runCli(["handoff", "test-session", dataDir]));

		assert.equal(result.success, true);
		assert.ok(result.statsBlock.includes("Session Handoff"));
		assert.ok(result.statsBlock.includes("/cg:resume"));

		const cgDir = path.join(cwd, ".context-guardian");
		assert.ok(fs.existsSync(cgDir));
		const handoffFiles = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		assert.equal(handoffFiles.length, 1);
	});

	it("includes label in filename and header", () => {
		writeMinimalTranscript();
		writeStateFile("test-session");

		const result = JSON.parse(
			runCli(["handoff", "test-session", dataDir, "my auth refactor"]),
		);

		assert.equal(result.success, true);

		const cgDir = path.join(cwd, ".context-guardian");
		const files = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		assert.equal(files.length, 1);
		// Label slug comes before the timestamp
		assert.ok(files[0].startsWith("cg-handoff-my-auth-refactor-"));

		// Check label in header
		const content = fs.readFileSync(path.join(cgDir, files[0]), "utf8");
		assert.ok(content.includes("> Label: my auth refactor"));
	});

	it("slugifies label with special characters", () => {
		writeMinimalTranscript();
		writeStateFile("test-session");

		JSON.parse(
			runCli(["handoff", "test-session", dataDir, "Fix bug #123 (urgent!)"]),
		);

		const cgDir = path.join(cwd, ".context-guardian");
		const files = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		assert.equal(files.length, 1);
		// Special chars replaced with dashes
		assert.ok(files[0].includes("fix-bug-123-urgent"));
		assert.ok(!files[0].includes("#"));
		assert.ok(!files[0].includes("("));
	});

	it("truncates long labels to 50 chars in filename", () => {
		writeMinimalTranscript();
		writeStateFile("test-session");

		const longLabel = "a".repeat(100);
		JSON.parse(runCli(["handoff", "test-session", dataDir, longLabel]));

		const cgDir = path.join(cwd, ".context-guardian");
		const files = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		// Slug portion should be capped at 50 chars + dash
		const slug = files[0].replace("cg-handoff-", "").split(/\d{4}-/)[0];
		assert.ok(slug.length <= 51); // 50 chars + trailing dash
	});

	it("works without a label", () => {
		writeMinimalTranscript();
		writeStateFile("test-session");

		const result = JSON.parse(runCli(["handoff", "test-session", dataDir]));

		assert.equal(result.success, true);
		const cgDir = path.join(cwd, ".context-guardian");
		const files = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		// No slug — starts with cg-handoff- then a digit (timestamp)
		assert.match(files[0], /^cg-handoff-\d/);

		// No Label line in content
		const content = fs.readFileSync(path.join(cgDir, files[0]), "utf8");
		assert.ok(!content.includes("> Label:"));
	});

	it("returns error for empty transcript", () => {
		const emptyTranscript = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(emptyTranscript, "");
		fs.writeFileSync(
			path.join(dataDir, "state-test-session.json"),
			JSON.stringify({ transcript_path: emptyTranscript }),
		);

		const result = JSON.parse(runCli(["handoff", "test-session", dataDir]));

		assert.equal(result.success, false);
		assert.ok(result.error.includes("No extractable content"));
	});

	it("returns error for missing session state", () => {
		const result = JSON.parse(runCli(["handoff", "no-such-session", dataDir]));
		assert.equal(result.success, false);
		assert.ok(result.error.includes("No session data"));
	});

	it("statsBlock includes token stats", () => {
		writeMinimalTranscript();
		writeStateFile("test-session");

		const result = JSON.parse(runCli(["handoff", "test-session", dataDir]));

		assert.ok(result.statsBlock.includes("Before:"));
		assert.ok(result.statsBlock.includes("After:"));
		assert.ok(result.statsBlock.includes("Saved:"));
	});
});

// ---------------------------------------------------------------------------
// listRestoreFiles
// ---------------------------------------------------------------------------

describe("listRestoreFiles", () => {
	it("returns empty array when .context-guardian/ does not exist", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const result = listRestoreFiles(cwd);
		assert.deepEqual(result, []);
	});

	it("finds handoff files", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-29T10:00:00Z\n\n## Session State\nGoal: implement fibonacci\n",
		);

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 1);
		assert.equal(result[0].type, "handoff");
		assert.equal(result[0].goal, "implement fibonacci");
	});

	it("excludes checkpoint files by default", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-checkpoint-2026-03-29T09-00-00-abcd1234.md"),
			"# Context Checkpoint (Smart Compact)\n> Created: 2026-03-29T09:00:00Z\n\n## Session State\nGoal: fix auth bug\n",
		);

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 0);
	});

	it("includes checkpoint files with includeCheckpoints flag", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-checkpoint-2026-03-29T09-00-00-abcd1234.md"),
			"# Context Checkpoint (Smart Compact)\n> Created: 2026-03-29T09:00:00Z\n\n## Session State\nGoal: fix auth bug\n",
		);

		const result = listRestoreFiles(cwd, { includeCheckpoints: true });
		assert.equal(result.length, 1);
		assert.equal(result[0].type, "checkpoint");
		assert.equal(result[0].goal, "fix auth bug");
	});

	it("sorts newest first", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-28T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-28T10:00:00Z\n\n## Session State\nGoal: older session\n",
		);
		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-29T10:00:00Z\n\n## Session State\nGoal: newer session\n",
		);

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 2);
		assert.equal(result[0].goal, "newer session");
		assert.equal(result[1].goal, "older session");
	});

	it("shows label in preference to goal", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-my-auth-refactor-2026-03-29T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-29T10:00:00Z\n> Label: my auth refactor\n\n## Session State\nGoal: implement auth\n",
		);

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 1);
		assert.equal(result[0].label, "my auth refactor");
		assert.equal(result[0].goal, "implement auth");
	});

	it("ignores non-CG files", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(path.join(cgDir, "random-notes.md"), "nothing");
		fs.writeFileSync(path.join(cgDir, ".gitkeep"), "");

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 0);
	});

	it("limits to 10 handoffs", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		for (let i = 0; i < 15; i++) {
			const d = String(i).padStart(2, "0");
			fs.writeFileSync(
				path.join(cgDir, `cg-handoff-2026-03-${d}T10-00-00.md`),
				`# Session Handoff\n> Created: 2026-03-${d}T10:00:00Z\n\n## Session State\nGoal: session ${i}\n`,
			);
		}

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 10);
	});

	it("limits to 10 handoffs + 10 checkpoints in all mode", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		for (let i = 0; i < 15; i++) {
			const d = String(i).padStart(2, "0");
			fs.writeFileSync(
				path.join(cgDir, `cg-handoff-2026-03-${d}T10-00-00.md`),
				`# Session Handoff\n> Created: 2026-03-${d}T10:00:00Z\n`,
			);
			fs.writeFileSync(
				path.join(cgDir, `cg-checkpoint-2026-03-${d}T10-00-00-abcd.md`),
				`# Context Checkpoint\n> Created: 2026-03-${d}T10:00:00Z\n`,
			);
		}

		const result = listRestoreFiles(cwd, { includeCheckpoints: true });
		const handoffs = result.filter((f) => f.type === "handoff");
		const checkpoints = result.filter((f) => f.type === "checkpoint");
		assert.equal(handoffs.length, 10);
		assert.equal(checkpoints.length, 10);
		assert.equal(result.length, 20);
	});

	it("handles unreadable files gracefully", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		// Create a valid file
		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-29T10:00:00Z\n",
		);
		// Create a directory with the same naming pattern (will fail on readFileHead)
		fs.mkdirSync(path.join(cgDir, "cg-handoff-fake-dir.md"));

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 1); // Only the valid file
	});

	it("parses goal as null when [not available]", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-29T10:00:00Z\n\n## Session State\nGoal: [not available]\n",
		);

		const result = listRestoreFiles(cwd);
		assert.equal(result[0].goal, null);
		assert.equal(result[0].label, null);
	});

	it("falls back to mtime when Created header is missing", async () => {
		const { listRestoreFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md"),
			"# Session Handoff\nno created header here\n",
		);

		const result = listRestoreFiles(cwd);
		assert.equal(result.length, 1);
		// created should be an ISO string (from mtime)
		assert.ok(result[0].created.includes("T"));
	});
});

// ---------------------------------------------------------------------------
// formatRestoreMenu
// ---------------------------------------------------------------------------

describe("formatRestoreMenu", () => {
	it("shows no-files message when empty", async () => {
		const { formatRestoreMenu } = await import("../lib/handoff.mjs");
		const menu = formatRestoreMenu([]);
		assert.ok(menu.includes("No saved sessions found"));
		assert.ok(menu.includes("/cg:handoff"));
		assert.ok(menu.includes("┌"));
		assert.ok(menu.includes("└"));
	});

	it("formats files with numbers in box", async () => {
		const { formatRestoreMenu } = await import("../lib/handoff.mjs");
		const files = [
			{
				path: "/tmp/test/cg-handoff-2026-03-29.md",
				filename: "cg-handoff-2026-03-29.md",
				type: "handoff",
				created: new Date().toISOString(),
				goal: "implement fibonacci",
				size: 42,
			},
			{
				path: "/tmp/test/cg-checkpoint-2026-03-28.md",
				filename: "cg-checkpoint-2026-03-28.md",
				type: "checkpoint",
				created: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
				goal: "fix auth bug",
				size: 18,
			},
		];
		const menu = formatRestoreMenu(files);

		assert.ok(menu.includes("[1]"));
		assert.ok(menu.includes("implement fibonacci"));
		assert.ok(menu.includes("[2]"));
		assert.ok(menu.includes("fix auth bug"));
		assert.ok(menu.includes("Previous Sessions"));
		assert.ok(menu.includes("Reply with a number"));
		// showType not set, so no type labels
		assert.ok(!menu.includes("[HANDOFF]"));
		assert.ok(!menu.includes("[CHECKPOINT]"));

		// With showType
		const menuAll = formatRestoreMenu(files, { showType: true });
		assert.ok(menuAll.includes("[HANDOFF]"));
		assert.ok(menuAll.includes("[CHECKPOINT]"));
	});

	it("prefers label over goal in display", async () => {
		const { formatRestoreMenu } = await import("../lib/handoff.mjs");
		const menu = formatRestoreMenu([
			{
				path: "/tmp/test.md",
				filename: "test.md",
				type: "handoff",
				created: new Date().toISOString(),
				label: "my custom label",
				goal: "auto-detected goal",
				size: 10,
			},
		]);
		assert.ok(menu.includes("my custom label"));
		assert.ok(!menu.includes("auto-detected goal"));
	});

	it("shows no description when label and goal are both null", async () => {
		const { formatRestoreMenu } = await import("../lib/handoff.mjs");
		const menu = formatRestoreMenu([
			{
				path: "/tmp/test.md",
				filename: "test.md",
				type: "handoff",
				created: new Date().toISOString(),
				label: null,
				goal: null,
				size: 5,
			},
		]);
		assert.ok(menu.includes("no description"));
	});

	it("includes box characters", async () => {
		const { formatRestoreMenu } = await import("../lib/handoff.mjs");
		const menu = formatRestoreMenu([
			{
				path: "/tmp/test.md",
				filename: "test.md",
				type: "handoff",
				created: new Date().toISOString(),
				goal: "test",
				size: 1,
			},
		]);
		assert.ok(menu.includes("┌"));
		assert.ok(menu.includes("├"));
		assert.ok(menu.includes("└"));
		assert.ok(menu.includes("│"));
	});
});

// ---------------------------------------------------------------------------
// resume-cli
// ---------------------------------------------------------------------------

describe("resume-cli", () => {
	it("list returns empty when no .context-guardian/", () => {
		const result = JSON.parse(runResumeCli(["list"]));
		assert.equal(result.success, true);
		assert.equal(result.files.length, 0);
		assert.ok(result.menu.includes("No saved sessions"));
	});

	it("list finds handoff files in .context-guardian/", () => {
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });
		fs.writeFileSync(
			path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md"),
			"# Session Handoff\n> Created: 2026-03-29T10:00:00Z\n\n## Session State\nGoal: test goal\n",
		);

		const result = JSON.parse(runResumeCli(["list"]));
		assert.equal(result.success, true);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].type, "handoff");
	});

	it("list excludes checkpoints without all flag", () => {
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });
		fs.writeFileSync(
			path.join(cgDir, "cg-checkpoint-2026-03-29T10-00-00-abcd.md"),
			"# Context Checkpoint\n> Created: 2026-03-29T10:00:00Z\n",
		);

		const result = JSON.parse(runResumeCli(["list"]));
		assert.equal(result.files.length, 0);
	});

	it("list includes checkpoints with all flag", () => {
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });
		fs.writeFileSync(
			path.join(cgDir, "cg-checkpoint-2026-03-29T10-00-00-abcd.md"),
			"# Context Checkpoint\n> Created: 2026-03-29T10:00:00Z\n",
		);

		const result = JSON.parse(runResumeCli(["list", "all"]));
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].type, "checkpoint");
		// showType should be true when all is used
		assert.ok(result.menu.includes("[CHECKPOINT]"));
	});

	it("load returns file content", () => {
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });
		const filePath = path.join(cgDir, "cg-handoff-2026-03-29T10-00-00.md");
		fs.writeFileSync(filePath, "# Session Handoff\ntest content");

		const result = JSON.parse(runResumeCli(["load", filePath]));
		assert.equal(result.success, true);
		assert.equal(result.type, "handoff");
		assert.ok(result.content.includes("test content"));
	});

	it("load identifies checkpoint type", () => {
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });
		const filePath = path.join(cgDir, "cg-checkpoint-2026-03-29T10-00-00.md");
		fs.writeFileSync(filePath, "# Context Checkpoint\ncheckpoint content");

		const result = JSON.parse(runResumeCli(["load", filePath]));
		assert.equal(result.success, true);
		assert.equal(result.type, "checkpoint");
	});

	it("load returns error for missing file", () => {
		const result = JSON.parse(
			runResumeCli(["load", path.join(cwd, ".context-guardian", "nope.md")]),
		);
		assert.equal(result.success, false);
	});

	it("load rejects paths outside .context-guardian/", () => {
		// Create a file outside .context-guardian
		const outsidePath = path.join(cwd, "secret.txt");
		fs.writeFileSync(outsidePath, "secret data");

		const result = JSON.parse(runResumeCli(["load", outsidePath]));
		assert.equal(result.success, false);
	});

	it("returns error for unknown action", () => {
		const result = JSON.parse(runResumeCli(["unknown"]));
		assert.equal(result.success, false);
		assert.ok(result.error.includes("Usage"));
	});

	it("returns error for no action", () => {
		const result = JSON.parse(runResumeCli([]));
		assert.equal(result.success, false);
	});
});

// ---------------------------------------------------------------------------
// rotateFiles
// ---------------------------------------------------------------------------

describe("rotateFiles", () => {
	it("keeps only maxKeep files", async () => {
		const { rotateFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		for (let i = 1; i <= 8; i++) {
			const filePath = path.join(cgDir, `cg-handoff-2026-03-0${i}T10-00-00.md`);
			fs.writeFileSync(filePath, `handoff ${i}`);
			// Set mtime to ensure correct ordering
			const mtime = new Date(`2026-03-0${i}T10:00:00Z`);
			fs.utimesSync(filePath, mtime, mtime);
		}

		rotateFiles(cgDir, "cg-handoff-", 5);

		const remaining = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		assert.equal(remaining.length, 5);
	});

	it("handles label-prefixed files correctly by mtime", async () => {
		const { rotateFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		// Newer file has label "zebra" (sorts after alphabetically)
		const newerFile = path.join(
			cgDir,
			"cg-handoff-zebra-2026-03-29T10-00-00.md",
		);
		fs.writeFileSync(newerFile, "newer");
		fs.utimesSync(newerFile, new Date("2026-03-29"), new Date("2026-03-29"));

		// Older file has label "alpha" (sorts before alphabetically)
		const olderFile = path.join(
			cgDir,
			"cg-handoff-alpha-2026-03-28T10-00-00.md",
		);
		fs.writeFileSync(olderFile, "older");
		fs.utimesSync(olderFile, new Date("2026-03-28"), new Date("2026-03-28"));

		rotateFiles(cgDir, "cg-handoff-", 1);

		const remaining = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-handoff-"));
		assert.equal(remaining.length, 1);
		// Newer file (zebra) should survive despite sorting after alpha alphabetically
		assert.ok(remaining[0].includes("zebra"));
	});

	it("handles empty directory", async () => {
		const { rotateFiles } = await import("../lib/handoff.mjs");
		const cgDir = path.join(cwd, ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });

		// Should not throw
		rotateFiles(cgDir, "cg-handoff-", 5);

		const remaining = fs.readdirSync(cgDir);
		assert.equal(remaining.length, 0);
	});

	it("handles nonexistent directory", async () => {
		const { rotateFiles } = await import("../lib/handoff.mjs");
		// Should not throw
		rotateFiles("/nonexistent/path", "cg-handoff-", 5);
	});
});

// ---------------------------------------------------------------------------
// CG_DIR_NAME constant
// ---------------------------------------------------------------------------

describe("CG_DIR_NAME", () => {
	it("exports .context-guardian", async () => {
		const { CG_DIR_NAME } = await import("../lib/handoff.mjs");
		assert.equal(CG_DIR_NAME, ".context-guardian");
	});
});

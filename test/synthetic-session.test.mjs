import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let tmpDir;
let dataDir;
let projectCwd;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-synthetic-test-"));
	dataDir = path.join(tmpDir, "data");
	projectCwd = path.join(tmpDir, "project");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.mkdirSync(projectCwd, { recursive: true });
	process.env.CLAUDE_PLUGIN_DATA = dataDir;
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.CLAUDE_PLUGIN_DATA;
});

// We need a fresh import each time to avoid manifest caching issues.
// The module uses process.env at call time so re-import isn't strictly needed,
// but it keeps tests isolated from any module-level state.
async function loadModule() {
	// Dynamic import with cache-busting query to get a fresh module each test
	const mod = await import(`../lib/synthetic-session.mjs?t=${Date.now()}-${Math.random()}`);
	return mod;
}

// ---------------------------------------------------------------------------
// writeSyntheticSession — JSONL structure
// ---------------------------------------------------------------------------

describe("writeSyntheticSession", () => {
	it("writes a valid 3-line JSONL file", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { sessionUuid, jsonlPath } = writeSyntheticSession({
			checkpointContent: "# Checkpoint\nSome content here",
			title: "cg",
			projectCwd,
		});

		assert.ok(sessionUuid, "should return a session UUID");
		assert.ok(jsonlPath, "should return a JSONL path");
		assert.ok(fs.existsSync(jsonlPath), "JSONL file should exist on disk");

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 3, "should have exactly 3 lines");

		const userMsg = JSON.parse(lines[0]);
		const assistantMsg = JSON.parse(lines[1]);
		const titleEntry = JSON.parse(lines[2]);

		// Line 1: User message
		assert.equal(userMsg.type, "user");
		assert.equal(userMsg.message.role, "user");
		assert.equal(userMsg.message.content, "# Checkpoint\nSome content here");
		assert.equal(userMsg.sessionId, sessionUuid);
		assert.equal(userMsg.cwd, projectCwd);
		assert.equal(userMsg.parentUuid, null);
		assert.equal(userMsg.isSidechain, false);
		assert.equal(userMsg.userType, "external");
		assert.ok(userMsg.uuid, "user message should have a uuid");
		assert.ok(userMsg.timestamp, "user message should have a timestamp");

		// Line 2: Assistant message
		assert.equal(assistantMsg.type, "assistant");
		assert.equal(assistantMsg.message.role, "assistant");
		assert.ok(Array.isArray(assistantMsg.message.content));
		assert.equal(assistantMsg.message.content[0].type, "text");
		assert.ok(assistantMsg.message.content[0].text.includes("Context restored"));
		assert.equal(assistantMsg.message.stop_reason, "end_turn");
		assert.equal(assistantMsg.parentUuid, userMsg.uuid);
		assert.equal(assistantMsg.sessionId, sessionUuid);
		assert.equal(assistantMsg.cwd, projectCwd);

		// Line 3: Custom title
		assert.equal(titleEntry.type, "custom-title");
		assert.equal(titleEntry.customTitle, "cg");
		assert.equal(titleEntry.sessionId, sessionUuid);
	});

	it("writes to the correct sessions directory based on projectCwd", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		// The path should be under ~/.claude/projects/{sanitized_cwd}/
		// sanitizeCwd replaces all non-alphanumeric chars with hyphens (matching CC)
		const expectedDir = path.join(
			os.homedir(),
			".claude",
			"projects",
			projectCwd.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		assert.ok(
			jsonlPath.startsWith(expectedDir),
			`path ${jsonlPath} should start with ${expectedDir}`,
		);
		assert.ok(jsonlPath.endsWith(".jsonl"));
	});

	it("uses the session UUID in the filename", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { sessionUuid, jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		assert.ok(
			jsonlPath.includes(sessionUuid),
			"JSONL filename should contain the session UUID",
		);
	});

	it("sets file permissions to 0o600", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		const stat = fs.statSync(jsonlPath);
		const mode = stat.mode & 0o777;
		assert.equal(mode, 0o600, `file mode should be 0600, got ${mode.toString(8)}`);
	});

	it("assistant timestamp is 1ms after user timestamp", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const userTs = new Date(JSON.parse(lines[0]).timestamp).getTime();
		const assistantTs = new Date(JSON.parse(lines[1]).timestamp).getTime();
		assert.equal(assistantTs - userTs, 1, "assistant should be 1ms after user");
	});
});

// ---------------------------------------------------------------------------
// Manifest management
// ---------------------------------------------------------------------------

describe("manifest management", () => {
	it("creates manifest on first write", async () => {
		const { writeSyntheticSession } = await loadModule();
		const manifestPath = path.join(dataDir, "synthetic-sessions.json");
		assert.ok(!fs.existsSync(manifestPath), "manifest should not exist yet");

		writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		assert.ok(fs.existsSync(manifestPath), "manifest should be created");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		assert.ok(manifest.cg, "manifest should have 'cg' entry");
		assert.ok(manifest.cg.uuid);
		assert.ok(manifest.cg.path);
	});

	it("tracks separate titles independently", async () => {
		const { writeSyntheticSession } = await loadModule();

		const r1 = writeSyntheticSession({
			checkpointContent: "compact checkpoint",
			title: "cg",
			projectCwd,
		});
		const r2 = writeSyntheticSession({
			checkpointContent: "handoff checkpoint",
			title: "cg:my-feature",
			projectCwd,
		});

		const manifestPath = path.join(dataDir, "synthetic-sessions.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		assert.equal(Object.keys(manifest).length, 2);
		assert.equal(manifest.cg.uuid, r1.sessionUuid);
		assert.equal(manifest["cg:my-feature"].uuid, r2.sessionUuid);

		// Both files should exist
		assert.ok(fs.existsSync(r1.jsonlPath));
		assert.ok(fs.existsSync(r2.jsonlPath));
	});

	it("sets manifest file permissions to 0o600", async () => {
		const { writeSyntheticSession } = await loadModule();
		writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		const manifestPath = path.join(dataDir, "synthetic-sessions.json");
		const stat = fs.statSync(manifestPath);
		const mode = stat.mode & 0o777;
		assert.equal(mode, 0o600, `manifest mode should be 0600, got ${mode.toString(8)}`);
	});
});

// ---------------------------------------------------------------------------
// Cleanup of previous sessions
// ---------------------------------------------------------------------------

describe("previous session cleanup", () => {
	it("deletes previous JSONL when writing same title", async () => {
		const { writeSyntheticSession } = await loadModule();

		const first = writeSyntheticSession({
			checkpointContent: "first checkpoint",
			title: "cg",
			projectCwd,
		});
		assert.ok(fs.existsSync(first.jsonlPath));

		const second = writeSyntheticSession({
			checkpointContent: "second checkpoint",
			title: "cg",
			projectCwd,
		});

		// First should be deleted, second should exist
		assert.ok(!fs.existsSync(first.jsonlPath), "first JSONL should be deleted");
		assert.ok(fs.existsSync(second.jsonlPath), "second JSONL should exist");
		assert.notEqual(first.sessionUuid, second.sessionUuid);
	});

	it("does not delete JSONL for different titles", async () => {
		const { writeSyntheticSession } = await loadModule();

		const compact = writeSyntheticSession({
			checkpointContent: "compact",
			title: "cg",
			projectCwd,
		});

		const handoff = writeSyntheticSession({
			checkpointContent: "handoff",
			title: "cg:feature",
			projectCwd,
		});

		assert.ok(fs.existsSync(compact.jsonlPath), "compact JSONL should still exist");
		assert.ok(fs.existsSync(handoff.jsonlPath), "handoff JSONL should exist");
	});

	it("handles missing previous file gracefully", async () => {
		const { writeSyntheticSession } = await loadModule();

		const first = writeSyntheticSession({
			checkpointContent: "first",
			title: "cg",
			projectCwd,
		});

		// Manually delete the file before the next write
		fs.unlinkSync(first.jsonlPath);

		// Should not throw
		const second = writeSyntheticSession({
			checkpointContent: "second",
			title: "cg",
			projectCwd,
		});
		assert.ok(fs.existsSync(second.jsonlPath));
	});

	it("retitles previous when it matches currentSessionId instead of deleting", async () => {
		const { writeSyntheticSession } = await loadModule();

		const first = writeSyntheticSession({
			checkpointContent: "first",
			title: "cg",
			projectCwd,
		});

		// Simulate: user already /resumed into this synthetic session
		const second = writeSyntheticSession({
			checkpointContent: "second",
			title: "cg",
			projectCwd,
			currentSessionId: first.sessionUuid,
		});

		// Active session should be retitled, not deleted
		assert.ok(fs.existsSync(first.jsonlPath), "active session JSONL must still exist (retitled)");
		assert.ok(fs.existsSync(second.jsonlPath));
		// Last custom-title in the retitled file should be "cg-resumed-*"
		const lines = fs.readFileSync(first.jsonlPath, "utf8").trim().split("\n");
		const lastLine = JSON.parse(lines[lines.length - 1]);
		assert.strictEqual(lastLine.type, "custom-title");
		assert.ok(lastLine.customTitle.startsWith("cg-resumed-"), `Expected cg-resumed-* title, got: ${lastLine.customTitle}`);
	});

	it("deletes previous when it does not match currentSessionId", async () => {
		const { writeSyntheticSession } = await loadModule();

		const first = writeSyntheticSession({
			checkpointContent: "first",
			title: "cg",
			projectCwd,
		});

		// Different session — previous should be deleted normally
		const second = writeSyntheticSession({
			checkpointContent: "second",
			title: "cg",
			projectCwd,
			currentSessionId: "some-other-session-id",
		});

		assert.ok(!fs.existsSync(first.jsonlPath), "non-active session JSONL should be deleted");
		assert.ok(fs.existsSync(second.jsonlPath));
	});

	it("purges pre-manifest files with the same custom title", async () => {
		const { writeSyntheticSession } = await loadModule();

		// Simulate a pre-manifest synthetic session (written before manifest existed)
		const sessionsDir = path.join(
			os.homedir(),
			".claude",
			"projects",
			projectCwd.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const staleUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const staleContent = [
			JSON.stringify({ type: "user", message: { role: "user", content: "old checkpoint" }, uuid: "u1", parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), userType: "external", cwd: projectCwd, sessionId: staleUuid, version: "1.0.0" }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }, uuid: "u2", parentUuid: "u1", isSidechain: false, timestamp: new Date().toISOString(), userType: "external", cwd: projectCwd, sessionId: staleUuid, version: "1.0.0" }),
			JSON.stringify({ type: "custom-title", customTitle: "cg", sessionId: staleUuid }),
		].join("\n") + "\n";

		const stalePath = path.join(sessionsDir, `${staleUuid}.jsonl`);
		fs.writeFileSync(stalePath, staleContent);
		assert.ok(fs.existsSync(stalePath), "stale file should exist before write");

		// Now write a new synthetic session with title "cg"
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "new checkpoint",
			title: "cg",
			projectCwd,
		});

		// The stale file should have been purged
		assert.ok(!fs.existsSync(stalePath), "stale pre-manifest file should be purged");
		assert.ok(fs.existsSync(jsonlPath), "new synthetic session should exist");
	});

	it("does not purge files with different custom titles", async () => {
		const { writeSyntheticSession } = await loadModule();

		const sessionsDir = path.join(
			os.homedir(),
			".claude",
			"projects",
			projectCwd.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		fs.mkdirSync(sessionsDir, { recursive: true });

		// Create a handoff synthetic session with a different title
		const handoffUuid = "11111111-2222-3333-4444-555555555555";
		const handoffContent = [
			JSON.stringify({ type: "user", message: { role: "user", content: "handoff" }, uuid: "h1", parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), userType: "external", cwd: projectCwd, sessionId: handoffUuid, version: "1.0.0" }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }, uuid: "h2", parentUuid: "h1", isSidechain: false, timestamp: new Date().toISOString(), userType: "external", cwd: projectCwd, sessionId: handoffUuid, version: "1.0.0" }),
			JSON.stringify({ type: "custom-title", customTitle: "cg:my-feature", sessionId: handoffUuid }),
		].join("\n") + "\n";

		const handoffPath = path.join(sessionsDir, `${handoffUuid}.jsonl`);
		fs.writeFileSync(handoffPath, handoffContent);

		// Write a compact session with title "cg"
		writeSyntheticSession({
			checkpointContent: "compact",
			title: "cg",
			projectCwd,
		});

		// The handoff file should NOT be purged
		assert.ok(fs.existsSync(handoffPath), "different-title file should not be purged");
	});
});

// ---------------------------------------------------------------------------
// Title handling
// ---------------------------------------------------------------------------

describe("title handling", () => {
	it("supports bare 'cg' title for compact", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const titleEntry = JSON.parse(lines[2]);
		assert.equal(titleEntry.customTitle, "cg");
	});

	it("supports 'cg:{label}' title for handoff", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg:my-auth-refactor",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const titleEntry = JSON.parse(lines[2]);
		assert.equal(titleEntry.customTitle, "cg:my-auth-refactor");
	});

	it("supports titles with special characters", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg:Fix bug #123 (urgent!)",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const titleEntry = JSON.parse(lines[2]);
		assert.equal(titleEntry.customTitle, "cg:Fix bug #123 (urgent!)");
	});
});

// ---------------------------------------------------------------------------
// CLAUDE_PLUGIN_DATA fallback
// ---------------------------------------------------------------------------

describe("CLAUDE_PLUGIN_DATA fallback", () => {
	it("uses ~/.claude/cg/ when CLAUDE_PLUGIN_DATA is unset", async () => {
		delete process.env.CLAUDE_PLUGIN_DATA;
		const { writeSyntheticSession } = await loadModule();

		writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});

		const fallbackManifest = path.join(
			os.homedir(),
			".claude",
			"cg",
			"synthetic-sessions.json",
		);
		assert.ok(
			fs.existsSync(fallbackManifest),
			"manifest should be at fallback location",
		);

		// Clean up
		try {
			fs.unlinkSync(fallbackManifest);
		} catch {}
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("handles empty checkpoint content", async () => {
		const { writeSyntheticSession } = await loadModule();
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "",
			title: "cg",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const userMsg = JSON.parse(lines[0]);
		assert.equal(userMsg.message.content, "");
	});

	it("handles very large checkpoint content", async () => {
		const { writeSyntheticSession } = await loadModule();
		const largeContent = "x".repeat(500_000);
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: largeContent,
			title: "cg",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const userMsg = JSON.parse(lines[0]);
		assert.equal(userMsg.message.content.length, 500_000);
	});

	it("handles checkpoint content with special JSON characters", async () => {
		const { writeSyntheticSession } = await loadModule();
		const content = 'Line with "quotes" and \\ backslashes\nand\ttabs\nand unicode: \u00e9\u00e0\u00fc';
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: content,
			title: "cg",
			projectCwd,
		});

		const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
		const userMsg = JSON.parse(lines[0]);
		assert.equal(userMsg.message.content, content);
	});

	it("generates unique UUIDs across calls", async () => {
		const { writeSyntheticSession } = await loadModule();
		const uuids = new Set();
		for (let i = 0; i < 5; i++) {
			const { sessionUuid } = writeSyntheticSession({
				checkpointContent: `checkpoint ${i}`,
				title: `cg:test-${i}`,
				projectCwd,
			});
			uuids.add(sessionUuid);
		}
		assert.equal(uuids.size, 5, "all session UUIDs should be unique");
	});

	it("creates sessions directory if it does not exist", async () => {
		const { writeSyntheticSession } = await loadModule();
		// Use a nested project path that definitely doesn't exist as a sessions dir
		const deepProject = path.join(tmpDir, "deep", "nested", "project");
		fs.mkdirSync(deepProject, { recursive: true });

		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd: deepProject,
		});

		assert.ok(fs.existsSync(jsonlPath));
	});

	it("handles corrupt manifest gracefully", async () => {
		const { writeSyntheticSession } = await loadModule();
		// Write corrupt manifest
		fs.writeFileSync(path.join(dataDir, "synthetic-sessions.json"), "not json{{{");

		// Should not throw — readManifest returns {} on parse failure
		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd,
		});
		assert.ok(fs.existsSync(jsonlPath));
	});

	it("handles very long project paths with hash truncation", async () => {
		const { writeSyntheticSession } = await loadModule();
		// Build a path that after sanitization exceeds 200 chars
		const longSegment = "a".repeat(60);
		const longPath = `/${longSegment}/${longSegment}/${longSegment}/${longSegment}`;
		// Sanitized length: 4*60 + 4 slashes = 244 chars > 200

		const { jsonlPath } = writeSyntheticSession({
			checkpointContent: "test",
			title: "cg",
			projectCwd: longPath,
		});

		assert.ok(fs.existsSync(jsonlPath));
		// The directory name should be truncated with a hash suffix
		const dirName = path.basename(path.dirname(jsonlPath));
		assert.ok(
			dirName.length > 200,
			"directory name should include hash suffix beyond 200 chars",
		);
		// Should contain the hash separator
		assert.ok(
			dirName.startsWith("-" + longSegment),
			"should start with sanitized path prefix",
		);
	});
});

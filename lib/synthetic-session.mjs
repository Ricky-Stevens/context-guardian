/**
 * Writes a synthetic JSONL session file to Claude Code's session directory.
 * This enables `/resume cg` (or `/resume cg:{name}`) to load CG checkpoints
 * as real conversation messages — not additionalContext.
 *
 * The synthetic session contains:
 *   Line 1: User message with the checkpoint content
 *   Line 2: Assistant message acknowledging the context
 *   Line 3: custom-title metadata entry
 *
 * Uses a manifest to track synthetic sessions. Each write generates a fresh
 * UUID and cleans up the previous one. If the previous synthetic session is
 * the ACTIVE session (user already /resumed it), we append a title-rename
 * entry to un-claim the title before creating the new file.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.mjs";

/**
 * Max length before hash truncation, matching CC's sessionStoragePortable.ts.
 */
const MAX_SANITIZED_LENGTH = 200;

/**
 * djb2 string hash — matches CC's utils/hash.ts.
 * Used as fallback when Bun.hash isn't available.
 */
function djb2Hash(str) {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return hash;
}

/**
 * Sanitize a cwd path to match Claude Code's project directory naming.
 * Mirrors sanitizePath() from sessionStoragePortable.ts exactly:
 *   1. Replace all non-alphanumeric chars with hyphens
 *   2. If > 200 chars, truncate and append a djb2 hash suffix
 *
 * /home/ricky/myapp → -home-ricky-myapp
 */
function sanitizeCwd(cwd) {
	const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= MAX_SANITIZED_LENGTH) {
		return sanitized;
	}
	// CC uses Bun.hash (wyhash) when running in Bun, djb2Hash in Node.
	// Hooks run as Node subprocesses, but CC itself runs in Bun — so for
	// long paths the hashes would differ. In practice, paths > 200 chars
	// are extremely rare. If this becomes an issue, we can read the actual
	// directory name from disk instead of computing it.
	const hash = Math.abs(djb2Hash(cwd)).toString(36);
	return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

/**
 * Get the sessions directory for a project.
 */
function getSessionsDir(projectCwd) {
	return path.join(
		os.homedir(),
		".claude",
		"projects",
		sanitizeCwd(projectCwd),
	);
}

/**
 * Get the manifest file path. Stored in plugin data dir alongside other state.
 */
function getManifestPath() {
	const dataDir =
		process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "cg");
	return path.join(dataDir, "synthetic-sessions.json");
}

/**
 * Read the manifest of tracked synthetic sessions.
 * @returns {Record<string, { uuid: string, path: string }>}
 */
function readManifest() {
	try {
		return JSON.parse(fs.readFileSync(getManifestPath(), "utf8"));
	} catch {
		return {};
	}
}

/**
 * Write the manifest.
 */
function writeManifest(manifest) {
	const manifestPath = getManifestPath();
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
		mode: 0o600,
	});
}

/**
 * Scan a sessions directory for JSONL files whose custom-title matches `title`
 * and delete them. Skips the file tracked by the manifest (identified by
 * `knownUuid`) since that's already handled above.
 *
 * This is a defensive sweep for orphaned files: pre-manifest synthetics,
 * files CC grew by appending messages after /resume, or files left behind
 * when the manifest was corrupted. Without this, CC's title search returns
 * multiple matches and /resume fails with "Found N sessions matching cg".
 *
 * Reads only the last 200 bytes of each file (the custom-title line is always
 * last), so this is fast even with hundreds of sessions.
 */
function purgeStaleTitle(sessionsDir, title, knownUuid) {
	if (!fs.existsSync(sessionsDir)) return;

	const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
	const needle = `"customTitle":"${title}"`;

	for (const f of files) {
		// Skip the file we already deleted via manifest
		if (knownUuid && f.startsWith(knownUuid)) continue;

		const fullPath = path.join(sessionsDir, f);
		try {
			// Read just the tail — custom-title entry is always the last line
			const stat = fs.statSync(fullPath);
			if (stat.size < 10) continue;
			const tailSize = Math.min(300, stat.size);
			const buf = Buffer.alloc(tailSize);
			const fd = fs.openSync(fullPath, "r");
			try {
				fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
			} finally {
				fs.closeSync(fd);
			}
			const tail = buf.toString("utf8");
			if (tail.includes(needle) && tail.includes('"custom-title"')) {
				fs.unlinkSync(fullPath);
				log(`synthetic-session: purged stale title="${title}" file=${f}`);
			}
		} catch {
			// Skip unreadable files
		}
	}
}

/**
 * Write a synthetic JSONL session that `/resume <title>` can find and load.
 *
 * @param {object} opts
 * @param {string} opts.checkpointContent - Full checkpoint markdown text
 * @param {string} opts.title - Session title: "cg" or "cg:{label}"
 * @param {string} opts.projectCwd - Absolute path to project root
 * @param {string} [opts.currentSessionId] - Current session ID to detect collision
 * @returns {{ sessionUuid: string, jsonlPath: string }}
 */
export function writeSyntheticSession({
	checkpointContent,
	title,
	projectCwd,
	currentSessionId,
}) {
	const sessionsDir = getSessionsDir(projectCwd);
	const manifest = readManifest();

	// Clean up previous synthetic session for this title.
	// Always delete — even if it's the active session. The active session runs
	// from in-memory state; deleting the JSONL doesn't crash it. And we need
	// the "cg" title freed so /resume finds only the new file.
	const prev = manifest[title];
	if (prev) {
		try {
			fs.unlinkSync(prev.path);
			log(
				`synthetic-session: deleted previous ${prev.uuid}${prev.uuid === currentSessionId ? " (was active)" : ""}`,
			);
		} catch {
			// File may already be gone — that's fine
		}
	}

	// Scan for any other JSONL files with the same custom title.
	// Handles pre-manifest leftovers and files CC appended to after /resume.
	// CC's searchSessionsByCustomTitle returns multiple matches if >1 file
	// has the same title, causing "/resume cg" to fail with "Found N sessions".
	try {
		purgeStaleTitle(sessionsDir, title, prev?.uuid);
	} catch (e) {
		log(`synthetic-session: purge-stale error: ${e.message}`);
	}

	// Generate a fresh random UUID for the new synthetic session
	const sessionUuid = crypto.randomUUID();
	const userUuid = crypto.randomUUID();
	const assistantUuid = crypto.randomUUID();

	const now = new Date();
	const userTimestamp = now.toISOString();
	const assistantTimestamp = new Date(now.getTime() + 1).toISOString();

	// Line 1: User message with checkpoint as plain string content
	const userMsg = {
		parentUuid: null,
		isSidechain: false,
		type: "user",
		message: {
			role: "user",
			content: checkpointContent,
		},
		uuid: userUuid,
		timestamp: userTimestamp,
		userType: "external",
		cwd: projectCwd,
		sessionId: sessionUuid,
		version: "1.0.0",
	};

	// Line 2: Assistant acknowledgment
	const assistantMsg = {
		parentUuid: userUuid,
		isSidechain: false,
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Context restored from checkpoint. I have the full session history above including all decisions, code changes, errors, and reasoning. Ready to continue — what would you like to work on?",
				},
			],
			stop_reason: "end_turn",
		},
		uuid: assistantUuid,
		timestamp: assistantTimestamp,
		userType: "external",
		cwd: projectCwd,
		sessionId: sessionUuid,
		version: "1.0.0",
	};

	// Line 3: Custom title for /resume search
	const titleEntry = {
		type: "custom-title",
		customTitle: title,
		sessionId: sessionUuid,
	};

	// Build JSONL content
	const jsonlContent = `${[userMsg, assistantMsg, titleEntry]
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;

	// Write to Claude Code's session directory
	fs.mkdirSync(sessionsDir, { recursive: true });
	const jsonlPath = path.join(sessionsDir, `${sessionUuid}.jsonl`);
	fs.writeFileSync(jsonlPath, jsonlContent, { mode: 0o600 });

	// Update manifest
	manifest[title] = { uuid: sessionUuid, path: jsonlPath };
	writeManifest(manifest);

	log(
		`synthetic-session written: title="${title}" uuid=${sessionUuid} path=${jsonlPath}`,
	);

	return { sessionUuid, jsonlPath };
}

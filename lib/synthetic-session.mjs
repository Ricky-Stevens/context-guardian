/**
 * Writes a synthetic JSONL session file to Claude Code's session directory.
 * This enables `/resume cg:{hash}` (or `/resume cg:{name}`) to load CG
 * checkpoints as real conversation messages — not additionalContext.
 *
 * The synthetic session contains:
 *   Line 1: User message with the checkpoint content
 *   Line 2: Assistant message acknowledging the context
 *   Line 3: custom-title metadata entry
 *
 * Each compact cycle generates a unique title (`cg:{4-hex}`) to avoid
 * CC's in-memory session caching, which prevents reuse of a static title
 * across multiple resume cycles within the same CC process.
 *
 * Manifest entries carry a `type` field ("compact" or "handoff").
 * Compact entries are ephemeral — deleted on next compact.
 * Handoff entries persist until explicitly removed.
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
		hash = Math.trunc((hash << 5) - hash + str.codePointAt(i));
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
	const sanitized = cwd.replaceAll(/[^a-zA-Z0-9]/g, "-");
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
export function getSessionsDir(projectCwd) {
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
export function readManifest() {
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
export function purgeStaleTitle(sessionsDir, title, knownUuid) {
	if (!fs.existsSync(sessionsDir)) return;

	const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
	const needle = `"customTitle":"${title}"`;

	for (const f of files) {
		// Skip the file we already handled via manifest (retitled or about to create)
		if (knownUuid && f.startsWith(knownUuid)) continue;

		const fullPath = path.join(sessionsDir, f);
		try {
			// Scan the full file — after /resume, CC appends real conversation
			// data which pushes the original custom-title entries far from the
			// tail. A tail-only read misses them, leaving stale "cg" titles that
			// cause /resume to match the wrong session.
			const content = fs.readFileSync(fullPath, "utf8");
			if (content.includes(needle) && content.includes('"custom-title"')) {
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
 * @param {string} opts.title - Session title: "cg:{hash}" or "cg:{label}"
 * @param {"compact"|"handoff"} opts.type - Entry type for manifest cleanup
 * @param {string} opts.projectCwd - Absolute path to project root
 * @returns {{ sessionUuid: string, jsonlPath: string }}
 */
export function writeSyntheticSession({
	checkpointContent,
	title,
	type = "compact",
	projectCwd,
}) {
	const sessionsDir = getSessionsDir(projectCwd);
	const manifest = readManifest();

	// Clean up previous compact synthetics — they're ephemeral.
	// Each compact cycle generates a unique title (cg:{hash}), so there's no
	// title collision with CC's in-memory cache. Safe to delete unconditionally.
	// Handoff entries are never cleaned up by compaction.
	if (type === "compact") {
		for (const [key, entry] of Object.entries(manifest)) {
			if (entry.type !== "compact") continue;
			try {
				fs.unlinkSync(entry.path);
				log(`synthetic-session: cleaned compact ${entry.uuid}`);
			} catch {
				// File may already be gone
			}
			delete manifest[key];
		}
	}

	// For handoff titles, clean up any previous entry with the same title
	if (type === "handoff" && manifest[title]) {
		try {
			fs.unlinkSync(manifest[title].path);
			log(
				`synthetic-session: cleaned previous handoff ${manifest[title].uuid}`,
			);
		} catch {
			// File may already be gone
		}
		delete manifest[title];
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

	// Update manifest with type for cleanup discrimination
	manifest[title] = { uuid: sessionUuid, path: jsonlPath, type };
	writeManifest(manifest);

	log(
		`synthetic-session written: title="${title}" uuid=${sessionUuid} path=${jsonlPath}`,
	);

	return { sessionUuid, jsonlPath };
}

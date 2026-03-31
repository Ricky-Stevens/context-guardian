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
 * Sanitize a cwd path to match Claude Code's project directory naming.
 * /home/ricky/myapp → -home-ricky-myapp
 */
function sanitizeCwd(cwd) {
	return cwd.replace(/[\\/]/g, "-");
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
		process.env.CLAUDE_PLUGIN_DATA ||
		path.join(os.homedir(), ".claude", "cg");
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
			log(`synthetic-session: deleted previous ${prev.uuid}${prev.uuid === currentSessionId ? " (was active)" : ""}`);
		} catch {
			// File may already be gone — that's fine
		}
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
	const jsonlContent =
		[userMsg, assistantMsg, titleEntry]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n";

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

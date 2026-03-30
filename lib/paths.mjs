import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Plugin data directory — persistent storage that survives plugin updates.
// Falls back to ~/.claude/cg/ for standalone / local testing.
// ---------------------------------------------------------------------------
export const DATA_DIR =
	process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "cg");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export const LOG_DIR = path.join(os.homedir(), ".claude", "logs");
export const LOG_FILE = path.join(LOG_DIR, "cg.log");

// ---------------------------------------------------------------------------
// Persistent state files (plugin-scoped, survive /clear)
// ---------------------------------------------------------------------------
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const CHECKPOINTS_DIR = path.join(DATA_DIR, "checkpoints");

// Session-scoped state file — each session writes its own token counts
// so multiple concurrent sessions don't clobber each other.
export function stateFile(sessionId) {
	return path.join(DATA_DIR, `state-${sessionId || "unknown"}.json`);
}

// ---------------------------------------------------------------------------
// Ensure the data directory exists on first use.
// ---------------------------------------------------------------------------
export function ensureDataDir() {
	fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Atomic write — writes to a temp file then renames. Prevents partial/corrupt
 * state files on crash, disk full, or concurrent access. Rename is atomic on
 * POSIX systems when source and target are on the same filesystem.
 *
 * @param {string} filePath - Target file path
 * @param {string} data - Content to write
 */
export function atomicWriteFileSync(filePath, data) {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Rotate checkpoint files — keep only the most recent N.
// Files are named session-YYYY-MM-DDTHH-MM-SS-<hash>.md, so alphabetical
// sort gives chronological order.
// ---------------------------------------------------------------------------
export function rotateCheckpoints(maxKeep = 10) {
	try {
		const files = fs
			.readdirSync(CHECKPOINTS_DIR)
			.filter((f) => f.startsWith("session-") && f.endsWith(".md"))
			.sort()
			.reverse(); // newest first
		for (const f of files.slice(maxKeep)) {
			try {
				fs.unlinkSync(path.join(CHECKPOINTS_DIR, f));
			} catch {}
		}
	} catch {}
}

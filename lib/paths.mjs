import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Plugin data directory — persistent storage that survives plugin updates.
// Falls back to ~/.claude/context-guardian/ for standalone / local testing.
// ---------------------------------------------------------------------------
export const DATA_DIR =
	process.env.CLAUDE_PLUGIN_DATA ||
	path.join(os.homedir(), ".claude", "context-guardian");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export const LOG_DIR = path.join(os.homedir(), ".claude", "logs");
export const LOG_FILE = path.join(LOG_DIR, "context-guardian.log");

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
// Project-scoped state files — keyed by a short hash of the project cwd so
// that simultaneous sessions in different projects don't interfere.
// Must live in DATA_DIR (not .claude/) so they survive /clear.
// ---------------------------------------------------------------------------
function cwdHash(cwd) {
	const dir = cwd || process.cwd();
	return crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8);
}
export function projectStateFiles(cwd) {
	const h = cwdHash(cwd);
	return {
		reload: path.join(DATA_DIR, `reload-${h}.json`),
		resume: path.join(DATA_DIR, `resume-${h}.json`),
		cooldown: path.join(DATA_DIR, `cooldown-${h}.json`),
	};
}

// ---------------------------------------------------------------------------
// Session-scoped flags — stored in the project's .claude/ directory so they
// are isolated per project and cleared by SessionStart.
// ---------------------------------------------------------------------------
export function sessionFlags(cwd, sessionId) {
	const dir = path.join(cwd || process.cwd(), ".claude");
	return {
		dir,
		warned: path.join(dir, `cg-warned-${sessionId}`),
		menu: path.join(dir, `cg-menu-${sessionId}`),
		prompt: path.join(dir, `cg-prompt-${sessionId}`),
		compactMenu: path.join(dir, `cg-compact-${sessionId}`),
	};
}

// ---------------------------------------------------------------------------
// Ensure the data directory exists on first use.
// ---------------------------------------------------------------------------
export function ensureDataDir() {
	fs.mkdirSync(DATA_DIR, { recursive: true });
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

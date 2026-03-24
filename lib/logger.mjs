import fs from "node:fs";
import { LOG_DIR, LOG_FILE } from "./paths.mjs";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Append a timestamped line to the shared log file.
 * Silently swallows errors — logging must never break the hook.
 * Rotates the log file when it exceeds MAX_LOG_SIZE.
 */
let logDirReady = false;

export function log(msg) {
	try {
		if (!logDirReady) {
			fs.mkdirSync(LOG_DIR, { recursive: true });
			logDirReady = true;
		}
		// Rotate if log exceeds size limit
		try {
			if (
				fs.existsSync(LOG_FILE) &&
				fs.statSync(LOG_FILE).size > MAX_LOG_SIZE
			) {
				const rotated = `${LOG_FILE}.1`;
				try {
					fs.unlinkSync(rotated);
				} catch {}
				fs.renameSync(LOG_FILE, rotated);
			}
		} catch {}
		fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

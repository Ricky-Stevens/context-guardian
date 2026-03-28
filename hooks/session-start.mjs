#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.mjs";
import { DATA_DIR, projectStateFiles } from "../lib/paths.mjs";

let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(`cg: failed to parse stdin: ${e.message}\n`);
	process.exit(0);
}

// Clean up session-scoped flags in the project's .claude/ directory.
// Only delete flags that are stale (older than 30 minutes) to avoid
// interfering with other active sessions in the same project.
// 30 minutes accommodates users who step away mid-menu (coffee, meetings).
const flagsDir = path.join(input.cwd || process.cwd(), ".claude");
const STALE_MS = 30 * 60 * 1000;
if (fs.existsSync(flagsDir)) {
	const now = Date.now();
	try {
		for (const f of fs
			.readdirSync(flagsDir)
			.filter((f) => f.startsWith("cg-"))) {
			const filePath = path.join(flagsDir, f);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > STALE_MS) {
					fs.unlinkSync(filePath);
				}
			} catch {}
		}
	} catch {}
}

// Clear stale resume prompt and cooldown from previous sessions.
// Only delete if older than STALE_MS — a fresh resume file may have just
// been created by the reload handler in another session's submit hook.
const pState = projectStateFiles(input.cwd);
const now2 = Date.now();
for (const f of [pState.resume, pState.cooldown]) {
	try {
		if (fs.existsSync(f) && now2 - fs.statSync(f).mtimeMs > STALE_MS) {
			fs.unlinkSync(f);
		}
	} catch {}
}

// Clean up stale session-scoped state files (state-*.json) in DATA_DIR.
// Each session writes its own state file; old ones accumulate.
if (fs.existsSync(DATA_DIR)) {
	try {
		const now3 = Date.now();
		for (const f of fs
			.readdirSync(DATA_DIR)
			.filter((f) => f.startsWith("state-") && f.endsWith(".json"))) {
			const filePath = path.join(DATA_DIR, f);
			try {
				if (now3 - fs.statSync(filePath).mtimeMs > STALE_MS) {
					fs.unlinkSync(filePath);
				}
			} catch {}
		}
	} catch {}
}

log(
	`session-start session=${input.session_id || "unknown"} cwd=${input.cwd || "unknown"}`,
);

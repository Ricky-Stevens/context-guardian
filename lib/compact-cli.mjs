#!/usr/bin/env node
/**
 * CLI entry point for manual compaction via skills.
 * Skills don't fire UserPromptSubmit, so this provides a direct path.
 *
 * Usage: node compact-cli.mjs <smart|recent> <session_id> <data_dir>
 * Output: single JSON line { success, statsBlock?, error? }
 */

// Set CLAUDE_PLUGIN_DATA before any module reads it (paths.mjs uses it at import time)
const [mode, sessionId, dataDir] = process.argv.slice(2);
if (dataDir) process.env.CLAUDE_PLUGIN_DATA = dataDir;

const fs = await import("node:fs");
const { performCompaction } = await import("./checkpoint.mjs");
const { log } = await import("./logger.mjs");
const { projectStateFiles, stateFile } = await import("./paths.mjs");

function out(obj) {
	process.stdout.write(JSON.stringify(obj));
}

if (mode !== "smart" && mode !== "recent") {
	out({ success: false, error: "Invalid mode. Use smart or recent." });
	process.exit(0);
}

let transcriptPath;
try {
	transcriptPath = JSON.parse(
		fs.readFileSync(stateFile(sessionId), "utf8"),
	).transcript_path;
} catch {
	out({ success: false, error: "No session data yet. Send a message first." });
	process.exit(0);
}

if (!transcriptPath || !fs.existsSync(transcriptPath)) {
	out({ success: false, error: "Transcript not found." });
	process.exit(0);
}

log(`compact-cli mode=${mode} session=${sessionId}`);
const pState = projectStateFiles(process.cwd());
const result = performCompaction({
	mode,
	transcriptPath,
	sessionId,
	originalPrompt: "",
	reloadPath: pState.reload,
});

if (!result) {
	const alt = mode === "smart" ? "/cg:prune" : "/cg:compact";
	out({ success: false, error: `No extractable content. Try ${alt} instead.` });
	process.exit(0);
}

try {
	fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
} catch {}

out({ success: true, statsBlock: result.statsBlock });

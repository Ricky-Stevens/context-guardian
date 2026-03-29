#!/usr/bin/env node
/**
 * CLI entry point for manual compaction via skills.
 * Skills don't fire UserPromptSubmit, so this provides a direct path.
 *
 * Usage: node compact-cli.mjs <smart|recent|handoff> <session_id> <data_dir> [label]
 * Output: single JSON line { success, statsBlock?, error? }
 */

// Set CLAUDE_PLUGIN_DATA before any module reads it (paths.mjs uses it at import time)
const [mode, sessionId, dataDir, ...labelParts] = process.argv.slice(2);
const label = labelParts.join(" ").trim() || "";
if (dataDir) process.env.CLAUDE_PLUGIN_DATA = dataDir;

const fs = await import("node:fs");
const { performCompaction } = await import("./checkpoint.mjs");
const { log } = await import("./logger.mjs");
const { projectStateFiles, stateFile } = await import("./paths.mjs");

function out(obj) {
	process.stdout.write(JSON.stringify(obj));
}

if (mode !== "smart" && mode !== "recent" && mode !== "handoff") {
	out({
		success: false,
		error: "Invalid mode. Use smart, recent, or handoff.",
	});
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

// ---------------------------------------------------------------------------
// Handoff mode — extract conversation and write to project dir for cross-
// session continuity. Does NOT write a reload flag (no /clear needed).
// ---------------------------------------------------------------------------
if (mode === "handoff") {
	const { performHandoff } = await import("./handoff.mjs");
	const result = performHandoff({ transcriptPath, sessionId, label });
	if (!result) {
		out({
			success: false,
			error: "No extractable content. Try sending a few messages first.",
		});
		process.exit(0);
	}
	out({ success: true, statsBlock: result.statsBlock });
	process.exit(0);
}

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

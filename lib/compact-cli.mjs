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

const crypto = await import("node:crypto");
const fs = await import("node:fs");
const { performCompaction } = await import("./checkpoint.mjs");
const { log } = await import("./logger.mjs");
const { stateFile } = await import("./paths.mjs");

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

// ---------------------------------------------------------------------------
// Handoff mode — extract conversation and write to project dir for cross-
// session continuity. Does not need /clear — handoff files persist across sessions.
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
	// Write synthetic JSONL for /resume cg:{label}
	let handoffLabel;
	try {
		const { writeSyntheticSession } = await import("./synthetic-session.mjs");
		handoffLabel =
			label || new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
		const { sessionUuid } = writeSyntheticSession({
			checkpointContent: fs.readFileSync(result.handoffPath, "utf8"),
			title: `cg:${handoffLabel}`,
			type: "handoff",
			projectCwd: process.cwd(),
		});
		log(`synthetic-session handoff uuid=${sessionUuid} label=${handoffLabel}`);
	} catch (e) {
		log(`synthetic-session-error: ${e.message}`);
	}
	const resumeTitle = `cg:${handoffLabel || "handoff"}`;
	out({
		success: true,
		statsBlock: result.statsBlock,
		resumeInstruction: `**To restore in a future session, type \`/resume ${resumeTitle}\`, or \`/resume\` to browse all sessions.**`,
	});
	process.exit(0);
}

const result = performCompaction({
	mode,
	transcriptPath,
	sessionId,
});

if (!result) {
	const alt = mode === "smart" ? "/cg:prune" : "/cg:compact";
	out({ success: false, error: `No extractable content. Try ${alt} instead.` });
	process.exit(0);
}

// Write synthetic JSONL for /resume cg:{hash}
let resumeTitle = "cg";
try {
	const { writeSyntheticSession } = await import("./synthetic-session.mjs");
	const shortHash = crypto.randomUUID().replaceAll("-", "").slice(0, 4);
	resumeTitle = `cg:${shortHash}`;
	const { sessionUuid } = writeSyntheticSession({
		checkpointContent: fs.readFileSync(result.checkpointPath, "utf8"),
		title: resumeTitle,
		type: "compact",
		projectCwd: process.cwd(),
	});
	log(`synthetic-session compact uuid=${sessionUuid}`);
} catch (e) {
	log(`synthetic-session-error: ${e.message}`);
}

// The resume instruction is a separate pre-formatted field so the SKILL.md
// can display it in bold after the box — no template interpolation by Claude.
out({
	success: true,
	statsBlock: result.statsBlock,
	resumeInstruction: `**Type \`/resume ${resumeTitle}\` to restore the compacted session.**`,
});

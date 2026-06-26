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
const path = await import("node:path");
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
let sessionModel;
let sessionCwd;
try {
	const state = JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8"));
	transcriptPath = state.transcript_path;
	// Model id for the synthetic session's assistant message (see
	// writeSyntheticSession). cc_model_id is authoritative; model is the fallback.
	sessionModel = state.cc_model_id || state.model;
	// CC's real project cwd, captured by the hooks from the hook input. Used for
	// the synthetic messages' `cwd` field and the handoff artifact directory.
	// NOT process.cwd(): a Bash `cd` into a subdir drifts process.cwd() away from
	// the project root. Falls back to process.cwd() for legacy state files.
	sessionCwd = state.cwd || process.cwd();
} catch {
	out({ success: false, error: "No session data yet. Send a message first." });
	process.exit(0);
}

if (!transcriptPath || !fs.existsSync(transcriptPath)) {
	out({ success: false, error: "Transcript not found." });
	process.exit(0);
}

// The session JSONL's own directory is the one CC's `/resume` searches. Deriving
// it from transcript_path (rather than recomputing from a cwd) guarantees the
// synthetic session lands where /resume looks, regardless of cwd drift.
const sessionsDir = path.dirname(transcriptPath);

log(`compact-cli mode=${mode} session=${sessionId}`);

// ---------------------------------------------------------------------------
// Handoff mode — extract conversation and write to project dir for cross-
// session continuity. Does not need /clear — handoff files persist across sessions.
// ---------------------------------------------------------------------------
if (mode === "handoff") {
	const { performHandoff } = await import("./handoff.mjs");
	const result = performHandoff({
		transcriptPath,
		sessionId,
		label,
		projectDir: sessionCwd,
	});
	if (!result) {
		out({
			success: false,
			error: "No extractable content. Try sending a few messages first.",
		});
		process.exit(0);
	}
	// Write synthetic JSONL for /resume cg:{label}
	let handoffLabel;
	let syntheticWritten = false;
	try {
		const { writeSyntheticSession } = await import("./synthetic-session.mjs");
		handoffLabel =
			label || new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
		const { sessionUuid } = writeSyntheticSession({
			checkpointContent: fs.readFileSync(result.handoffPath, "utf8"),
			title: `cg:${handoffLabel}`,
			type: "handoff",
			projectCwd: sessionCwd,
			sessionsDir,
			model: sessionModel,
		});
		syntheticWritten = true;
		log(`synthetic-session handoff uuid=${sessionUuid} label=${handoffLabel}`);
	} catch (e) {
		log(`synthetic-session-error: ${e.message}`);
	}
	const resumeTitle = `cg:${handoffLabel || "handoff"}`;
	out({
		success: true,
		statsBlock: result.statsBlock,
		// Only advertise /resume if the synthetic session actually landed —
		// otherwise the user would be pointed at a session that doesn't exist.
		resumeInstruction: syntheticWritten
			? `**To restore in a future session, type \`/resume ${resumeTitle}\`, or \`/resume\` to browse all sessions.**`
			: `**Handoff saved to \`${result.handoffPath}\`. The /resume quick-restore session could not be created — open the file directly to continue.**`,
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
let syntheticWritten = false;
try {
	const { writeSyntheticSession } = await import("./synthetic-session.mjs");
	const shortHash = crypto.randomUUID().replaceAll("-", "").slice(0, 4);
	resumeTitle = `cg:${shortHash}`;
	const { sessionUuid } = writeSyntheticSession({
		checkpointContent: fs.readFileSync(result.checkpointPath, "utf8"),
		title: resumeTitle,
		type: "compact",
		projectCwd: sessionCwd,
		sessionsDir,
		model: sessionModel,
	});
	syntheticWritten = true;
	log(`synthetic-session compact uuid=${sessionUuid}`);
} catch (e) {
	log(`synthetic-session-error: ${e.message}`);
}

// The resume instruction is a separate pre-formatted field so the SKILL.md
// can display it in bold after the box — no template interpolation by Claude.
// Only advertise /resume when the synthetic session was actually written;
// otherwise point the user at the on-disk checkpoint instead of a dead title.
out({
	success: true,
	statsBlock: result.statsBlock,
	resumeInstruction: syntheticWritten
		? `**Type \`/resume ${resumeTitle}\` to restore the compacted session.**`
		: `**Compaction complete, but the /resume session could not be created. Your checkpoint is saved at \`${result.checkpointPath}\`.**`,
});

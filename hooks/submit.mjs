#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Context Guardian's main entry point.
 *
 * Runs on every user message. Handles (in order):
 * 1. Manual compaction commands (/cg:compact, :prune)
 * 2. Resume detection ("resume" after /clear)
 * 3. Slash command bypass
 * 4. Checkpoint reload after /clear
 * 5. Token usage check + state file write (consumed by statusline and /cg:stats)
 *
 * The statusline is the primary UX for context pressure — no blocking or menus.
 * Heavy logic is delegated to lib/checkpoint.mjs and lib/reload-handler.mjs.
 *
 * @module submit-hook
 */
import fs from "node:fs";
import { performCompaction, writeCompactionState } from "../lib/checkpoint.mjs";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { estimateSavings } from "../lib/estimate.mjs";
import { log } from "../lib/logger.mjs";
import {
	atomicWriteFileSync,
	ensureDataDir,
	projectStateFiles,
	sessionFlags,
	stateFile,
} from "../lib/paths.mjs";
import { handleReload, handleResume } from "../lib/reload-handler.mjs";
import { estimateTokens, getTokenUsage } from "../lib/tokens.mjs";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(`cg: failed to parse stdin: ${e.message}\n`);
	process.exit(0);
}
const { session_id = "unknown", prompt, transcript_path } = input;

const flags = sessionFlags(input.cwd, session_id);
const pState = projectStateFiles(input.cwd);

// Ensure flags directory exists early — all code paths may write flag files
try {
	fs.mkdirSync(flags.dir, { recursive: true });
} catch {}

function output(obj) {
	process.stdout.write(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// 1. Manual compact — direct skill command OR legacy flag file
// ---------------------------------------------------------------------------
let cMode = null;
if (fs.existsSync(flags.compactMenu)) {
	cMode = (fs.readFileSync(flags.compactMenu, "utf8") || "").trim();
	fs.unlinkSync(flags.compactMenu);
} else {
	const p = (prompt || "").trim().toLowerCase();
	if (p.startsWith("/cg:compact")) cMode = "smart";
	else if (p.startsWith("/cg:prune")) cMode = "recent";
}

if (cMode) {
	if (cMode !== "smart" && cMode !== "recent") {
		log(`manual-compact-invalid-mode mode="${cMode}" session=${session_id}`);
		output({
			decision: "block",
			reason:
				"Context Guardian: invalid compaction mode. Use /cg:compact or /cg:prune.",
		});
		process.exit(0);
	}

	log(`manual-compact mode=${cMode} session=${session_id}`);
	const result = performCompaction({
		mode: cMode,
		transcriptPath: transcript_path,
		sessionId: session_id,
		originalPrompt: "",
		reloadPath: pState.reload,
	});

	if (!result) {
		log(`manual-compact-empty mode=${cMode} session=${session_id}`);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `[Context Guardian] Could not extract meaningful conversation content. Your session may consist primarily of tool interactions with minimal text. Try ${cMode === "smart" ? "/cg:prune" : "/cg:compact"} instead, or continue working.`,
			},
		});
		process.exit(0);
	}

	output({
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: `[Context Guardian] Manual compaction complete.\n\n${result.statsBlock}\n\nDisplay the stats box above verbatim. Then tell the user to type /clear to apply the compaction.`,
		},
	});
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Resume detection
// ---------------------------------------------------------------------------
if (handleResume(prompt, session_id, pState, output)) process.exit(0);

// ---------------------------------------------------------------------------
// 3. Slash command bypass (but write state preview if reload pending)
// ---------------------------------------------------------------------------
const trimmed = (prompt || "").trim().toLowerCase();
if (trimmed.startsWith("/")) {
	if (fs.existsSync(pState.reload)) {
		try {
			const rl = JSON.parse(fs.readFileSync(pState.reload, "utf8"));
			if (Date.now() - rl.ts < 10 * 60 * 1000 && rl.stats) {
				const pt = rl.stats.postTokens || 0;
				const pm = rl.stats.maxTokens || resolveMaxTokens() || 200000;
				writeCompactionState(
					session_id,
					transcript_path,
					pt,
					pm,
					"Context checkpoint ready — send a message to restore.",
				);
			}
		} catch {}
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Reload detection — inject checkpoint after /clear
// ---------------------------------------------------------------------------
if (
	handleReload({
		prompt,
		sessionId: session_id,
		transcriptPath: transcript_path,
		pState,
		flags,
		output,
	})
)
	process.exit(0);

// ---------------------------------------------------------------------------
// 5. Token usage check — write state for statusline and /cg:stats
// ---------------------------------------------------------------------------
if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

const cfg = loadConfig();
const threshold = cfg.threshold ?? 0.35;

const realUsage = getTokenUsage(transcript_path);
const currentTokens = realUsage
	? realUsage.current_tokens
	: estimateTokens(transcript_path);
const maxTokens = realUsage?.max_tokens || resolveMaxTokens() || 200000;
const pct = currentTokens / maxTokens;
const source = realUsage ? "real" : "estimated";

log(
	`check session=${session_id} tokens=${currentTokens}/${maxTokens} pct=${(pct * 100).toFixed(1)}% threshold=${(threshold * 100).toFixed(0)}% source=${source}`,
);

// Write state for statusline and /cg:stats
const headroom = Math.max(0, Math.round(maxTokens * threshold - currentTokens));
const pctDisplay = (pct * 100).toFixed(1);
const thresholdDisplay = Math.round(threshold * 100);
let recommendation;
if (pct < threshold * 0.5)
	recommendation = "All clear. Plenty of context remaining.";
else if (pct < threshold)
	recommendation = "Approaching threshold. Consider wrapping up complex tasks.";
else
	recommendation =
		"At threshold. Compaction recommended — run /cg:compact or /cg:prune.";

// Read measured baseline overhead from state (captured by stop hook on first response)
let baselineOverhead = 0;
try {
	const sf = stateFile(session_id);
	if (fs.existsSync(sf)) {
		const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
		baselineOverhead = prev.baseline_overhead ?? 0;
	}
} catch {}

const savings = estimateSavings(
	transcript_path,
	currentTokens,
	maxTokens,
	baselineOverhead,
);

try {
	ensureDataDir();
	atomicWriteFileSync(
		stateFile(session_id),
		JSON.stringify({
			current_tokens: currentTokens,
			max_tokens: maxTokens,
			pct,
			pct_display: pctDisplay,
			threshold,
			threshold_display: thresholdDisplay,
			headroom,
			recommendation,
			source,
			model: realUsage?.model || "unknown",
			smart_estimate_pct: savings.smartPct,
			recent_estimate_pct: savings.recentPct,
			baseline_overhead: baselineOverhead,
			session_id,
			transcript_path,
			ts: Date.now(),
		}),
	);
} catch (e) {
	log(`state-write-error session=${session_id}: ${e.message}`);
}

#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Context Guardian's main entry point.
 *
 * Runs on every user message. Writes token usage state for the statusline
 * and /cg:stats. Compaction is handled entirely by skills (compact-cli.mjs).
 *
 * @module submit-hook
 */
import fs from "node:fs";
import { adaptiveThreshold, resolveMaxTokens } from "../lib/config.mjs";
import { log } from "../lib/logger.mjs";
import {
	atomicWriteFileSync,
	ensureDataDir,
	STATUSLINE_STATE_DIR,
	stateFile,
	statuslineStateFile,
} from "../lib/paths.mjs";
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
const { session_id = "unknown", transcript_path } = input;

// ---------------------------------------------------------------------------
// Token usage check — write state for statusline and /cg:stats
// ---------------------------------------------------------------------------
if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

// Measure raw transcript file size — proxy for API request payload size.
// The ~20MB API payload limit is separate from the token context window and
// can lock users out of a session entirely (can't even compact).
let payloadBytes = 0;
try {
	payloadBytes = fs.statSync(transcript_path).size;
} catch {}

const realUsage = getTokenUsage(transcript_path);
const currentTokens = realUsage
	? realUsage.current_tokens
	: estimateTokens(transcript_path);
const source = realUsage ? "real" : "estimated";

// Read previous state for baseline overhead.
let baselineOverhead = 0;
try {
	const sf = stateFile(session_id);
	if (fs.existsSync(sf)) {
		const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
		baselineOverhead = prev.baseline_overhead ?? 0;
	}
} catch (e) {
	log(`state-read-error session=${session_id}: ${e.message}`);
}
// The statusline state file (~/.claude/cg/) is the primary source for
// context_window_size and model — the statusline receives these directly
// from Claude Code and is always authoritative, including after /model switches.
let ccContextWindowSize = null;
let ccModelId = null;
try {
	const slFile = statuslineStateFile(session_id);
	if (fs.existsSync(slFile)) {
		const slState = JSON.parse(fs.readFileSync(slFile, "utf8"));
		ccContextWindowSize = slState.context_window_size ?? null;
		ccModelId = slState.cc_model_id ?? null;
	}
} catch {}
const maxTokens = ccContextWindowSize || resolveMaxTokens() || 200000;
const threshold = adaptiveThreshold(maxTokens);
const pct = currentTokens / maxTokens;

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

try {
	ensureDataDir();
	const remaining = Math.max(
		0,
		Math.round(thresholdDisplay - Number.parseFloat(pctDisplay)),
	);
	const stateObj = {
		current_tokens: currentTokens,
		max_tokens: maxTokens,
		context_window_size: ccContextWindowSize,
		pct,
		pct_display: pctDisplay,
		threshold,
		threshold_display: thresholdDisplay,
		remaining_to_alert: remaining,
		headroom,
		recommendation,
		source,
		model: ccModelId || realUsage?.model || "unknown",
		baseline_overhead: baselineOverhead,
		payload_bytes: payloadBytes,
		session_id,
		transcript_path,
		ts: Date.now(),
	};
	const stateJson = JSON.stringify(stateObj);
	atomicWriteFileSync(stateFile(session_id), stateJson);

	// Also write to fixed fallback location so the statusline can find it
	// (statusline process doesn't receive CLAUDE_PLUGIN_DATA).
	const slFile = statuslineStateFile(session_id);
	if (slFile !== stateFile(session_id)) {
		fs.mkdirSync(STATUSLINE_STATE_DIR, { recursive: true });
		atomicWriteFileSync(slFile, stateJson);
	}
} catch (e) {
	log(`state-write-error session=${session_id}: ${e.message}`);
	process.stderr.write(`cg: state-write-error: ${e.message}\n`);
}

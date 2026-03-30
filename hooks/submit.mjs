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
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { estimateSavings } from "../lib/estimate.mjs";
import { log } from "../lib/logger.mjs";
import {
	atomicWriteFileSync,
	ensureDataDir,
	stateFile,
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

#!/usr/bin/env node
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
// Stop hook — writes fresh token counts after each assistant response.
//
// PERFORMANCE: Does NOT call estimateSavings (which reads the full transcript).
// The submit hook already computed and saved savings estimates. This hook only
// updates the token counts (cheap — tail-reads 32KB) and carries forward the
// existing savings estimates from the state file.
// ---------------------------------------------------------------------------
let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(`cg: failed to parse stdin: ${e.message}\n`);
	process.exit(0);
}

const { session_id = "unknown", transcript_path } = input;
log(`STOP session=${session_id}`);

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

// Don't overwrite a recent state file with estimated data — the reload handler
// or submit hook may have written accurate post-compaction counts that we'd clobber.
if (source === "estimated") {
	const sf = stateFile(session_id);
	try {
		const sfStat = fs.statSync(sf);
		if (Date.now() - sfStat.mtimeMs < 30000) {
			log(
				`state-skip session=${session_id} — not overwriting recent state with estimate`,
			);
			process.exit(0);
		}
	} catch {}
}

// Carry forward savings estimates and baseline overhead from the existing state file.
// This avoids re-reading and re-parsing the full transcript (~50MB at scale).
let smartEstimatePct = 0;
let recentEstimatePct = 0;
let baselineOverhead = 0;
try {
	const sf = stateFile(session_id);
	if (fs.existsSync(sf)) {
		const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
		smartEstimatePct = prev.smart_estimate_pct ?? 0;
		recentEstimatePct = prev.recent_estimate_pct ?? 0;
		baselineOverhead = prev.baseline_overhead ?? 0;
	}
} catch {}

// Capture baseline overhead on first response — at this point context is almost
// entirely system prompts, CLAUDE.md, tool definitions, etc. This measured value
// is used for all subsequent compaction estimates instead of guessing.
if (!baselineOverhead && currentTokens > 0) {
	baselineOverhead = currentTokens;
	log(`baseline-overhead session=${session_id} tokens=${baselineOverhead}`);

	// Recompute estimates now that we have the baseline — the submit hook ran
	// before us and wrote 0 estimates because it didn't have the baseline yet.
	try {
		const savings = estimateSavings(
			transcript_path,
			currentTokens,
			maxTokens,
			baselineOverhead,
		);
		smartEstimatePct = savings.smartPct;
		recentEstimatePct = savings.recentPct;
		log(
			`baseline-recompute session=${session_id} smart=${smartEstimatePct}% recent=${recentEstimatePct}%`,
		);
	} catch (e) {
		log(`baseline-recompute-error: ${e.message}`);
	}
}

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
			smart_estimate_pct: smartEstimatePct,
			recent_estimate_pct: recentEstimatePct,
			baseline_overhead: baselineOverhead,
			session_id,
			transcript_path,
			ts: Date.now(),
		}),
	);
} catch (e) {
	log(`state-write-error session=${session_id}: ${e.message}`);
}

log(
	`state-update session=${session_id} tokens=${currentTokens}/${maxTokens} pct=${pctDisplay}% source=${source}`,
);

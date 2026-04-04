#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { estimateSavings } from "../lib/estimate.mjs";
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

// Measure raw transcript file size — proxy for API request payload size.
let payloadBytes = 0;
try {
	payloadBytes = fs.statSync(transcript_path).size;
} catch {}

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

// Don't overwrite a recent state file with estimated data — checkpoint writes
// or the submit hook may have written accurate post-compaction counts that we'd clobber.
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
let baselineResponseCount = 0;
try {
	const sf = stateFile(session_id);
	if (fs.existsSync(sf)) {
		const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
		smartEstimatePct = prev.smart_estimate_pct ?? 0;
		recentEstimatePct = prev.recent_estimate_pct ?? 0;
		baselineOverhead = prev.baseline_overhead ?? 0;
		baselineResponseCount = prev.baseline_response_count ?? 0;
	}
} catch (e) {
	log(`state-read-error session=${session_id}: ${e.message}`);
}

if (baselineResponseCount < 2 && currentTokens > 0) {
	if (baselineOverhead) {
		baselineOverhead = Math.min(baselineOverhead, currentTokens);
	} else {
		baselineOverhead = currentTokens;
	}
	baselineResponseCount++;
	log(
		`baseline-overhead session=${session_id} tokens=${baselineOverhead} response=${baselineResponseCount}`,
	);

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
	const remaining = Math.max(
		0,
		Math.round(thresholdDisplay - Number.parseFloat(pctDisplay)),
	);
	const stateJson = JSON.stringify({
		current_tokens: currentTokens,
		max_tokens: maxTokens,
		pct,
		pct_display: pctDisplay,
		threshold,
		threshold_display: thresholdDisplay,
		remaining_to_alert: remaining,
		headroom,
		recommendation,
		source,
		model: realUsage?.model || "unknown",
		smart_estimate_pct: smartEstimatePct,
		recent_estimate_pct: recentEstimatePct,
		baseline_overhead: baselineOverhead,
		baseline_response_count: baselineResponseCount,
		payload_bytes: payloadBytes,
		session_id,
		transcript_path,
		ts: Date.now(),
	});
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

log(
	`state-update session=${session_id} tokens=${currentTokens}/${maxTokens} pct=${pctDisplay}% source=${source}`,
);

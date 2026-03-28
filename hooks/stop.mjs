#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { estimateSavings } from "../lib/estimate.mjs";
import { log } from "../lib/logger.mjs";
import { ensureDataDir, stateFile } from "../lib/paths.mjs";
import { estimateTokens, getTokenUsage } from "../lib/tokens.mjs";

// ---------------------------------------------------------------------------
// Stop hook — writes fresh token state after each assistant response.
// The transcript now contains the latest message.usage, so this gives
// the most up-to-date counts for /cg:stats.
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
		"At threshold. Compaction recommended — the warning menu will trigger on your next message.";

// Don't overwrite a recent state file with estimated data — the reload handler
// or submit hook may have written accurate post-compaction counts that we'd clobber.
if (source === "estimated") {
	const sf = stateFile(session_id);
	try {
		if (fs.existsSync(sf) && Date.now() - fs.statSync(sf).mtimeMs < 30000) {
			log(
				`state-skip session=${session_id} — not overwriting recent state with estimate`,
			);
			process.exit(0);
		}
	} catch {}
}

const savings = estimateSavings(transcript_path, currentTokens, maxTokens);

try {
	ensureDataDir();
	fs.writeFileSync(
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
			session_id,
			transcript_path,
			ts: Date.now(),
		}),
	);
} catch {}

log(
	`state-update session=${session_id} tokens=${currentTokens}/${maxTokens} pct=${pctDisplay}% source=${source}`,
);

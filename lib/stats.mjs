import { Buffer } from "node:buffer";

/**
 * Calculate compaction stats and format a display block.
 *
 * @param {number} preTokens  — token count before compaction (0 = unavailable)
 * @param {number} maxTokens  — context window limit
 * @param {string} checkpointContent — the exported checkpoint text
 * @returns {{ stats: object, block: string }}
 */
export function formatCompactionStats(
	preTokens,
	maxTokens,
	checkpointContent,
	{ hasOriginalPrompt = true, overhead = 0 } = {},
) {
	const postTokens =
		Math.round(Buffer.byteLength(checkpointContent, "utf8") / 4) + overhead;

	// If preTokens is missing/zero, stats are unreliable — show what we can.
	const hasPreData = preTokens > 0;
	const saved = hasPreData ? Math.max(0, preTokens - postTokens) : 0;
	const savedPct =
		hasPreData && preTokens > 0
			? ((saved / preTokens) * 100).toFixed(1)
			: "0.0";
	const prePct =
		hasPreData && maxTokens > 0
			? ((preTokens / maxTokens) * 100).toFixed(1)
			: "?";
	const postPct =
		maxTokens > 0 ? ((postTokens / maxTokens) * 100).toFixed(1) : "0.0";

	const stats = {
		preTokens,
		postTokens,
		maxTokens,
		saved,
		savedPct: parseFloat(savedPct),
		prePct: hasPreData ? parseFloat(prePct) : 0,
		postPct: parseFloat(postPct),
	};

	const resumeLines = hasOriginalPrompt
		? [
				`│  2. Type resume to pick up where you left off`,
				`│     (your previous prompt replays automatically)`,
			]
		: [];

	const beforeLine = hasPreData
		? `│  Before:  ${preTokens.toLocaleString()} tokens (~${prePct}% of context)`
		: `│  Before:  unknown (token data unavailable)`;
	const savedLine = hasPreData
		? `│  Saved:   ~${saved.toLocaleString()} tokens (${savedPct}% reduction)`
		: `│  Saved:   unknown`;

	const block = [
		`┌──────────────────────────────────────────────────────────────────────────────────────────────────`,
		`│  Compaction Stats`,
		`│`,
		beforeLine,
		`│  After:   ~${postTokens.toLocaleString()} tokens (~${postPct}% of context)`,
		savedLine,
		`├──────────────────────────────────────────────────────────────────────────────────────────────────`,
		`│`,
		`│  Checkpoint saved — NOT applied yet.`,
		`│`,
		`│  Next steps:`,
		`│  1. Type /clear to apply the compaction`,
		...resumeLines,
		`│`,
		`└──────────────────────────────────────────────────────────────────────────────────────────────────`,
	].join("\n");

	return { stats, block };
}

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
	{ overhead = 0, prePayloadBytes = 0 } = {},
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

	// Session size: transcript file + system overhead (before), checkpoint content (after)
	const overheadBytes = overhead * 4;
	const totalPreBytes = prePayloadBytes + overheadBytes;
	const postPayloadBytes = Buffer.byteLength(checkpointContent, "utf8");

	const stats = {
		preTokens,
		postTokens,
		maxTokens,
		saved,
		savedPct: Number.parseFloat(savedPct),
		prePct: hasPreData ? Number.parseFloat(prePct) : 0,
		postPct: Number.parseFloat(postPct),
		prePayloadBytes: totalPreBytes,
		postPayloadBytes,
	};

	const beforeLine = hasPreData
		? `│  Before:  ${preTokens.toLocaleString()} tokens (~${prePct}% of context)`
		: `│  Before:  unknown (token data unavailable)`;
	const savedLine = hasPreData
		? `│  Saved:   ~${saved.toLocaleString()} tokens (${savedPct}% reduction)`
		: `│  Saved:   unknown`;

	// Session size line — only shown if we have the pre-compaction file size
	const payloadLine =
		totalPreBytes > 0
			? `│  Session: ${Math.max(0.1, totalPreBytes / (1024 * 1024)).toFixed(1)}MB → ${Math.max(0.1, postPayloadBytes / (1024 * 1024)).toFixed(1)}MB`
			: "";

	const lines = [
		`┌──────────────────────────────────────────────────────────────────────────────────────────────────`,
		`│  Compaction Stats`,
		`│`,
		beforeLine,
		`│  After:   ~${postTokens.toLocaleString()} tokens (~${postPct}% of context)`,
		savedLine,
	];
	if (payloadLine) lines.push(payloadLine);
	lines.push(
		`│`,
		`└──────────────────────────────────────────────────────────────────────────────────────────────────`,
	);

	const block = lines.join("\n");

	return { stats, block };
}

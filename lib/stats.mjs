import { Buffer } from "node:buffer";

/**
 * Calculate compaction stats and format a display block.
 *
 * Reports what compaction actually removed from the transcript, not a
 * prediction of post-resume context size — that's unpredictable because
 * the new session captures its own baseline_overhead on its first stop.
 * Users get the real post-resume number from /cg:stats after restoring.
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
	const checkpointTokens = Math.round(
		Buffer.byteLength(checkpointContent, "utf8") / 4,
	);

	// Tokens removed = old conversation content - checkpoint content.
	// preTokens already includes baseline_overhead, so subtracting overhead +
	// checkpoint gives just the conversation content removed.
	const hasPreData = preTokens > 0;
	const removed = hasPreData
		? Math.max(0, preTokens - overhead - checkpointTokens)
		: 0;
	const prePct =
		hasPreData && maxTokens > 0
			? ((preTokens / maxTokens) * 100).toFixed(1)
			: "?";

	// Bytes are reported back to the caller (used by checkpoint.mjs for
	// logging), but no longer rendered into the box — those numbers were
	// confusing without context, and users get the live session size from
	// the statusline / /cg:stats anyway.
	const overheadBytes = overhead * 4;
	const totalPreBytes = prePayloadBytes + overheadBytes;
	const postPayloadBytes = Buffer.byteLength(checkpointContent, "utf8");

	const stats = {
		preTokens,
		checkpointTokens,
		maxTokens,
		removed,
		prePct: hasPreData ? Number.parseFloat(prePct) : 0,
		prePayloadBytes: totalPreBytes,
		postPayloadBytes,
	};

	const contextLine = hasPreData
		? `│  Context usage: ${preTokens.toLocaleString()} tokens (${prePct}%)`
		: `│  Context usage: unknown (token data unavailable)`;
	const strippedLine = hasPreData
		? `│  Stripped:      ~${removed.toLocaleString()} tokens of noise`
		: `│  Stripped:      unknown`;

	const lines = [
		`┌──────────────────────────────────────────────────────────────────────────────────────────────────`,
		`│  Compaction Stats`,
		`│`,
		contextLine,
		strippedLine,
		`│`,
		`└──────────────────────────────────────────────────────────────────────────────────────────────────`,
	];

	const block = lines.join("\n");

	return { stats, block };
}

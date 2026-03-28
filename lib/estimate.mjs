/**
 * Fast compaction savings estimator.
 *
 * Performs a single-pass byte categorisation of the transcript to estimate
 * how much context each compaction mode would save — WITHOUT running
 * the full extraction pipeline. Used to show estimated percentages in
 * the warning menu so the user can make an informed choice.
 *
 * @module estimate
 */

import fs from "node:fs";
import { estimateOverhead } from "./tokens.mjs";
import { readTranscriptLines } from "./transcript.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Estimated ratio of a tool_use summary vs the original input size.
 * Edit/Write keep ~80% (diffs preserved), Read/Grep/Glob keep ~5% (note only),
 * average across all tool types is roughly 15%.
 */
const TOOL_USE_SUMMARY_RATIO = 0.15;

// ---------------------------------------------------------------------------
// Main estimator
// ---------------------------------------------------------------------------

/**
 * Estimate post-compaction token percentages for Smart Compact and Keep Recent.
 *
 * Does a fast single-pass categorisation of transcript bytes into
 * "keep" vs "remove" buckets, then projects the savings onto the
 * real token count.
 *
 * @param {string} transcriptPath - Path to the JSONL transcript
 * @param {number} currentTokens - Current real token count from API
 * @param {number} maxTokens - Model's max token limit
 * @returns {{ smartPct: number, recentPct: number }} Estimated post-compaction percentages (0-100)
 */
export function estimateSavings(transcriptPath, currentTokens, maxTokens) {
	if (!transcriptPath) return { smartPct: 0, recentPct: 0 };
	try {
		fs.statSync(transcriptPath);
	} catch {
		return { smartPct: 0, recentPct: 0 };
	}

	try {
		const lines = readTranscriptLines(transcriptPath);
		const scan = categoriseBytes(lines);

		// Smart Compact: remove noise, keep content
		const totalBytes = scan.keepBytes + scan.removeBytes;
		if (totalBytes === 0) return { smartPct: 0, recentPct: 0 };

		// Per-session overhead (system prompt, tools, memory, skills).
		// Uses file-size-based estimate for consistency with checkpoint stats.
		const overhead = estimateOverhead(currentTokens, transcriptPath);
		const conversationTokens = currentTokens - overhead;

		const smartKeepRatio = scan.keepBytes / totalBytes;
		const smartTokens =
			Math.round(conversationTokens * smartKeepRatio) + overhead;
		const smartPct = Math.round((smartTokens / maxTokens) * 100);

		// Keep Recent: last 10 user exchanges, with same noise removal
		const recentRatio =
			scan.userExchanges > 0 ? Math.min(1, 10 / scan.userExchanges) : 1;
		const recentTokens =
			Math.round(conversationTokens * smartKeepRatio * recentRatio) + overhead;
		const recentPct = Math.round((recentTokens / maxTokens) * 100);

		return { smartPct, recentPct };
	} catch {
		return { smartPct: 0, recentPct: 0 };
	}
}

// ---------------------------------------------------------------------------
// Byte categorisation — single-pass scan
// ---------------------------------------------------------------------------

/**
 * Categorise transcript content bytes into "keep" vs "remove" buckets
 * and count user exchanges.
 *
 * @param {string[]} lines - JSONL transcript lines
 * @returns {{ keepBytes: number, removeBytes: number, userExchanges: number }}
 */
function categoriseBytes(lines) {
	let keepBytes = 0;
	let removeBytes = 0;
	let userExchanges = 0;

	for (const line of lines) {
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}

		// System / progress — entirely removed
		if (obj.type === "system" || obj.type === "progress") {
			removeBytes += Buffer.byteLength(line, "utf8");
			continue;
		}

		// Assistant messages — scan content blocks
		if (obj.type === "assistant" && obj.message?.content) {
			const content = obj.message.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						// Text blocks — kept in full
						keepBytes += Buffer.byteLength(block.text, "utf8");
					} else if (block.type === "tool_use" && block.input) {
						// Tool use — summary only (~15% of original)
						const inputBytes = Buffer.byteLength(
							JSON.stringify(block.input),
							"utf8",
						);
						keepBytes += Math.round(inputBytes * TOOL_USE_SUMMARY_RATIO);
						removeBytes += Math.round(
							inputBytes * (1 - TOOL_USE_SUMMARY_RATIO),
						);
					} else if (
						block.type === "thinking" ||
						block.type === "redacted_thinking"
					) {
						// Thinking — removed entirely
						const thinkBytes = block.thinking
							? Buffer.byteLength(block.thinking, "utf8")
							: 100;
						removeBytes += thinkBytes;
					}
				}
			} else if (typeof content === "string") {
				keepBytes += Buffer.byteLength(content, "utf8");
			}
			continue;
		}

		// User messages — categorise text vs tool_result
		if (obj.type === "user" && obj.message?.content) {
			const content = obj.message.content;

			if (typeof content === "string") {
				// Simple text — kept (unless it's a short confirmation, but
				// those are tiny and not worth detecting in the estimate)
				keepBytes += Buffer.byteLength(content, "utf8");
				userExchanges++;
				continue;
			}

			if (Array.isArray(content)) {
				let hasUserText = false;
				for (const block of content) {
					if (block.type === "text" && block.text) {
						keepBytes += Buffer.byteLength(block.text, "utf8");
						hasUserText = true;
					} else if (block.type === "tool_result") {
						// Most tool results are removed (Read, Edit, Grep results).
						// Bash and Agent results are kept but are a small minority.
						// Estimate: ~90% of tool_result bytes are removed.
						const resultBytes = block.content
							? Buffer.byteLength(
									typeof block.content === "string"
										? block.content
										: JSON.stringify(block.content),
									"utf8",
								)
							: 0;
						removeBytes += Math.round(resultBytes * 0.9);
						keepBytes += Math.round(resultBytes * 0.1);
					}
				}
				if (hasUserText) userExchanges++;
			}
		}
	}

	return { keepBytes, removeBytes, userExchanges };
}

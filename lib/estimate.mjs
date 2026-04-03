/**
 * Fast compaction savings estimator.
 *
 * Performs a single-pass byte categorisation of the transcript to estimate
 * how much context each compaction mode would save — WITHOUT running
 * the full extraction pipeline. Used by the statusline state and /cg:stats
 * to show estimated post-compaction percentages.
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
export function estimateSavings(
	transcriptPath,
	currentTokens,
	maxTokens,
	baselineOverhead = 0,
) {
	if (!transcriptPath || !Number.isFinite(maxTokens) || maxTokens <= 0) {
		return { smartPct: 0, recentPct: 0 };
	}
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
		// Uses measured baseline from first response when available.
		const overhead = estimateOverhead(
			currentTokens,
			transcriptPath,
			baselineOverhead,
		);
		const conversationTokens = Math.max(0, currentTokens - overhead);

		const smartKeepRatio = scan.keepBytes / totalBytes;
		const smartTokens =
			Math.round(conversationTokens * smartKeepRatio) + overhead;
		const smartPct = Number(((smartTokens / maxTokens) * 100).toFixed(1));

		// Keep Recent: last 10 user exchanges, with same noise removal
		const recentRatio =
			scan.userExchanges > 0 ? Math.min(1, 10 / scan.userExchanges) : 1;
		const recentTokens =
			Math.round(conversationTokens * smartKeepRatio * recentRatio) + overhead;
		const recentPct = Number(((recentTokens / maxTokens) * 100).toFixed(1));

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

		if (obj.type === "assistant" && obj.message?.content) {
			const result = categoriseAssistantContent(obj.message.content);
			keepBytes += result.keep;
			removeBytes += result.remove;
			continue;
		}

		if (obj.type === "user" && obj.message?.content) {
			const result = categoriseUserContent(obj.message.content);
			keepBytes += result.keep;
			removeBytes += result.remove;
			if (result.hasUserText) userExchanges++;
		}
	}

	return { keepBytes, removeBytes, userExchanges };
}

// ---------------------------------------------------------------------------
// Content block categorisation helpers
// ---------------------------------------------------------------------------

/**
 * Categorise bytes from a single assistant content block.
 * @param {object} block - A content block from an assistant message
 * @returns {{ keep: number, remove: number }}
 */
function categoriseAssistantBlock(block) {
	if (block.type === "text" && block.text) {
		return { keep: Buffer.byteLength(block.text, "utf8"), remove: 0 };
	}
	if (block.type === "tool_use" && block.input) {
		const inputBytes = Buffer.byteLength(JSON.stringify(block.input), "utf8");
		return {
			keep: Math.round(inputBytes * TOOL_USE_SUMMARY_RATIO),
			remove: Math.round(inputBytes * (1 - TOOL_USE_SUMMARY_RATIO)),
		};
	}
	if (block.type === "thinking" || block.type === "redacted_thinking") {
		const thinkBytes = block.thinking
			? Buffer.byteLength(block.thinking, "utf8")
			: 100;
		return { keep: 0, remove: thinkBytes };
	}
	return { keep: 0, remove: 0 };
}

/**
 * Categorise bytes from assistant message content (array or string).
 * @param {Array|string} content - The message.content field
 * @returns {{ keep: number, remove: number }}
 */
function categoriseAssistantContent(content) {
	if (typeof content === "string") {
		return { keep: Buffer.byteLength(content, "utf8"), remove: 0 };
	}
	if (!Array.isArray(content)) {
		return { keep: 0, remove: 0 };
	}

	let keep = 0;
	let remove = 0;
	for (const block of content) {
		const result = categoriseAssistantBlock(block);
		keep += result.keep;
		remove += result.remove;
	}
	return { keep, remove };
}

/**
 * Categorise bytes from a single user content block.
 * @param {object} block - A content block from a user message
 * @returns {{ keep: number, remove: number, isText: boolean }}
 */
function categoriseUserBlock(block) {
	if (block.type === "text" && block.text) {
		return {
			keep: Buffer.byteLength(block.text, "utf8"),
			remove: 0,
			isText: true,
		};
	}
	if (block.type === "tool_result") {
		const resultContent = block.content;
		let resultBytes;
		if (resultContent) {
			const raw =
				typeof resultContent === "string"
					? resultContent
					: JSON.stringify(resultContent);
			resultBytes = Buffer.byteLength(raw, "utf8");
		} else {
			resultBytes = 0;
		}
		return {
			keep: Math.round(resultBytes * 0.1),
			remove: Math.round(resultBytes * 0.9),
			isText: false,
		};
	}
	return { keep: 0, remove: 0, isText: false };
}

/**
 * Categorise bytes from user message content (array or string).
 * @param {Array|string} content - The message.content field
 * @returns {{ keep: number, remove: number, hasUserText: boolean }}
 */
function categoriseUserContent(content) {
	if (typeof content === "string") {
		return {
			keep: Buffer.byteLength(content, "utf8"),
			remove: 0,
			hasUserText: true,
		};
	}
	if (!Array.isArray(content)) {
		return { keep: 0, remove: 0, hasUserText: false };
	}

	let keep = 0;
	let remove = 0;
	let hasUserText = false;
	for (const block of content) {
		const result = categoriseUserBlock(block);
		keep += result.keep;
		remove += result.remove;
		if (result.isText) hasUserText = true;
	}
	return { keep, remove, hasUserText };
}

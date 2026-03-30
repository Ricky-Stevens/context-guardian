import fs from "node:fs";
import { contentBytesOf, flattenContent } from "./content.mjs";

// Matches any compact/restore marker that signals a compaction boundary.
const COMPACT_MARKER_RE = /^\[(SMART COMPACT|KEEP RECENT|RESTORED CONTEXT)/;

// ---------------------------------------------------------------------------
// Get real token usage from the transcript JSONL.
//
// Every assistant message includes `message.usage` with:
//   input_tokens, cache_creation_input_tokens, cache_read_input_tokens
//
// Total context used = input_tokens + cache_creation + cache_read
//
// Reads backwards from the end of the file for efficiency.
// Returns { current_tokens, output_tokens } or null if no usage data found.
// ---------------------------------------------------------------------------
export function getTokenUsage(transcriptPath) {
	if (!transcriptPath) return null;

	let stat;
	try {
		stat = fs.statSync(transcriptPath);
	} catch {
		return null;
	}

	// Tiered read: try a small chunk first (covers most cases where the last
	// assistant message is recent and short). Fall back to 2MB for large responses.
	const tiers = [32 * 1024, 2 * 1024 * 1024];
	const fd = fs.openSync(transcriptPath, "r");
	try {
		for (const tier of tiers) {
			const readSize = Math.min(stat.size, tier);
			const buf = Buffer.alloc(readSize);
			fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));

			const text = buf.toString("utf8");
			const lines = text.split("\n").filter((l) => l.trim());
			const result = _findUsage(lines);
			if (result) return result;
			// If file is smaller than tier, no point trying a bigger read
			if (stat.size <= tier) return null;
		}
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

function _findUsage(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(lines[i]);
			const usage = obj.message?.usage;
			if (usage && typeof usage.input_tokens === "number") {
				const inputTokens = usage.input_tokens || 0;
				const cacheCreate = usage.cache_creation_input_tokens || 0;
				const cacheRead = usage.cache_read_input_tokens || 0;
				const output = usage.output_tokens || 0;

				// Detect max_tokens from model name in the same message.
				// Only Opus 4.6+ has 1M tokens. Format: "claude-opus-4-6"
				const model = (obj.message?.model || "").toLowerCase();
				let max_tokens = 200000; // default for all Sonnet/Haiku/older Opus
				const opusMatch = model.match(/opus[- ]?(\d+)[- .]?(\d+)?/);
				if (opusMatch) {
					const major = parseInt(opusMatch[1], 10);
					const minor = parseInt(opusMatch[2] || "0", 10);
					if (major > 4 || (major === 4 && minor >= 6)) {
						max_tokens = 1000000;
					}
				}

				return {
					current_tokens: inputTokens + cacheCreate + cacheRead,
					output_tokens: output,
					max_tokens,
					model: obj.message?.model || "unknown",
				};
			}
		} catch {}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Byte-based token estimation — fallback when no usage data is available
// (e.g., very first message before any assistant response).
// Counts content bytes after the last compact marker, divides by 4.
// ---------------------------------------------------------------------------
export function estimateTokens(transcriptPath) {
	if (!transcriptPath) return 0;

	// Read the last ~1MB — enough to cover content since the last compact marker.
	let stat;
	try {
		stat = fs.statSync(transcriptPath);
	} catch {
		return 0;
	}
	const readSize = Math.min(stat.size, 1024 * 1024);
	const buf = Buffer.alloc(readSize);
	const fd = fs.openSync(transcriptPath, "r");
	try {
		fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
	} finally {
		fs.closeSync(fd);
	}

	const lines = buf
		.toString("utf8")
		.split("\n")
		.filter((l) => l.trim());

	let startIdx = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(lines[i]);
			const text = flattenContent(obj.message?.content);
			if (
				COMPACT_MARKER_RE.test(text) ||
				text.startsWith("# Context Checkpoint")
			) {
				startIdx = i;
				break;
			}
		} catch {}
	}

	let bytes = 0;
	for (let i = startIdx; i < lines.length; i++) {
		try {
			bytes += contentBytesOf(JSON.parse(lines[i]).message?.content);
		} catch {}
	}
	return Math.round(bytes / 4);
}

// ---------------------------------------------------------------------------
// Session overhead estimation — tokens from system prompt, tool definitions,
// memory files, and skills that survive compaction unchanged.
// Uses transcript file size / 4 to estimate conversation tokens, then
// subtracts from real token count. Both estimate.mjs and checkpoint.mjs
// use this for consistent predictions.
// ---------------------------------------------------------------------------
export function estimateOverhead(
	currentTokens,
	transcriptPath,
	baselineOverhead = 0,
) {
	// If we have a measured baseline from the first response, use it.
	// This was captured by the stop hook when context was almost entirely
	// system prompts, CLAUDE.md, tool definitions, etc.
	if (baselineOverhead > 0) return baselineOverhead;

	// Fallback: conservative minimum. System prompts + CLAUDE.md + tool
	// definitions are always present and can never be compacted away.
	const MIN_OVERHEAD = 15_000;

	if (!transcriptPath || !currentTokens) return MIN_OVERHEAD;
	try {
		const conversationTokens = Math.round(fs.statSync(transcriptPath).size / 4);
		const computed = Math.max(0, currentTokens - conversationTokens);
		return Math.max(MIN_OVERHEAD, computed);
	} catch {
		return MIN_OVERHEAD;
	}
}

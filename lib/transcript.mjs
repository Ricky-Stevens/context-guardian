/**
 * Transcript extraction for Context Guardian smart compaction.
 *
 * Reads Claude Code's JSONL transcript and produces a filtered, human-readable
 * checkpoint that preserves all decision-relevant content while removing
 * re-obtainable noise (file reads, thinking blocks, system messages).
 *
 * Two extraction modes:
 * - extractConversation (Smart Compact) — full history with preamble
 * - extractRecent (Keep Recent) — sliding window of last N messages
 *
 * @module transcript
 */

import fs from "node:fs";
import { flattenContent } from "./content.mjs";
import {
	generateStateHeader,
	isCGMenuMessage,
	processAssistantContent,
	processUserContent,
	shouldSkipUserMessage,
} from "./extract-helpers.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches any compact/restore marker that signals a compaction boundary. */
const COMPACT_MARKER_RE = /^\[(SMART COMPACT|KEEP RECENT|RESTORED CONTEXT)/;

/** Maximum bytes to read from a transcript to prevent OOM on large sessions. */
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Maximum preamble size. Beyond this, prior history is start+end trimmed
 * to prevent checkpoints growing unboundedly across compaction cycles.
 */
const MAX_PREAMBLE_CHARS = 30000;

// ---------------------------------------------------------------------------
// Transcript I/O
// ---------------------------------------------------------------------------

/**
 * Read transcript lines with a memory cap.
 * For files > MAX_READ_BYTES, reads only the tail and drops the first
 * partial line.
 *
 * @param {string} transcriptPath - Path to the JSONL transcript file
 * @returns {string[]} Array of non-empty JSON lines
 */
function readTranscriptLines(transcriptPath) {
	const stat = fs.statSync(transcriptPath);
	if (stat.size <= MAX_READ_BYTES) {
		return fs
			.readFileSync(transcriptPath, "utf8")
			.split("\n")
			.filter((l) => l.trim());
	}
	const buf = Buffer.alloc(MAX_READ_BYTES);
	const fd = fs.openSync(transcriptPath, "r");
	try {
		fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
	} finally {
		fs.closeSync(fd);
	}
	let text = buf.toString("utf8");
	const firstNewline = text.indexOf("\n");
	if (firstNewline > 0) text = text.slice(firstNewline + 1);
	return text.split("\n").filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// Shared extraction loop
// ---------------------------------------------------------------------------

/**
 * Core extraction loop shared by both Smart Compact and Keep Recent.
 * Processes all transcript lines and returns structured message data.
 *
 * @param {string[]} lines - JSONL transcript lines to process
 * @param {number} startIdx - Index to start processing from
 * @returns {{ messages: string[], filesModified: Set<string>, toolOpCount: number, parseErrors: number }}
 */
function extractMessages(lines, startIdx) {
	const toolUseMap = new Map();
	const messages = [];
	const filesModified = new Set();
	let toolOpCount = 0;
	let parseErrors = 0;
	let lastAssistantIsCGMenu = false;

	for (let i = startIdx; i < lines.length; i++) {
		let obj;
		try {
			obj = JSON.parse(lines[i]);
		} catch {
			parseErrors++;
			continue;
		}

		// ── Assistant messages ───────────────────────────────────────────
		if (obj.type === "assistant" && obj.message?.role === "assistant") {
			const content = obj.message.content;
			const processed = processAssistantContent(content, toolUseMap);

			// Track files modified and tool operation count
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_use") {
						toolOpCount++;
						const fp = block.input?.file_path || block.input?.path;
						if (fp && (block.name === "Edit" || block.name === "Write")) {
							filesModified.add(fp);
						}
					}
				}
			}

			lastAssistantIsCGMenu = isCGMenuMessage(content);

			if (processed) {
				messages.push(`**Assistant:** ${processed}`);
			}
			continue;
		}

		// ── User messages ───────────────────────────────────────────────
		if (obj.type === "user" && obj.message?.role === "user") {
			const { userText, toolResults } = processUserContent(
				obj.message.content,
				toolUseMap,
			);

			// Emit tool results (not user-typed — no **User:** prefix)
			for (const result of toolResults) {
				messages.push(result);
			}

			// Check skip rules for the human text portion
			const { skip, clearMenu } = shouldSkipUserMessage(
				userText,
				lastAssistantIsCGMenu,
			);
			if (clearMenu) lastAssistantIsCGMenu = false;
			if (skip) {
				if (!clearMenu) lastAssistantIsCGMenu = false;
				continue;
			}
			lastAssistantIsCGMenu = false;

			messages.push(`**User:** ${userText}`);
		}

		// System and progress messages — skip (noise)
	}

	return { messages, filesModified, toolOpCount, parseErrors };
}

// ---------------------------------------------------------------------------
// Smart Compact — full conversation extraction
// ---------------------------------------------------------------------------

/**
 * Extract the full conversation history from a transcript, preserving
 * tool summaries and edit diffs while removing re-obtainable noise.
 *
 * @param {string} transcriptPath - Path to the JSONL transcript
 * @returns {string} Formatted checkpoint content
 */
export function extractConversation(transcriptPath) {
	if (!transcriptPath || !fs.existsSync(transcriptPath))
		return "(no transcript available)";

	const lines = readTranscriptLines(transcriptPath);

	// Find the last compact marker (compaction boundary)
	let compactPreamble = "";
	let compactIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(lines[i]);
			const text = flattenContent(obj.message?.content).trim();
			if (
				COMPACT_MARKER_RE.test(text) ||
				text.startsWith("# Context Checkpoint")
			) {
				compactPreamble = text;
				compactIdx = i;
				break;
			}
		} catch {
			// Skip unparseable lines
		}
	}

	// Process messages after the boundary
	const { messages, filesModified, toolOpCount, parseErrors } = extractMessages(
		lines,
		compactIdx + 1,
	);

	// Build checkpoint: header + optional preamble + body
	const stateHeader = generateStateHeader(messages, filesModified, toolOpCount);

	// Apply start+end trim to preamble if present and oversized
	if (compactPreamble && compactPreamble.length > MAX_PREAMBLE_CHARS) {
		const half = Math.floor(MAX_PREAMBLE_CHARS / 2);
		const trimmed = compactPreamble.length - MAX_PREAMBLE_CHARS;
		compactPreamble =
			compactPreamble.slice(0, half) +
			`\n\n[...${trimmed} chars of prior history trimmed...]\n\n` +
			compactPreamble.slice(-half);
	}

	let result = `${stateHeader}\n\n---\n\n`;
	if (compactPreamble) result += `${compactPreamble}\n\n---\n\n`;
	result += messages.join("\n\n---\n\n");

	if (parseErrors > 0) {
		result += `\n\n> Warning: ${parseErrors} transcript line(s) could not be parsed and may be missing from this record.`;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Keep Recent — sliding window extraction
// ---------------------------------------------------------------------------

/**
 * Extract the last N user/assistant messages from the transcript.
 * Uses the same tool-aware processing as extractConversation but with
 * a sliding window instead of full history.
 *
 * @param {string} transcriptPath - Path to the JSONL transcript
 * @param {number} n - Number of messages to keep
 * @returns {string} Formatted checkpoint content
 */
export function extractRecent(transcriptPath, n) {
	if (!transcriptPath || !fs.existsSync(transcriptPath))
		return "(no transcript available)";

	const lines = readTranscriptLines(transcriptPath);

	// Process ALL lines (no boundary), then take last N
	const { messages, filesModified, toolOpCount, parseErrors } = extractMessages(
		lines,
		0,
	);

	const recent = messages.slice(-n);
	const stateHeader = generateStateHeader(recent, filesModified, toolOpCount);

	let result = `${stateHeader}\n\n---\n\n${recent.join("\n\n---\n\n")}`;

	if (parseErrors > 0) {
		result += `\n\n> Warning: ${parseErrors} transcript line(s) could not be parsed and may be missing from this record.`;
	}
	return result;
}

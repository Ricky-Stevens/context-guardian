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
import { compactMessages } from "./compact-output.mjs";
import { flattenContent } from "./content.mjs";
import {
	generateConversationIndex,
	generateStateHeader,
	isCGMenuMessage,
	processAssistantContent,
	processUserContent,
	shouldSkipUserMessage,
} from "./extract-helpers.mjs";
import { isErrorResponse, startEndTrim } from "./trim.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches any compact/restore marker that signals a compaction boundary. */
const COMPACT_MARKER_RE = /^\[(SMART COMPACT|KEEP RECENT|RESTORED CONTEXT)/;

/** Maximum bytes to read from a transcript to prevent OOM on large sessions.
 * 50MB supports ~800K tokens (80% of 1M context). At this scale the extraction
 * pipeline processes ~4000 JSONL lines in ~2 seconds — acceptable for a
 * compaction operation that runs at most a few times per session. */
const MAX_READ_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Maximum preamble size. Beyond this, prior history is start+end trimmed
 * to prevent checkpoints growing unboundedly across compaction cycles.
 */
const MAX_PREAMBLE_CHARS = 30000;

/** Regex to extract file paths from Edit/Write tool summaries. */
const EDIT_WRITE_RE = /→ (?:Edit|Write) `([^`]+)`/g;

/** Regex to detect tool operation lines (summaries and results). */
const TOOL_OP_RE = /^(?:\s*→ |← )/;

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
export function readTranscriptLines(transcriptPath) {
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
	const allToolPaths = []; // Collect paths inline for project root detection
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
						const fp =
							block.input?.file_path ||
							block.input?.path ||
							block.input?.relative_path ||
							"";
						if (fp && (block.name === "Edit" || block.name === "Write")) {
							filesModified.add(fp);
						}
						// Collect absolute paths for project root detection (inline)
						if (
							fp.startsWith("/") &&
							fp.split("/").filter(Boolean).length >= 3
						) {
							allToolPaths.push(fp);
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

	// Compute project root from collected paths (inline — no separate scan)
	const projectRoot = computeProjectRoot(allToolPaths);

	return { messages, filesModified, toolOpCount, parseErrors, projectRoot };
}

/**
 * Compute the most common directory prefix from collected tool file paths.
 * Equivalent to detectProjectRoot but works on a pre-collected path array
 * instead of re-parsing the entire transcript.
 */
function computeProjectRoot(paths) {
	if (paths.length < 3) return "";
	const counts = new Map();
	for (const p of paths) {
		const parts = p.split("/");
		for (let len = 3; len < parts.length; len++) {
			const prefix = `${parts.slice(0, len).join("/")}/`;
			counts.set(prefix, (counts.get(prefix) || 0) + 1);
		}
	}
	const maxCount = Math.max(...counts.values());
	const threshold = Math.floor(maxCount * 0.7);
	let best = "";
	for (const [prefix, count] of counts) {
		if (count >= threshold && prefix.length > best.length) best = prefix;
	}
	return best && counts.get(best) >= 3 ? best : "";
}

// ---------------------------------------------------------------------------
// Checkpoint footer — content pointers at the END (high-attention zone)
// ---------------------------------------------------------------------------
// The U-shaped attention curve means the END of context gets high attention.
// This footer "bookends" the checkpoint: the index at the START gives the
// model a map; the footer at the END reminds it what content exists in the
// body and where. Research (Liu et al. 2023 "Lost in the Middle") shows
// placing key information at BOTH ends improves recall significantly.
// ---------------------------------------------------------------------------

/**
 * Generate a compact pointer footer for the end of the checkpoint.
 * Lists content types present in the body with exchange numbers.
 * NOT a summary — purely navigational pointers.
 *
 * @param {string[]} messages - Extracted message strings
 * @returns {string} Footer section or "" if not worth adding
 */
function generateCheckpointFooter(messages) {
	if (messages.length < 15) return "";

	const editExchanges = [];
	const bashExchanges = [];
	const writeExchanges = [];
	const errorExchanges = [];
	let exchangeNum = 0;
	let totalUserExchanges = 0;

	for (const msg of messages) {
		if (msg.startsWith("**User:**")) {
			exchangeNum++;
			totalUserExchanges++;
		}

		// Scan for tool patterns — they may be prefixed with **Assistant:** on the same line
		// or on their own line after a newline. Use includes() for robustness.
		if (msg.includes("→ Edit ") && !editExchanges.includes(exchangeNum)) {
			editExchanges.push(exchangeNum);
		}
		if (msg.includes("→ Write ") && !writeExchanges.includes(exchangeNum)) {
			writeExchanges.push(exchangeNum);
		}
		if (msg.includes("→ Ran ") && !bashExchanges.includes(exchangeNum)) {
			bashExchanges.push(exchangeNum);
		}
		if (
			msg.startsWith("←") &&
			/\b(?:error|fail|FAIL)\b/i.test(msg) &&
			!errorExchanges.includes(exchangeNum)
		) {
			errorExchanges.push(exchangeNum);
		}
	}

	const parts = [];
	if (editExchanges.length > 0)
		parts.push(
			`${editExchanges.length} edit diffs [${editExchanges.join(",")}]`,
		);
	if (writeExchanges.length > 0)
		parts.push(
			`${writeExchanges.length} file creations [${writeExchanges.join(",")}]`,
		);
	if (bashExchanges.length > 0)
		parts.push(
			`${bashExchanges.length} command outputs [${bashExchanges.join(",")}]`,
		);
	if (errorExchanges.length > 0)
		parts.push(
			`${errorExchanges.length} error results [${errorExchanges.join(",")}]`,
		);

	if (parts.length === 0) return "";

	return [
		"### Checkpoint Contents",
		`This record contains ${parts.join(", ")}, across ${totalUserExchanges} user exchanges.`,
		"The **Conversation Index** at the top has the full reference. Check it before answering questions about this session.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Tiered compaction — post-processing for cold-tier messages
// ---------------------------------------------------------------------------

/** Max chars for assistant reasoning text in cold tier. */
const COLD_ASSISTANT_LIMIT = 500;
/** Max chars for tool results in cold tier. */
const COLD_RESULT_LIMIT = 200;

/**
 * Compute the tier for a given exchange based on distance from the end.
 * Hot (last 5): current fidelity. Warm (6-20): current fidelity.
 * Cold (21+): aggressive compression.
 *
 * @param {number} fromEnd - 1-based distance from the last exchange
 * @returns {"hot"|"warm"|"cold"}
 */
function computeTier(fromEnd) {
	if (fromEnd <= 5) return "hot";
	if (fromEnd <= 20) return "warm";
	return "cold";
}

/**
 * Compress an assistant message for cold tier.
 * Preserves tool invocation lines (→) and edit diffs verbatim.
 * Trims reasoning text to COLD_ASSISTANT_LIMIT.
 */
function compressColdAssistant(msg) {
	const prefix = "**Assistant:** ";
	const body = msg.startsWith(prefix) ? msg.slice(prefix.length) : msg;
	const lines = body.split("\n");
	const segments = []; // [{type: 'text'|'tool', content}]
	let textBuf = [];

	for (const line of lines) {
		if (line.startsWith("→ ")) {
			// Flush accumulated text
			if (textBuf.length > 0) {
				segments.push({ type: "text", content: textBuf.join("\n") });
				textBuf = [];
			}
			segments.push({ type: "tool", content: line });
		} else {
			textBuf.push(line);
		}
	}
	if (textBuf.length > 0) {
		segments.push({ type: "text", content: textBuf.join("\n") });
	}

	const compressed = segments.map((s) => {
		if (s.type === "tool") return s.content;
		// Trim reasoning text, but skip if it contains edit diffs (old:|new:)
		if (/^\s*(old|new): \|/m.test(s.content)) return s.content;
		return startEndTrim(s.content, COLD_ASSISTANT_LIMIT);
	});

	return `${prefix}${compressed.join("\n")}`;
}

/**
 * Compress a tool result line (← ...) for cold tier.
 * Errors are always kept. Short results are kept. Long results are stubbed.
 */
function compressColdResult(msg) {
	// Errors — always preserve
	if (isErrorResponse(msg)) return msg;
	// Short results — keep
	if (msg.length <= COLD_RESULT_LIMIT) return msg;
	// Long results — stub with first + last line
	return `← ${startEndTrim(msg.slice(2), COLD_RESULT_LIMIT)}`;
}

/**
 * Apply tiered compression to extracted messages.
 * Only cold-tier messages are modified. Hot and warm tiers are untouched.
 *
 * @param {string[]} messages - Extracted message strings from extractMessages
 * @returns {string[]} Messages with cold-tier compression applied
 */
export function applyTiers(messages) {
	// Find user exchange boundaries (indices of **User:** messages)
	const exchangeStarts = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].startsWith("**User:**")) exchangeStarts.push(i);
	}

	const total = exchangeStarts.length;
	if (total <= 20) return messages; // No cold tier content — nothing to do

	// Build tier map: message index → tier
	const tierMap = new Array(messages.length).fill("cold");

	for (let e = 0; e < total; e++) {
		const fromEnd = total - e;
		const tier = computeTier(fromEnd);
		const start = exchangeStarts[e];
		const end = e + 1 < total ? exchangeStarts[e + 1] : messages.length;
		for (let i = start; i < end; i++) {
			tierMap[i] = tier;
		}
	}

	// Messages before the first user exchange inherit cold tier (tool results
	// from before any user text — already set by fill('cold'))

	// Post-process cold-tier messages
	return messages.map((msg, i) => {
		if (tierMap[i] !== "cold") return msg;

		// User messages — NEVER compress
		if (msg.startsWith("**User:**")) return msg;

		// Assistant messages — trim reasoning, keep tool invocations
		if (msg.startsWith("**Assistant:**")) return compressColdAssistant(msg);

		// Tool results (← lines)
		if (msg.startsWith("←")) return compressColdResult(msg);

		// Anything else — keep as-is
		return msg;
	});
}

// ---------------------------------------------------------------------------
// Edit coalescing — merge repeated edits to the same file region
// ---------------------------------------------------------------------------

/** Regex to match an Edit summary header line: → Edit `filepath`: */
const EDIT_HEADER_RE = /^→ Edit `([^`]+)`:/;

/**
 * Parse an edit block from an assistant message line set.
 * Returns { filePath, oldStr, newStr } or null if not parseable.
 */
function parseEditBlock(editText) {
	const headerMatch = editText.match(EDIT_HEADER_RE);
	if (!headerMatch) return null;
	const filePath = headerMatch[1];

	let oldStr = "";
	let newStr = "";
	const lines = editText.split("\n");
	let section = null; // 'old' | 'new'

	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i].trimStart();
		if (trimmed.startsWith("old: |")) {
			section = "old";
			continue;
		}
		if (trimmed.startsWith("new: |")) {
			section = "new";
			continue;
		}
		// Content lines are indented 6 spaces under the section header
		if (section === "old") oldStr += `${oldStr ? "\n" : ""}${lines[i]}`;
		if (section === "new") newStr += `${newStr ? "\n" : ""}${lines[i]}`;
	}

	return { filePath, oldStr: oldStr.trim(), newStr: newStr.trim() };
}

/**
 * Coalesce repeated edits to the same file within assistant messages.
 *
 * When a file is edited N times, keeps the first edit's old_string and the
 * last edit's new_string, replacing intermediate edits with a marker.
 * Only coalesces edits to the same file — edits to different files are
 * always kept independently.
 *
 * @param {string[]} messages - Extracted message strings
 * @returns {string[]} Messages with coalesced edits
 */
export function coalesceEdits(messages) {
	// Track edit locations: filePath → [{msgIdx, editStart, editEnd, parsed}]
	const editMap = new Map();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg.startsWith("**Assistant:**")) continue;

		// Find all edit blocks within this assistant message
		const lines = msg.split("\n");
		let editStart = -1;
		for (let l = 0; l < lines.length; l++) {
			if (EDIT_HEADER_RE.test(lines[l])) {
				// If we were tracking a previous edit, close it
				if (editStart >= 0) {
					const editText = lines.slice(editStart, l).join("\n");
					const parsed = parseEditBlock(editText);
					if (parsed) {
						const key = parsed.filePath;
						if (!editMap.has(key)) editMap.set(key, []);
						editMap.get(key).push({ msgIdx: i, editStart, editEnd: l, parsed });
					}
				}
				editStart = l;
			}
		}
		// Close the last edit in this message
		if (editStart >= 0) {
			const editText = lines.slice(editStart).join("\n");
			const parsed = parseEditBlock(editText);
			if (parsed) {
				const key = parsed.filePath;
				if (!editMap.has(key)) editMap.set(key, []);
				editMap.get(key).push({
					msgIdx: i,
					editStart,
					editEnd: lines.length,
					parsed,
				});
			}
		}
	}

	// Find coalescing chains: only merge edits where a later edit's old_string
	// contains content from the previous edit's new_string (same region).
	// Edits to different regions of the same file stay independent.
	const toCoalesce = new Map();
	for (const [filePath, edits] of editMap) {
		if (edits.length < 2) continue;
		// Build chains of overlapping edits
		const chains = [[edits[0]]];
		for (let i = 1; i < edits.length; i++) {
			const prev = chains[chains.length - 1];
			const lastInChain = prev[prev.length - 1];
			// Check if this edit's old_string overlaps with the previous edit's
			// new_string (they modify the same region)
			const prevNew = lastInChain.parsed.newStr;
			const currOld = edits[i].parsed.oldStr;
			if (prevNew && currOld && prevNew.includes(currOld)) {
				prev.push(edits[i]);
			} else {
				chains.push([edits[i]]);
			}
		}
		for (const chain of chains) {
			if (chain.length >= 2) {
				toCoalesce.set(`${filePath}:${chain[0].editStart}`, chain);
			}
		}
	}

	if (toCoalesce.size === 0) return messages;

	// Build set of edits to remove (intermediate ones) and the last edit to replace
	const removeEdits = new Set(); // "msgIdx:editStart" keys
	const replaceEdits = new Map(); // "msgIdx:editStart" → replacement text

	for (const [, edits] of toCoalesce) {
		const first = edits[0];
		const last = edits[edits.length - 1];
		const filePath = first.parsed.filePath;

		// Remove all intermediate edits (not first, not last)
		for (let i = 1; i < edits.length - 1; i++) {
			removeEdits.add(`${edits[i].msgIdx}:${edits[i].editStart}`);
		}

		// Remove the first edit (will be replaced by coalesced version at last position)
		removeEdits.add(`${first.msgIdx}:${first.editStart}`);

		// Build coalesced edit text at the last position
		const count = edits.length;
		const header = `→ Edit \`${filePath}\` [${count} edits coalesced]:`;
		const parts = [header];
		if (first.parsed.oldStr) {
			parts.push("      old: |");
			parts.push(
				first.parsed.oldStr
					.split("\n")
					.map((l) => `        ${l}`)
					.join("\n"),
			);
		}
		if (last.parsed.newStr) {
			parts.push("      new: |");
			parts.push(
				last.parsed.newStr
					.split("\n")
					.map((l) => `        ${l}`)
					.join("\n"),
			);
		} else if (first.parsed.newStr && edits.length === 2) {
			// If last has no newStr (deletion), still show it
			parts.push("      new: | [deleted]");
		}

		replaceEdits.set(`${last.msgIdx}:${last.editStart}`, parts.join("\n"));
	}

	// Rebuild messages with coalesced edits
	return messages.map((msg, i) => {
		if (!msg.startsWith("**Assistant:**")) return msg;

		const lines = msg.split("\n");
		const result = [];
		let editStart = -1;

		for (let l = 0; l <= lines.length; l++) {
			const isEditHeader = l < lines.length && EDIT_HEADER_RE.test(lines[l]);
			const isEnd = l === lines.length;

			if ((isEditHeader || isEnd) && editStart >= 0) {
				// Close previous edit block
				const key = `${i}:${editStart}`;
				if (removeEdits.has(key)) {
					// Skip — this edit is removed (intermediate or first in chain)
				} else if (replaceEdits.has(key)) {
					result.push(replaceEdits.get(key));
				} else {
					result.push(...lines.slice(editStart, l));
				}
				editStart = -1;
			}

			if (isEditHeader) {
				editStart = l;
			} else if (editStart < 0 && !isEnd) {
				result.push(lines[l]);
			}
		}

		return result.join("\n");
	});
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
	const { messages, filesModified, toolOpCount, parseErrors, projectRoot } =
		extractMessages(lines, compactIdx + 1);

	// Apply tiered compression — cold-tier messages get aggressive trimming
	const tieredMessages = applyTiers(messages);

	// Coalesce repeated edits to the same file into net-diffs
	const coalescedMessages = coalesceEdits(tieredMessages);

	// Build checkpoint: header + fact index + optional preamble + body
	// Use original messages for state header and fact index (full fidelity)
	const stateHeader = generateStateHeader(messages, filesModified, toolOpCount);
	const factIndex = generateConversationIndex(messages);

	// Apply start+end trim to preamble if present and oversized
	if (compactPreamble && compactPreamble.length > MAX_PREAMBLE_CHARS) {
		const half = Math.floor(MAX_PREAMBLE_CHARS / 2);
		const trimmed = compactPreamble.length - MAX_PREAMBLE_CHARS;
		compactPreamble =
			compactPreamble.slice(0, half) +
			`\n\n[...${trimmed} chars of prior history trimmed...]\n\n` +
			compactPreamble.slice(-half);
	}

	const merged = compactMessages(coalescedMessages);
	let result = `${stateHeader}\n\n`;
	if (factIndex) result += `${factIndex}\n\n`;
	result += `---\n\n`;
	if (compactPreamble) result += `${compactPreamble}\n\n---\n\n`;
	result += merged.join("\n\n---\n\n");

	if (parseErrors > 0) {
		result += `\n\n> Warning: ${parseErrors} transcript line(s) could not be parsed and may be missing from this record.`;
	}

	// Append footer with content pointers (high-attention end zone)
	const footer = generateCheckpointFooter(messages);
	if (footer) result += `\n\n---\n\n${footer}`;

	// R1: Strip project root from paths to reduce noise
	if (projectRoot) result = result.replaceAll(projectRoot, "");

	// R5: Shorten prefixes for token efficiency — markdown bold serves
	// no purpose in additionalContext injection, and shorter prefixes
	// save ~300 tokens across a typical checkpoint.
	result = result.replaceAll("**User:**", "User:");
	result = result.replaceAll("**Assistant:**", "Asst:");

	return result;
}

// ---------------------------------------------------------------------------
// Keep Recent — exchange-based sliding window extraction
// ---------------------------------------------------------------------------

/**
 * Extract the last N user exchanges from the transcript.
 *
 * An "exchange" is a user message plus everything that follows it (assistant
 * responses, tool summaries, tool results) up to the next user message.
 * This groups logical conversations together so tool results and multi-step
 * assistant work don't consume slots in the window.
 *
 * @param {string} transcriptPath - Path to the JSONL transcript
 * @param {number} n - Number of user exchanges to keep (default 10)
 * @returns {string} Formatted checkpoint content
 */
export function extractRecent(transcriptPath, n = 10) {
	if (!transcriptPath || !fs.existsSync(transcriptPath))
		return "(no transcript available)";

	const lines = readTranscriptLines(transcriptPath);

	// Process ALL lines, then window by user exchanges
	const { messages, parseErrors, projectRoot } = extractMessages(lines, 0);

	// Find indices of all **User:** entries
	const userIndices = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].startsWith("**User:**")) userIndices.push(i);
	}

	// Take from the Nth-from-last user message to the end
	let recent;
	if (userIndices.length <= n) {
		recent = messages;
	} else {
		const cutIdx = userIndices[userIndices.length - n];
		recent = messages.slice(cutIdx);
	}

	// Compute files modified and tool ops from WINDOWED content only
	const windowFiles = new Set();
	let windowToolOps = 0;
	for (const msg of recent) {
		for (const match of msg.matchAll(EDIT_WRITE_RE)) {
			windowFiles.add(match[1]);
		}
		// Count tool operation lines within each message
		for (const line of msg.split("\n")) {
			if (TOOL_OP_RE.test(line)) windowToolOps++;
		}
	}

	const stateHeader = generateStateHeader(recent, windowFiles, windowToolOps);

	const merged = compactMessages(recent);
	let result = `${stateHeader}\n\n---\n\n${merged.join("\n\n---\n\n")}`;

	if (parseErrors > 0) {
		result += `\n\n> Warning: ${parseErrors} transcript line(s) could not be parsed and may be missing from this record.`;
	}

	if (projectRoot) result = result.replaceAll(projectRoot, "");

	// Shorten prefixes for token efficiency (same as extractConversation)
	result = result.replaceAll("**User:**", "User:");
	result = result.replaceAll("**Assistant:**", "Asst:");

	return result;
}

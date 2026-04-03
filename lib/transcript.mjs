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
	isSyntheticAck,
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
// Shared extraction loop — helpers
// ---------------------------------------------------------------------------

/**
 * Extract file path from a tool_use content block.
 * @param {object} block - A tool_use content block
 * @returns {string} The file path or ""
 */
function getToolFilePath(block) {
	return (
		block.input?.file_path ||
		block.input?.path ||
		block.input?.relative_path ||
		""
	);
}

/**
 * Track tool usage stats from an assistant content block.
 * Mutates filesModified, allToolPaths, and returns incremented toolOpCount.
 */
function trackToolBlock(block, filesModified, allToolPaths) {
	const fp = getToolFilePath(block);
	if (fp && (block.name === "Edit" || block.name === "Write")) {
		filesModified.add(fp);
	}
	if (fp.startsWith("/") && fp.split("/").filter(Boolean).length >= 3) {
		allToolPaths.push(fp);
	}
}

/**
 * Process a single assistant-type transcript line.
 * Returns the formatted message string or null if skipped.
 */
function processAssistantLine(obj, toolUseMap, filesModified, allToolPaths) {
	const content = obj.message.content;
	const processed = processAssistantContent(content, toolUseMap);
	let toolOps = 0;

	if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === "tool_use") {
				toolOps++;
				trackToolBlock(block, filesModified, allToolPaths);
			}
		}
	}

	const isCGMenu = isCGMenuMessage(content);
	const message =
		processed && !isSyntheticAck(processed)
			? `**Assistant:** ${processed}`
			: null;

	return { message, isCGMenu, toolOps };
}

/**
 * Process a single user-type transcript line.
 * Returns tool result messages, the user message (or null), and menu state info.
 */
function processUserLine(obj, toolUseMap, lastAssistantIsCGMenu) {
	const { userText, toolResults } = processUserContent(
		obj.message.content,
		toolUseMap,
	);

	const { skip, clearMenu } = shouldSkipUserMessage(
		userText,
		lastAssistantIsCGMenu,
	);

	const userMessage = skip ? null : `**User:** ${userText}`;

	return { toolResults, userMessage, skip, clearMenu };
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
function handleAssistantEntry(obj, state) {
	const result = processAssistantLine(
		obj,
		state.toolUseMap,
		state.filesModified,
		state.allToolPaths,
	);
	state.toolOpCount += result.toolOps;
	state.lastAssistantIsCGMenu = result.isCGMenu;
	if (result.message) state.messages.push(result.message);
}

function handleUserEntry(obj, state) {
	const result = processUserLine(
		obj,
		state.toolUseMap,
		state.lastAssistantIsCGMenu,
	);

	for (const tr of result.toolResults) {
		state.messages.push(tr);
	}

	if (result.clearMenu) state.lastAssistantIsCGMenu = false;
	if (result.skip) {
		if (!result.clearMenu) state.lastAssistantIsCGMenu = false;
		return;
	}
	state.lastAssistantIsCGMenu = false;

	if (result.userMessage) state.messages.push(result.userMessage);
}

function extractMessages(lines, startIdx) {
	const state = {
		toolUseMap: new Map(),
		messages: [],
		filesModified: new Set(),
		allToolPaths: [],
		toolOpCount: 0,
		parseErrors: 0,
		lastAssistantIsCGMenu: false,
	};

	for (let i = startIdx; i < lines.length; i++) {
		let obj;
		try {
			obj = JSON.parse(lines[i]);
		} catch {
			state.parseErrors++;
			continue;
		}

		if (obj.type === "assistant" && obj.message?.role === "assistant") {
			handleAssistantEntry(obj, state);
		} else if (obj.type === "user" && obj.message?.role === "user") {
			handleUserEntry(obj, state);
		}
		// System and progress messages — skip (noise)
	}

	const projectRoot = computeProjectRoot(state.allToolPaths);

	return {
		messages: state.messages,
		filesModified: state.filesModified,
		toolOpCount: state.toolOpCount,
		parseErrors: state.parseErrors,
		projectRoot,
	};
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
 * Classify a message and record its exchange number in the appropriate bucket.
 * @param {string} msg - A message string
 * @param {number} exchangeNum - Current exchange number
 * @param {object} buckets - { edit, write, bash, error } arrays
 */
function classifyFooterMessage(msg, exchangeNum, buckets) {
	if (msg.includes("→ Edit ") && !buckets.edit.includes(exchangeNum)) {
		buckets.edit.push(exchangeNum);
	}
	if (msg.includes("→ Write ") && !buckets.write.includes(exchangeNum)) {
		buckets.write.push(exchangeNum);
	}
	if (msg.includes("→ Ran ") && !buckets.bash.includes(exchangeNum)) {
		buckets.bash.push(exchangeNum);
	}
	if (
		msg.startsWith("←") &&
		/\b(?:error|fail|FAIL)\b/i.test(msg) &&
		!buckets.error.includes(exchangeNum)
	) {
		buckets.error.push(exchangeNum);
	}
}

/**
 * Format footer parts from classified exchange buckets.
 * @param {object} buckets - { edit, write, bash, error } arrays
 * @returns {string[]} Formatted part strings
 */
function formatFooterParts(buckets) {
	const parts = [];
	if (buckets.edit.length > 0)
		parts.push(`${buckets.edit.length} edit diffs [${buckets.edit.join(",")}]`);
	if (buckets.write.length > 0)
		parts.push(
			`${buckets.write.length} file creations [${buckets.write.join(",")}]`,
		);
	if (buckets.bash.length > 0)
		parts.push(
			`${buckets.bash.length} command outputs [${buckets.bash.join(",")}]`,
		);
	if (buckets.error.length > 0)
		parts.push(
			`${buckets.error.length} error results [${buckets.error.join(",")}]`,
		);
	return parts;
}

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

	const buckets = { edit: [], write: [], bash: [], error: [] };
	let exchangeNum = 0;
	let totalUserExchanges = 0;

	for (const msg of messages) {
		if (msg.startsWith("**User:**")) {
			exchangeNum++;
			totalUserExchanges++;
		}
		classifyFooterMessage(msg, exchangeNum, buckets);
	}

	const parts = formatFooterParts(buckets);
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
 * Tier boundaries — number of user exchanges from the end of the conversation.
 *
 * HOT  (≤5 from end):  Full fidelity — no compression at all.
 * WARM (6–20 from end): Full fidelity — preserved for medium-term recall.
 * COLD (>20 from end):  Aggressive trimming — assistant text capped at
 *                       COLD_ASSISTANT_LIMIT, tool results at COLD_RESULT_LIMIT.
 *
 * Rationale: the most recent exchanges are actively referenced; older exchanges
 * mostly matter for their decisions and edit diffs (which are never trimmed).
 * The warm tier exists as a buffer so context doesn't cliff-edge from full to
 * aggressively trimmed. 20 exchanges ≈ a substantial coding sub-session.
 *
 * User messages are NEVER compressed regardless of tier.
 */
const HOT_TIER_BOUNDARY = 5;
const WARM_TIER_BOUNDARY = 20;

/**
 * Compute the tier for a given exchange based on distance from the end.
 *
 * @param {number} fromEnd - 1-based distance from the last exchange
 * @returns {"hot"|"warm"|"cold"}
 */
function computeTier(fromEnd) {
	if (fromEnd <= HOT_TIER_BOUNDARY) return "hot";
	if (fromEnd <= WARM_TIER_BOUNDARY) return "warm";
	return "cold";
}

/** Keywords that indicate a decision or architectural reasoning worth preserving. */
/** Intentionally narrow — "because" and "approach" are too common in general text. */
const DECISION_RE_1 =
	/\b(?:decided to|chose .+ over|went with|trade-?off|rationale)\b/i;
const DECISION_RE_2 =
	/\b(?:design decision|instead of .+ because|pros? and cons?|reject(?:ed|ing) .+ in favou?r)\b/i;

/** Test whether text contains decision keywords (split for regex complexity). */
function isDecisionText(text) {
	return DECISION_RE_1.test(text) || DECISION_RE_2.test(text);
}

/**
 * Compress an assistant message for cold tier.
 * Preserves tool invocation lines (→) and edit diffs verbatim.
 * Trims reasoning text to COLD_ASSISTANT_LIMIT.
 * Messages containing decision keywords get a higher limit to preserve reasoning.
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

	// Decision-containing messages get 3x the limit to preserve architectural reasoning
	const limit = isDecisionText(body)
		? COLD_ASSISTANT_LIMIT * 3
		: COLD_ASSISTANT_LIMIT;

	const compressed = segments.map((s) => {
		if (s.type === "tool") return s.content;
		// Trim reasoning text, but skip if it contains edit diffs (old:|new:)
		if (/^\s*(old|new): \|/m.test(s.content)) return s.content;
		return startEndTrim(s.content, limit);
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
	if (total <= WARM_TIER_BOUNDARY) return messages; // No cold tier content — nothing to do

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
 * Accumulate a content line into the appropriate section buffer.
 * @param {string} section - "old" | "new" | null
 * @param {string} line - The raw line
 * @param {string} oldStr - Accumulated old string
 * @param {string} newStr - Accumulated new string
 * @returns {{ oldStr: string, newStr: string }}
 */
function accumulateEditLine(section, line, oldStr, newStr) {
	if (section === "old") {
		oldStr += `${oldStr ? "\n" : ""}${line}`;
	}
	if (section === "new") {
		newStr += `${newStr ? "\n" : ""}${line}`;
	}
	return { oldStr, newStr };
}

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
		const acc = accumulateEditLine(section, lines[i], oldStr, newStr);
		oldStr = acc.oldStr;
		newStr = acc.newStr;
	}

	return { filePath, oldStr: oldStr.trim(), newStr: newStr.trim() };
}

/**
 * Record a parsed edit into the editMap under its file path key.
 * @param {Map} editMap - filePath → edit entry array
 * @param {object} parsed - Parsed edit { filePath, oldStr, newStr }
 * @param {number} msgIdx - Message index
 * @param {number} editStart - Line index where edit starts
 * @param {number} editEnd - Line index where edit ends
 */
function recordEdit(editMap, parsed, msgIdx, editStart, editEnd) {
	const key = parsed.filePath;
	if (!editMap.has(key)) editMap.set(key, []);
	editMap.get(key).push({ msgIdx, editStart, editEnd, parsed });
}

/**
 * Collect all edit blocks from a single assistant message.
 * @param {string} msg - The assistant message string
 * @param {number} msgIdx - Index of this message in the messages array
 * @param {Map} editMap - Accumulator: filePath → edit entries
 */
function collectEditsFromMessage(msg, msgIdx, editMap) {
	const lines = msg.split("\n");
	let editStart = -1;

	for (let l = 0; l < lines.length; l++) {
		if (!EDIT_HEADER_RE.test(lines[l])) continue;

		// Close previous edit block if one was open
		if (editStart >= 0) {
			const editText = lines.slice(editStart, l).join("\n");
			const parsed = parseEditBlock(editText);
			if (parsed) recordEdit(editMap, parsed, msgIdx, editStart, l);
		}
		editStart = l;
	}

	// Close the last edit in this message
	if (editStart < 0) return;
	const editText = lines.slice(editStart).join("\n");
	const parsed = parseEditBlock(editText);
	if (parsed) recordEdit(editMap, parsed, msgIdx, editStart, lines.length);
}

/**
 * Build chains of overlapping edits for a single file path.
 * Two edits overlap when the later edit's old_string is contained in the
 * previous edit's new_string (same region being modified repeatedly).
 *
 * @param {object[]} edits - Array of edit entries for one file
 * @returns {object[][]} Array of chains (each chain is an array of edit entries)
 */
function buildCoalesceChains(edits) {
	const chains = [[edits[0]]];
	for (let i = 1; i < edits.length; i++) {
		const currentChain = chains.at(-1);
		const lastInChain = currentChain.at(-1);
		const prevNew = lastInChain.parsed.newStr;
		const currOld = edits[i].parsed.oldStr;
		if (prevNew && currOld && prevNew.includes(currOld)) {
			currentChain.push(edits[i]);
		} else {
			chains.push([edits[i]]);
		}
	}
	return chains;
}

/**
 * Build the replacement text for a coalesced edit chain.
 * @param {object[]} edits - Chain of edit entries to coalesce
 * @returns {string} The coalesced edit block text
 */
function buildCoalescedEditText(edits) {
	const first = edits[0];
	const last = edits.at(-1);
	const filePath = first.parsed.filePath;
	const count = edits.length;
	const header = `→ Edit \`${filePath}\` [${count} edits coalesced]:`;
	const parts = [header];

	if (first.parsed.oldStr) {
		parts.push(
			"      old: |",
			first.parsed.oldStr
				.split("\n")
				.map((l) => `        ${l}`)
				.join("\n"),
		);
	}
	if (last.parsed.newStr) {
		parts.push(
			"      new: |",
			last.parsed.newStr
				.split("\n")
				.map((l) => `        ${l}`)
				.join("\n"),
		);
	} else if (first.parsed.newStr && edits.length === 2) {
		// If last has no newStr (deletion), still show it
		parts.push("      new: | [deleted]");
	}

	return parts.join("\n");
}

/**
 * Rebuild a single assistant message applying edit coalescing.
 * @param {string} msg - Original message
 * @param {number} msgIdx - Message index
 * @param {Set} removeEdits - Set of "msgIdx:editStart" keys to remove
 * @param {Map} replaceEdits - Map of "msgIdx:editStart" → replacement text
 * @returns {string} Rebuilt message
 */
function rebuildMessageWithCoalescing(msg, msgIdx, removeEdits, replaceEdits) {
	const lines = msg.split("\n");
	const result = [];
	let editStart = -1;

	for (let l = 0; l <= lines.length; l++) {
		const isEditHeader = l < lines.length && EDIT_HEADER_RE.test(lines[l]);
		const isEnd = l === lines.length;

		if ((isEditHeader || isEnd) && editStart >= 0) {
			const key = `${msgIdx}:${editStart}`;
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
	const editMap = new Map();

	for (let i = 0; i < messages.length; i++) {
		if (!messages[i].startsWith("**Assistant:**")) continue;
		collectEditsFromMessage(messages[i], i, editMap);
	}

	// Find coalescing chains: only merge edits where a later edit's old_string
	// contains content from the previous edit's new_string (same region).
	const toCoalesce = new Map();
	for (const [filePath, edits] of editMap) {
		if (edits.length < 2) continue;
		const chains = buildCoalesceChains(edits);
		for (const chain of chains) {
			if (chain.length >= 2) {
				toCoalesce.set(`${filePath}:${chain[0].editStart}`, chain);
			}
		}
	}

	if (toCoalesce.size === 0) return messages;

	// Build set of edits to remove (intermediate ones) and the last edit to replace
	const removeEdits = new Set();
	const replaceEdits = new Map();

	for (const [, edits] of toCoalesce) {
		// Remove all intermediate edits and the first (replaced by coalesced at last position)
		for (let i = 0; i < edits.length - 1; i++) {
			removeEdits.add(`${edits[i].msgIdx}:${edits[i].editStart}`);
		}

		const last = edits.at(-1);
		replaceEdits.set(
			`${last.msgIdx}:${last.editStart}`,
			buildCoalescedEditText(edits),
		);
	}

	// Rebuild messages with coalesced edits
	return messages.map((msg, i) => {
		if (!msg.startsWith("**Assistant:**")) return msg;
		return rebuildMessageWithCoalescing(msg, i, removeEdits, replaceEdits);
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

	// Prior checkpoint content is already compacted — preserve it verbatim.
	// Only capCheckpointContent() in checkpoint.mjs applies a safety cap.

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
 * Compute files modified and tool op count from a windowed message set.
 * @param {string[]} recent - Windowed messages
 * @returns {{ windowFiles: Set<string>, windowToolOps: number }}
 */
function computeWindowStats(recent) {
	const windowFiles = new Set();
	let windowToolOps = 0;
	for (const msg of recent) {
		for (const match of msg.matchAll(EDIT_WRITE_RE)) {
			windowFiles.add(match[1]);
		}
		for (const line of msg.split("\n")) {
			if (TOOL_OP_RE.test(line)) windowToolOps++;
		}
	}
	return { windowFiles, windowToolOps };
}

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
	const { windowFiles, windowToolOps } = computeWindowStats(recent);

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

/**
 * Content processing helpers for transcript extraction.
 *
 * Handles the per-message processing logic: interleaved content block
 * handling for assistant messages, user message classification,
 * skip-rule evaluation, and state header generation.
 *
 * @module extract-helpers
 */

import {
	contentBlockPlaceholder,
	summarizeToolResult,
	summarizeToolUse,
} from "./tool-summary.mjs";
import { isAffirmativeConfirmation, isSystemInjection } from "./trim.mjs";

/** Matches any compact/restore marker that signals a compaction boundary. */
const COMPACT_MARKER_RE = /^\[(SMART COMPACT|KEEP RECENT|RESTORED CONTEXT)/;

// ---------------------------------------------------------------------------
// Assistant message processing
// ---------------------------------------------------------------------------

/**
 * Process an assistant message's content array in order, generating
 * interleaved text and tool summaries. Also populates the tool_use ID map.
 *
 * @param {Array} contentArray - The message.content array
 * @param {Map} toolUseMap - Map<tool_use_id, {name, input}> to populate
 * @returns {string} Formatted assistant message content
 */
export function processAssistantContent(contentArray, toolUseMap) {
	if (!Array.isArray(contentArray)) {
		return typeof contentArray === "string" ? contentArray.trim() : "";
	}

	const parts = [];

	for (const block of contentArray) {
		// Text blocks — keep in full
		if (block.type === "text" && block.text) {
			parts.push(block.text.trim());
			continue;
		}

		// Tool use blocks — generate summary and record in map
		if (block.type === "tool_use") {
			if (block.id) {
				toolUseMap.set(block.id, { name: block.name, input: block.input });
			}
			const summary = summarizeToolUse(block);
			if (summary) parts.push(summary);
			continue;
		}

		// Thinking / redacted_thinking — remove (internal reasoning)
		if (block.type === "thinking" || block.type === "redacted_thinking") {
			continue;
		}

		// Images, documents, unknown types — emit placeholder
		const placeholder = contentBlockPlaceholder(block);
		if (placeholder) parts.push(placeholder);
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// User message processing
// ---------------------------------------------------------------------------

/**
 * Process a user message's content array, handling both human text
 * and tool_result blocks (from tool call responses).
 *
 * @param {Array|string} content - The message.content (string or array)
 * @param {Map} toolUseMap - Map<tool_use_id, {name, input}> for result lookup
 * @returns {{ userText: string, toolResults: string[] }}
 */
export function processUserContent(content, toolUseMap) {
	// Simple string content — just human text
	if (typeof content === "string") {
		return { userText: content.trim(), toolResults: [] };
	}
	if (!Array.isArray(content)) {
		return { userText: "", toolResults: [] };
	}

	const textParts = [];
	const toolResults = [];

	for (const block of content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text.trim());
			continue;
		}

		if (block.type === "tool_result") {
			const toolInfo = block.tool_use_id
				? toolUseMap.get(block.tool_use_id) || null
				: null;
			const summary = summarizeToolResult(block, toolInfo);
			if (summary) toolResults.push(summary);
			continue;
		}

		// Images, documents — placeholder
		const placeholder = contentBlockPlaceholder(block);
		if (placeholder) textParts.push(placeholder);
	}

	return {
		userText: textParts.join("\n").trim(),
		toolResults,
	};
}

// ---------------------------------------------------------------------------
// Skip rules
// ---------------------------------------------------------------------------

/**
 * Determine whether a user text message should be skipped.
 *
 * @param {string} text - The extracted user text
 * @param {boolean} lastAssistantIsCGMenu - Whether the previous message was a CG menu
 * @returns {{ skip: boolean, clearMenu: boolean }}
 */
export function shouldSkipUserMessage(text, lastAssistantIsCGMenu) {
	if (!text) return { skip: true, clearMenu: false };

	// Slash commands — meta-operations, not conversation
	if (text.startsWith("/")) return { skip: true, clearMenu: false };

	// CG menu replies
	if (
		lastAssistantIsCGMenu &&
		(/^[0-4]$/.test(text) || text.toLowerCase() === "cancel")
	) {
		return { skip: true, clearMenu: true };
	}

	// Compact markers from previous compactions
	if (COMPACT_MARKER_RE.test(text) || text.startsWith("# Context Checkpoint")) {
		return { skip: true, clearMenu: false };
	}

	// Known system injections (checkpoint restores, skill injections)
	if (isSystemInjection(text)) return { skip: true, clearMenu: false };

	// Short affirmative confirmations ("yes", "ok", "sure", etc.)
	if (isAffirmativeConfirmation(text)) return { skip: true, clearMenu: false };

	return { skip: false, clearMenu: false };
}

// ---------------------------------------------------------------------------
// State header generation
// ---------------------------------------------------------------------------

/**
 * Generate a brief orientation header for the checkpoint.
 * Gives the LLM an immediate anchor before the chronological detail.
 * Costs ~50-100 tokens but exploits attention patterns (strongest at start).
 *
 * @param {string[]} messages - The formatted message strings
 * @param {Set<string>} filesModified - Set of files with Edit/Write operations
 * @param {number} toolOpCount - Total number of tool operations
 * @returns {string} The header block
 */
export function generateStateHeader(messages, filesModified, toolOpCount) {
	let lastUser = "";
	let lastAssistant = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		if (!lastUser && messages[i].startsWith("**User:**")) {
			lastUser = messages[i].replace("**User:** ", "").slice(0, 200);
		}
		if (!lastAssistant && messages[i].startsWith("**Assistant:**")) {
			lastAssistant = messages[i].replace("**Assistant:** ", "").slice(0, 200);
		}
		if (lastUser && lastAssistant) break;
	}

	const fileList =
		filesModified.size > 0
			? Array.from(filesModified).sort().join(", ")
			: "none";

	return [
		"## Session State",
		`Goal: ${lastUser || "[not available]"}`,
		`Files modified: ${fileList}`,
		`Last action: ${lastAssistant || "[not available]"}`,
		`Messages preserved: ${messages.length} | Tool operations: ${toolOpCount}`,
	].join("\n");
}

/**
 * Detect whether an assistant message is a Context Guardian menu prompt.
 * Used to identify and skip the user's numeric reply to the menu.
 *
 * @param {Array|string} content - The assistant message content
 * @returns {boolean}
 */
export function isCGMenuMessage(content) {
	const textOnly = Array.isArray(content)
		? content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n")
		: typeof content === "string"
			? content
			: "";
	return (
		/Context Guardian\s.{0,5}\d/.test(textOnly) &&
		textOnly.includes("Reply with 1,")
	);
}

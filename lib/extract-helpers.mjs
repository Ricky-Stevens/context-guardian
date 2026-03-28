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
	// Goal = first real user message (the session's purpose)
	// Last action = last real assistant message (current state)
	let firstUser = "";
	let lastAssistant = "";
	for (let i = 0; i < messages.length; i++) {
		if (!firstUser && messages[i].startsWith("**User:**")) {
			const text = messages[i].replace("**User:** ", "");
			if (!isHeaderNoise(text)) {
				firstUser = text.replace(/\n/g, " ").slice(0, 200);
			}
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		if (!lastAssistant && messages[i].startsWith("**Assistant:**")) {
			const text = messages[i].replace("**Assistant:** ", "");
			if (!isHeaderNoise(text) && text.length > 30) {
				lastAssistant = text.replace(/\n/g, " ").slice(0, 200);
				break;
			}
		}
	}

	const fileList =
		filesModified.size > 0
			? Array.from(filesModified).sort().join(", ")
			: "none";

	const topics = extractTopics(messages);
	const topicLine =
		topics.length > 0
			? topics
					.map((t) => t.replace(/[\r\n]+/g, " ").trim())
					.filter((t) => t.length > 1 && t.length < 60)
					.join(", ")
			: "general discussion";

	return [
		"## Session State",
		`Goal: ${firstUser || "[not available]"}`,
		`Files modified: ${fileList}`,
		`Topics covered: ${topicLine}`,
		`Last action: ${lastAssistant || "[not available]"}`,
		`Messages preserved: ${messages.length} | Tool operations: ${toolOpCount}`,
	].join("\n");
}

/**
 * Check if a message is infrastructure noise that shouldn't appear in
 * the Goal or Last action header fields.
 */
function isHeaderNoise(text) {
	if (!text) return true;
	if (isSystemInjection(text)) return true;
	if (text.includes("```")) return true;
	if (text.includes("<command-message>")) return true;
	if (text.includes("<command-name>")) return true;
	if (/^→ /.test(text)) return true; // tool summary line
	return false;
}

/**
 * Extract key topics from user messages for the state header index.
 * Looks for identifiers, proper nouns, ticket/bug IDs, and named entities
 * that help the LLM locate specific content in a dense checkpoint.
 *
 * @param {string[]} messages - The formatted message strings
 * @returns {string[]} Deduplicated topic strings
 */
function extractTopics(messages) {
	const topics = new Set();

	for (const msg of messages) {
		if (!msg.startsWith("**User:**")) continue;
		const text = msg.replace("**User:** ", "").replace(/\r/g, "");

		// Ticket/bug/incident IDs (e.g. ZEP-4471, INC-2891, SEC-0042)
		for (const m of text.matchAll(/\b[A-Z]{2,6}-\d{2,6}\b/g)) {
			topics.add(m[0]);
		}

		// Quoted project/service names (e.g. "Zephyr-9", "OrderMesh")
		for (const m of text.matchAll(/"([A-Z][A-Za-z0-9_-]+)"/g)) {
			topics.add(m[1]);
		}

		// Decision keywords
		if (/\b(?:decided|chose|rejected|decision|approved)\b/i.test(text)) {
			// Extract the subject near the decision verb
			const match = text.match(
				/(?:decided|chose|rejected|approved)\s+(?:to\s+)?(?:go\s+with\s+)?(?:Option\s+)?([A-Z][A-Za-z0-9_ -]{2,30})/i,
			);
			if (match) topics.add(match[1].trim());
		}

		// Named entities — capitalized multi-word sequences (likely proper nouns)
		for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
			const name = m[1];
			// Skip common false positives (sentence starters, time phrases, generic words)
			if (
				!/^(?:The|This|That|When|After|Before|During|Which|Where|What|How|NOT|WILL|REJECTED|Confirmed|Discovered|On|In|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(
					name,
				)
			) {
				topics.add(name);
			}
		}
	}

	// Remove non-informative entries
	const TOPIC_NOISE = new Set([
		"Confirmed",
		"Read",
		"Run",
		"Context Guardian",
		"Context Guardian Stats",
		"Smart Compact",
		"Keep Recent",
	]);
	// Also remove any entry containing "Context Guardian" or "Smart Compact"
	// (catches multi-word variants from regex over-matching)
	const NOISE_SUBSTRINGS = ["Context Guardian", "Smart Compact", "Keep Recent"];
	for (const t of topics) {
		if (TOPIC_NOISE.has(t)) topics.delete(t);
		// Remove code identifiers (ALL_CAPS_WITH_UNDERSCORES)
		else if (/^[A-Z_]{4,}$/.test(t)) topics.delete(t);
		// Remove entries containing known noise substrings
		else if (NOISE_SUBSTRINGS.some((n) => t.includes(n))) topics.delete(t);
	}

	return Array.from(topics).slice(0, 15);
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

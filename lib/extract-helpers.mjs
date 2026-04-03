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

/** Matches the synthetic assistant ack injected by CG's writeSyntheticSession. */
const SYNTHETIC_ACK_RE =
	/^Context restored from checkpoint\.\s+I have the full session history/;

export function isSyntheticAck(text) {
	return SYNTHETIC_ACK_RE.test((text ?? "").trim());
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
	// Skip trivial greetings for Goal — find the first SUBSTANTIVE user message
	const GREETING_RE =
		/^(?:hi|hello|hey|good (?:morning|afternoon|evening)|what'?s up|sup)\b/i;
	const META_MSG_RE =
		/^(?:IMPORTANT:|Rules:|NOTE:|WARNING:|Context Guardian|We are about to run)/i;
	for (let i = 0; i < messages.length; i++) {
		if (!firstUser && messages[i].startsWith("**User:**")) {
			const text = messages[i].replace("**User:** ", "");
			if (
				!isHeaderNoise(text) &&
				!GREETING_RE.test(text.trim()) &&
				!META_MSG_RE.test(text.trim()) &&
				text.trim().length > 20
			) {
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

// ---------------------------------------------------------------------------
// Conversation index — structured preamble for LLM consumption
// ---------------------------------------------------------------------------
// Exploits the U-shaped attention curve: the model attends most to the START
// and END of context. This index goes at the START, giving the model a complete
// map of what's in the checkpoint. The body (middle) is navigable via numbers.
// ---------------------------------------------------------------------------

/** Lines that are tool requests — not fact-bearing user content. */
const TOOL_REQUEST_RE =
	/^(?:Read |Run[: ]|Grep |Search |Find |List |Tell me |Explain |Show me |Describe |How (?:many|does|do |is )|What (?:is|does|are )|What'?s the |Can you |Then |After all |Create a file |In [/~].*(?:change |replace )|Also change |Actually change |Also — in [/~])/i;

/** Lines that are instructions/meta, not facts. */
const INSTRUCTION_RE =
	/^(?:Confirm|Now |Do |Let'?s |Please |Go ahead|Then |After all|After that|Give me|Also —|IMPORTANT:|Rules:|\d+\.\s+(?:The |When |Do not |Keep ))/i;

/** Lines that are code, not prose facts. */
const CODE_LINE_RE =
	/^\s*(?:function |const |let |var |return |if \(|for \(|while \(|class |import |export |}\s*$|{\s*$|[{}();]+\s*$)/;

/** Decision-bearing language in user messages. */
const DECISION_RE =
	/\b(?:chose|choose|picked|go with|use the|reject(?:ed)?|decided|decision|approved|option [a-z]|NOT migrating|WILL adopt|REJECTED|voted)\b/i;

/**
 * Extract fact-bearing content from a user message, filtering out tool requests,
 * instructions, and code lines. Returns empty string if nothing substantive.
 */
function extractUserFacts(userText) {
	const lines = userText.split("\n");
	const factLines = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.length < 15) continue;
		if (TOOL_REQUEST_RE.test(trimmed)) continue;
		if (INSTRUCTION_RE.test(trimmed)) continue;
		if (/^[`/]/.test(trimmed) && trimmed.length < 80) continue;
		if (/^```/.test(trimmed)) continue;
		if (/^\[User shared /.test(trimmed)) continue;
		if (CODE_LINE_RE.test(trimmed)) continue;
		if (/};\s*$/.test(trimmed) && trimmed.length < 30) continue;
		factLines.push(trimmed);
	}
	const combined = factLines.join(" ").replace(/\s+/g, " ").trim();
	return combined.length >= 20 ? combined : "";
}

/**
 * Extract a compact work summary from an exchange's messages.
 * Scans tool invocations (→) and results (←) for edits, writes, bash runs.
 * Returns e.g. "Edited auth.js; ran npm test → 14 passed"
 */
function extractWorkSummary(exchangeMsgs) {
	const edits = [];
	const writes = [];
	const bashRuns = [];
	const errors = [];
	for (const msg of exchangeMsgs) {
		for (const line of msg.split("\n")) {
			const t = line.trim();
			const editMatch = t.match(/^→ Edit `([^`]+)`/);
			if (editMatch) {
				const fp = editMatch[1].split("/").pop();
				if (!edits.includes(fp)) edits.push(fp);
				continue;
			}
			const writeMatch = t.match(/^→ Write `([^`]+)`/);
			if (writeMatch) {
				const fp = writeMatch[1].split("/").pop();
				if (!writes.includes(fp)) writes.push(fp);
				continue;
			}
			const bashMatch = t.match(/^→ Ran `([^`]+)`/);
			if (bashMatch) {
				bashRuns.push(bashMatch[1].slice(0, 40));
				continue;
			}
			if (
				t.startsWith("←") &&
				/\b(?:error|fail|FAIL|denied|not found)\b/i.test(t)
			) {
				errors.push(t.slice(2, 80).trim());
				continue;
			}
			if (
				t.startsWith("←") &&
				bashRuns.length > 0 &&
				t.length > 3 &&
				t.length < 200
			) {
				const result = t.slice(2, 60).trim();
				if (result && !result.startsWith("[")) {
					bashRuns[bashRuns.length - 1] += ` → ${result}`;
				}
			}
		}
	}
	const parts = [];
	if (writes.length > 0) parts.push(`Created ${writes.join(", ")}`);
	if (edits.length > 0) parts.push(`Edited ${edits.join(", ")}`);
	for (const run of bashRuns) parts.push(`Ran ${run}`);
	if (errors.length > 0) parts.push(`ERROR: ${errors[0]}`);
	return parts.join("; ");
}

/**
 * Extract key entities from text that might be lost to truncation.
 * Pulls out: IDs, money, dates, ports, thresholds, config values, person names.
 * Returns array of compact entity strings.
 */
function extractKeyEntities(text) {
	const entities = new Set();

	// Bug/incident/ticket IDs: ZEP-4471, INC-2891, SEC-0042, PR #1847
	for (const m of text.matchAll(/\b[A-Z]{2,6}-\d{2,6}\b/g)) entities.add(m[0]);
	for (const m of text.matchAll(/PR #\d+/g)) entities.add(m[0]);

	// Money amounts: $184,000
	for (const m of text.matchAll(/\$[\d,]+(?:\.\d+)?/g)) entities.add(m[0]);

	// Dates: January 14th, March 28th, April 12th, etc.
	for (const m of text.matchAll(
		/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?/gi,
	)) {
		entities.add(m[0]);
	}

	// Ports: port 5433, port 9147
	for (const m of text.matchAll(/port\s+\d+/gi)) entities.add(m[0]);

	// Config values: key=value patterns
	for (const m of text.matchAll(/\b\w+=\d[\d,]*/g)) entities.add(m[0]);

	// Thresholds with comparisons: p99 > 340ms, > 2,847
	for (const m of text.matchAll(/p\d+\s*[><]=?\s*\d[\d,.]*\s*\w*/g))
		entities.add(m[0]);

	// Rates/thresholds: 8 errors/30s, 5 errors/10s
	for (const m of text.matchAll(/\d+\s+errors?\/\d+s/gi)) entities.add(m[0]);

	// Counts with units: 2,341 transactions, 12,000 req/s, 47 seconds
	for (const m of text.matchAll(
		/[\d,]+\s+(?:transactions?|failed transactions?|items?|req\/s|errors?|seconds?|minutes?|hours?|pods?|shards?|batches|vCPU)/gi,
	)) {
		entities.add(m[0]);
	}

	// Docker images / S3 paths
	for (const m of text.matchAll(/(?:s3:\/\/|docker image\s+)[\w./:@-]+/gi))
		entities.add(m[0]);
	for (const m of text.matchAll(/[\w-]+\/[\w-]+:v[\d.]+-[\w]+/g))
		entities.add(m[0]);

	// Person names (Capitalized FirstName LastName)
	for (const m of text.matchAll(
		/\b([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
	)) {
		const name = m[1];
		if (
			!/^(?:The|This|After|Before|Decision|Option|Root|Bug|Incident|Security|Capacity|Migration)\b/.test(
				name,
			)
		) {
			entities.add(name);
		}
	}

	// Deduplicate: remove entries that are substrings of longer entries
	const entityArr = Array.from(entities);
	const deduped = entityArr.filter(
		(e) =>
			!entityArr.some(
				(other) => other !== e && other.length > e.length && other.includes(e),
			),
	);

	return deduped.slice(0, 10); // cap to avoid bloat
}

/** Extract decisions from user messages. */
function extractDecisions(messages) {
	const decisions = [];
	let exchangeNum = 0;
	for (const msg of messages) {
		if (!msg.startsWith("**User:**")) continue;
		exchangeNum++;
		const text = msg.slice("**User:** ".length).replace(/\n/g, " ");
		if (/^\s*no\s*$/i.test(text.trim())) {
			decisions.push({ text: "Rejected preceding option", num: exchangeNum });
			continue;
		}
		if (DECISION_RE.test(text)) {
			// Extract concise decision — the verb + its direct object, max 60 chars
			const match = text.match(
				/\b((?:NOT |WILL )?(?:chose|rejected?|decided|approved|voted|migrating|adopt)\b[^.;,]{0,50})/i,
			);
			if (match) {
				const clause = match[1].trim().replace(/\s+/g, " ").slice(0, 60);
				decisions.push({ text: clause, num: exchangeNum });
			}
		}
	}
	return decisions;
}

/** Extract error→resolution pairs from the message stream. */
function extractErrorResolutions(messages) {
	const pairs = [];
	let lastError = null;
	let lastErrorExchange = 0;
	let exchangeNum = 0;
	for (const msg of messages) {
		if (msg.startsWith("**User:**")) exchangeNum++;
		if (
			msg.startsWith("←") &&
			/\b(?:error|fail|FAIL|exception|not found|denied)\b/i.test(msg)
		) {
			lastError = msg.slice(2, 100).trim();
			lastErrorExchange = exchangeNum;
			continue;
		}
		if (
			lastError &&
			msg.startsWith("←") &&
			!/\b(?:error|fail|FAIL)\b/i.test(msg)
		) {
			const successText = msg.slice(2, 60).trim();
			if (successText && exchangeNum - lastErrorExchange <= 3) {
				pairs.push({
					error: lastError.slice(0, 80),
					resolution: successText.slice(0, 60),
					from: lastErrorExchange,
					to: exchangeNum,
				});
				lastError = null;
			}
		}
	}
	return pairs;
}

/**
 * Generate a unified conversation index for the checkpoint preamble.
 *
 * Compact, scannable reference at the START of context (high-attention zone).
 * Each entry: exchange number + condensed user facts + work performed.
 * Followed by decision and error→resolution summaries.
 * Target: <3K chars for 30 exchanges (~750 tokens).
 *
 * @param {string[]} messages - Extracted message strings from extractMessages
 * @returns {string} Formatted markdown section, or "" if too few messages
 */
export function generateConversationIndex(messages) {
	if (messages.length < 10) return "";

	const exchanges = [];
	let current = null;
	let exchangeNum = 0;
	for (const msg of messages) {
		if (msg.startsWith("**User:**")) {
			exchangeNum++;
			if (current) exchanges.push(current);
			current = {
				num: exchangeNum,
				userFacts: extractUserFacts(msg.slice("**User:** ".length)),
				msgs: [msg],
			};
		} else if (current) {
			current.msgs.push(msg);
		}
	}
	if (current) exchanges.push(current);

	const entries = [];
	for (const ex of exchanges) {
		const facts = ex.userFacts;
		const work = extractWorkSummary(ex.msgs);
		if (!facts && !work) continue;

		if (facts) {
			// Fact-bearing exchange: show condensed facts
			if (facts.length <= 300) {
				entries.push(`[${ex.num}] ${facts}`);
			} else {
				// Truncate prose but append extracted key entities so nothing critical is lost
				const tags = extractKeyEntities(facts);
				const capped = `${facts.slice(0, 250)}...`;
				const tagLine = tags.length > 0 ? ` {${tags.join(", ")}}` : "";
				entries.push(`[${ex.num}] ${capped}${tagLine}`);
			}
		} else if (work) {
			// Pure tool-work exchange: show work summary
			entries.push(`[${ex.num}] ${work}`);
		}
	}
	if (entries.length === 0) return "";

	const decisions = extractDecisions(messages);
	const errorPairs = extractErrorResolutions(messages);

	const lines = [
		"## Conversation Index",
		"",
		"Compact reference — exchange numbers map to the full conversation below.",
		"",
		...entries,
	];
	if (decisions.length > 0) {
		lines.push(
			"",
			`**Decisions:** ${decisions.map((d) => `${d.text} [${d.num}]`).join(" | ")}`,
		);
	}
	if (errorPairs.length > 0) {
		lines.push(
			"",
			`**Errors resolved:** ${errorPairs.map((e) => `${e.error} → ${e.resolution} [${e.from}→${e.to}]`).join(" | ")}`,
		);
	}
	return lines.join("\n");
}

/**
 * Insert section headers into the message body for navigation.
 * Adds "### Exchanges N-M" headers every `groupSize` user exchanges.
 */
export function addSectionHeaders(messages, groupSize = 10) {
	if (messages.length < 20) return messages;
	const totalExchanges = countUserExchanges(messages);
	const result = [];
	let exchangeNum = 0;
	let lastHeaderAt = 0;
	for (const msg of messages) {
		if (msg.startsWith("**User:**")) {
			exchangeNum++;
			if (exchangeNum === 1 || exchangeNum - lastHeaderAt >= groupSize) {
				const end = Math.min(exchangeNum + groupSize - 1, totalExchanges);
				result.push(`### Exchanges ${exchangeNum}-${end}`);
				lastHeaderAt = exchangeNum;
			}
		}
		result.push(msg);
	}
	return result;
}

function countUserExchanges(messages) {
	let count = 0;
	for (const msg of messages) {
		if (msg.startsWith("**User:**")) count++;
	}
	return count;
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

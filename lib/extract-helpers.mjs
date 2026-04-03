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
 * Process a single content block from an assistant message.
 * Returns the string to append, or "" if the block should be skipped.
 */
function processAssistantBlock(block, toolUseMap) {
	if (block.type === "text" && block.text) {
		return block.text.trim();
	}
	if (block.type === "tool_use") {
		if (block.id) {
			toolUseMap.set(block.id, { name: block.name, input: block.input });
		}
		return summarizeToolUse(block) || "";
	}
	if (block.type === "thinking" || block.type === "redacted_thinking") {
		return "";
	}
	return contentBlockPlaceholder(block) || "";
}

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
		const result = processAssistantBlock(block, toolUseMap);
		if (result) parts.push(result);
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// User message processing
// ---------------------------------------------------------------------------

/**
 * Process a single content block from a user message.
 * Returns { text, toolResult } — exactly one will be non-empty.
 */
function processUserBlock(block, toolUseMap) {
	if (block.type === "text" && block.text) {
		return { text: block.text.trim(), toolResult: "" };
	}
	if (block.type === "tool_result") {
		const toolInfo = block.tool_use_id
			? toolUseMap.get(block.tool_use_id) || null
			: null;
		return { text: "", toolResult: summarizeToolResult(block, toolInfo) || "" };
	}
	return { text: contentBlockPlaceholder(block) || "", toolResult: "" };
}

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
		const { text, toolResult } = processUserBlock(block, toolUseMap);
		if (text) textParts.push(text);
		if (toolResult) toolResults.push(toolResult);
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
 * Find the first substantive user message for the Goal field.
 */
function findFirstUserGoal(messages) {
	const GREETING_RE =
		/^(?:hi|hello|hey|good (?:morning|afternoon|evening)|what'?s up|sup)\b/i;
	const META_MSG_RE =
		/^(?:IMPORTANT:|Rules:|NOTE:|WARNING:|Context Guardian|We are about to run)/i;
	for (const msg of messages) {
		if (!msg.startsWith("**User:**")) continue;
		const text = msg.replace("**User:** ", "");
		if (isHeaderNoise(text)) continue;
		if (GREETING_RE.test(text.trim())) continue;
		if (META_MSG_RE.test(text.trim())) continue;
		if (text.trim().length <= 20) continue;
		return text.replaceAll("\n", " ").slice(0, 200);
	}
	return "";
}

/**
 * Find the last substantive assistant message for the Last Action field.
 */
function findLastAssistantAction(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (!messages[i].startsWith("**Assistant:**")) continue;
		const text = messages[i].replace("**Assistant:** ", "");
		if (isHeaderNoise(text)) continue;
		if (text.length <= 30) continue;
		return text.replaceAll("\n", " ").slice(0, 200);
	}
	return "";
}

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
	const firstUser = findFirstUserGoal(messages);
	const lastAssistant = findLastAssistantAction(messages);

	const fileList =
		filesModified.size > 0
			? Array.from(filesModified)
					.sort((a, b) => a.localeCompare(b))
					.join(", ")
			: "none";

	const topics = extractTopics(messages);
	const topicLine =
		topics.length > 0
			? topics
					.map((t) => t.replaceAll(/[\r\n]+/g, " ").trim())
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
	if (text.startsWith("→ ")) return true; // tool summary line
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
		const text = msg.replace("**User:** ", "").replaceAll("\r", "");
		collectTopicsFromText(text, topics);
	}

	removeTopicNoise(topics);
	return Array.from(topics).slice(0, 15);
}

/**
 * Collect topic candidates from a single user message text.
 */
function collectTopicsFromText(text, topics) {
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
		const match =
			/(?:decided|chose|rejected|approved)\s+(?:to\s+)?(?:go\s+with\s+)?(?:Option\s+)?([A-Z][a-z0-9 _-]{2,30})/i.exec(
				text,
			);
		if (match) topics.add(match[1].trim());
	}

	// Named entities — capitalized multi-word sequences (likely proper nouns)
	for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
		const name = m[1];
		if (!isNamedEntityFalsePositive(name)) {
			topics.add(name);
		}
	}
}

/** Common false-positive prefixes for named entity extraction — group 1. */
const NAMED_ENTITY_FP_1 =
	/^(?:The|This|That|When|After|Before|During|Which|Where|What|How|NOT|WILL|REJECTED)\b/;

/** Common false-positive prefixes for named entity extraction — group 2. */
const NAMED_ENTITY_FP_2 =
	/^(?:Confirmed|Discovered|On|In|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday)\b/;

/** Common false-positive prefixes for named entity extraction — group 3. */
const NAMED_ENTITY_FP_3 =
	/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/;

/**
 * Check if a named entity candidate is a common false positive.
 */
function isNamedEntityFalsePositive(name) {
	return (
		NAMED_ENTITY_FP_1.test(name) ||
		NAMED_ENTITY_FP_2.test(name) ||
		NAMED_ENTITY_FP_3.test(name)
	);
}

/**
 * Remove non-informative entries from the topics set.
 */
function removeTopicNoise(topics) {
	const TOPIC_NOISE = new Set([
		"Confirmed",
		"Read",
		"Run",
		"Context Guardian",
		"Context Guardian Stats",
		"Smart Compact",
		"Keep Recent",
	]);
	const NOISE_SUBSTRINGS = ["Context Guardian", "Smart Compact", "Keep Recent"];
	for (const t of topics) {
		const isNoise =
			TOPIC_NOISE.has(t) ||
			/^[A-Z_]{4,}$/.test(t) || // code identifiers (ALL_CAPS_WITH_UNDERSCORES)
			NOISE_SUBSTRINGS.some((n) => t.includes(n)); // known noise substrings
		if (isNoise) topics.delete(t);
	}
}

// ---------------------------------------------------------------------------
// Conversation index — structured preamble for LLM consumption
// ---------------------------------------------------------------------------
// Exploits the U-shaped attention curve: the model attends most to the START
// and END of context. This index goes at the START, giving the model a complete
// map of what's in the checkpoint. The body (middle) is navigable via numbers.
// ---------------------------------------------------------------------------

/** Lines that are tool requests — not fact-bearing user content (group 1). */
const TOOL_REQUEST_RE_1 =
	/^(?:Read |Run[: ]|Grep |Search |Find |List |Tell me |Explain |Show me |Describe )/i;

/** Lines that are tool requests — not fact-bearing user content (group 2). */
const TOOL_REQUEST_RE_2 =
	/^(?:How (?:many|does|do |is )|What (?:is|does|are )|What'?s the |Can you )/i;

/** Lines that are tool requests — not fact-bearing user content (group 3). */
const TOOL_REQUEST_RE_3 =
	/^(?:Then |After all |Create a file |In [/~].*(?:change |replace )|Also change |Actually change |Also — in [/~])/i;

/** Lines that are instructions/meta, not facts (group 1). */
const INSTRUCTION_RE_1 =
	/^(?:Confirm|Now |Do |Let'?s |Please |Go ahead|Then |After all|After that)/i;

/** Lines that are instructions/meta, not facts (group 2). */
const INSTRUCTION_RE_2 =
	/^(?:Give me|Also —|IMPORTANT:|Rules:|\d+\.\s+(?:The |When |Do not |Keep ))/i;

/** Lines that are code, not prose facts (group 1). */
const CODE_LINE_RE_1 =
	/^\s*(?:function |const |let |var |return |if \(|for \(|while \()/;

/** Lines that are code, not prose facts (group 2). */
const CODE_LINE_RE_2 =
	/^\s*(?:class |import |export |}\s*$|{\s*$|[{}();]+\s*$)/;

/** Decision-bearing language in user messages. */
const DECISION_RE =
	/\b(?:chose|choose|picked|go with|use the|reject(?:ed)?|decided|decision|approved|option [a-z]|NOT migrating|WILL adopt|REJECTED|voted)\b/i;

/**
 * Check if a line matches any tool-request pattern.
 */
function isToolRequestLine(trimmed) {
	return (
		TOOL_REQUEST_RE_1.test(trimmed) ||
		TOOL_REQUEST_RE_2.test(trimmed) ||
		TOOL_REQUEST_RE_3.test(trimmed)
	);
}

/**
 * Check if a line matches any instruction pattern.
 */
function isInstructionLine(trimmed) {
	return INSTRUCTION_RE_1.test(trimmed) || INSTRUCTION_RE_2.test(trimmed);
}

/**
 * Check if a line matches any code pattern.
 */
function isCodeLine(trimmed) {
	return CODE_LINE_RE_1.test(trimmed) || CODE_LINE_RE_2.test(trimmed);
}

/**
 * Check if a line should be excluded from fact extraction.
 */
function isNonFactLine(trimmed) {
	if (!trimmed || trimmed.length < 15) return true;
	if (isToolRequestLine(trimmed)) return true;
	if (isInstructionLine(trimmed)) return true;
	if (trimmed.startsWith("`") || trimmed.startsWith("/")) {
		if (trimmed.length < 80) return true;
	}
	if (trimmed.startsWith("```")) return true;
	if (trimmed.startsWith("[User shared ")) return true;
	if (isCodeLine(trimmed)) return true;
	if (/};\s*$/.test(trimmed) && trimmed.length < 30) return true;
	return false;
}

/**
 * Extract fact-bearing content from a user message, filtering out tool requests,
 * instructions, and code lines. Returns empty string if nothing substantive.
 */
function extractUserFacts(userText) {
	const lines = userText.split("\n");
	const factLines = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (isNonFactLine(trimmed)) continue;
		factLines.push(trimmed);
	}
	const combined = factLines.join(" ").replaceAll(/\s+/g, " ").trim();
	return combined.length >= 20 ? combined : "";
}

/**
 * Classify a single line from an exchange for work summary extraction.
 * Returns { type, value } or null if the line is not relevant.
 */
function classifyWorkLine(trimmed) {
	const editMatch = trimmed.match(/^→ Edit `([^`]+)`/);
	if (editMatch) {
		return { type: "edit", value: editMatch[1].split("/").pop() };
	}
	const writeMatch = trimmed.match(/^→ Write `([^`]+)`/);
	if (writeMatch) {
		return { type: "write", value: writeMatch[1].split("/").pop() };
	}
	const bashMatch = trimmed.match(/^→ Ran `([^`]+)`/);
	if (bashMatch) {
		return { type: "bash", value: bashMatch[1].slice(0, 40) };
	}
	if (
		trimmed.startsWith("←") &&
		/\b(?:error|fail|FAIL|denied|not found)\b/i.test(trimmed)
	) {
		return { type: "error", value: trimmed.slice(2, 80).trim() };
	}
	if (trimmed.startsWith("←") && trimmed.length > 3 && trimmed.length < 200) {
		const result = trimmed.slice(2, 60).trim();
		if (result && !result.startsWith("[")) {
			return { type: "bash_result", value: result };
		}
	}
	return null;
}

/**
 * Extract a compact work summary from an exchange's messages.
 * Scans tool invocations (→) and results (←) for edits, writes, bash runs.
 * Returns e.g. "Edited auth.js; ran npm test → 14 passed"
 */
function accumulateWorkItem(classified, buckets) {
	const { edits, writes, bashRuns, errors } = buckets;
	switch (classified.type) {
		case "edit":
			if (!edits.includes(classified.value)) edits.push(classified.value);
			break;
		case "write":
			if (!writes.includes(classified.value)) writes.push(classified.value);
			break;
		case "bash":
			bashRuns.push(classified.value);
			break;
		case "error":
			errors.push(classified.value);
			break;
		case "bash_result":
			if (bashRuns.length > 0) {
				bashRuns[bashRuns.length - 1] += ` → ${classified.value}`;
			}
			break;
	}
}

function extractWorkSummary(exchangeMsgs) {
	const buckets = { edits: [], writes: [], bashRuns: [], errors: [] };
	for (const msg of exchangeMsgs) {
		for (const line of msg.split("\n")) {
			const classified = classifyWorkLine(line.trim());
			if (classified) accumulateWorkItem(classified, buckets);
		}
	}
	const { edits, writes, bashRuns, errors } = buckets;
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

	collectIdEntities(text, entities);
	collectNumericEntities(text, entities);
	collectPathEntities(text, entities);
	collectPersonNames(text, entities);

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

/**
 * Collect ID-type entities (tickets, PRs, money).
 */
function collectIdEntities(text, entities) {
	// Bug/incident/ticket IDs: ZEP-4471, INC-2891, SEC-0042, PR #1847
	for (const m of text.matchAll(/\b[A-Z]{2,6}-\d{2,6}\b/g)) entities.add(m[0]);
	for (const m of text.matchAll(/PR #\d+/g)) entities.add(m[0]);

	// Money amounts: $184,000
	for (const m of text.matchAll(/\$[\d,]+(?:\.\d+)?/g)) entities.add(m[0]);
}

/** Months pattern for date extraction (group 1). */
const MONTHS_1_RE = /(?:January|February|March|April|May|June)/i;

/** Months pattern for date extraction (group 2). */
const MONTHS_2_RE = /(?:July|August|September|October|November|December)/i;

/**
 * Build a date regex that matches "Month Day" patterns.
 */
function matchDates(text) {
	const DATE_SUFFIX = /\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?/;
	const DATE_RE = new RegExp(
		`(?:${MONTHS_1_RE.source}|${MONTHS_2_RE.source})${DATE_SUFFIX.source}`,
		"gi",
	);
	return text.matchAll(DATE_RE);
}

/** Counts with units — group 1 */
const COUNTS_RE_1 =
	/[\d,]+\s+(?:transactions?|failed transactions?|items?|req\/s|errors?)/gi;

/** Counts with units — group 2 */
const COUNTS_RE_2 =
	/[\d,]+\s+(?:seconds?|minutes?|hours?|pods?|shards?|batches|vCPU)/gi;

/**
 * Collect numeric entities (dates, ports, config values, thresholds, counts).
 */
function collectNumericEntities(text, entities) {
	// Dates
	for (const m of matchDates(text)) entities.add(m[0]);

	// Ports: port 5433, port 9147
	for (const m of text.matchAll(/port\s+\d+/gi)) entities.add(m[0]);

	// Config values: key=value patterns
	for (const m of text.matchAll(/\b\w+=\d[\d,]*/g)) entities.add(m[0]);

	// Thresholds with comparisons: p99 > 340ms, > 2,847
	for (const m of text.matchAll(/p\d+\s*[><]=?\s*\d[\d,.]*\s*\w*/g))
		entities.add(m[0]);

	// Rates/thresholds: 8 errors/30s, 5 errors/10s
	for (const m of text.matchAll(/\d+\s+errors?\/\d+s/gi)) entities.add(m[0]);

	// Counts with units
	for (const m of text.matchAll(COUNTS_RE_1)) entities.add(m[0]);
	for (const m of text.matchAll(COUNTS_RE_2)) entities.add(m[0]);
}

/**
 * Collect path/image entities (Docker images, S3 paths).
 */
function collectPathEntities(text, entities) {
	for (const m of text.matchAll(/(?:s3:\/\/|docker image\s+)[\w./:@-]+/gi))
		entities.add(m[0]);
	for (const m of text.matchAll(/[\w-]+\/[\w-]+:v[\d.]+-\w+/g))
		entities.add(m[0]);
}

/** False positive prefixes for person name detection. */
const PERSON_NAME_FP_RE =
	/^(?:The|This|After|Before|Decision|Option|Root|Bug|Incident|Security|Capacity|Migration)\b/;

/**
 * Collect person name entities.
 */
function collectPersonNames(text, entities) {
	for (const m of text.matchAll(
		/\b([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
	)) {
		const name = m[1];
		if (!PERSON_NAME_FP_RE.test(name)) {
			entities.add(name);
		}
	}
}

/** Extract decisions from user messages. */
function extractDecisions(messages) {
	const decisions = [];
	let exchangeNum = 0;
	for (const msg of messages) {
		if (!msg.startsWith("**User:**")) continue;
		exchangeNum++;
		const text = msg.slice("**User:** ".length).replaceAll("\n", " ");
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
				const clause = match[1].trim().replaceAll(/\s+/g, " ").slice(0, 60);
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
 * Build exchange groups from the flat message array.
 * Each exchange starts with a "**User:**" message and includes all
 * following messages until the next user message.
 */
function buildExchanges(messages) {
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
	return exchanges;
}

/**
 * Format a single exchange into an index entry string, or "" if not substantive.
 */
function formatExchangeEntry(ex) {
	const facts = ex.userFacts;
	const work = extractWorkSummary(ex.msgs);
	if (!facts && !work) return "";

	if (facts) {
		if (facts.length <= 300) {
			return `[${ex.num}] ${facts}`;
		}
		const tags = extractKeyEntities(facts);
		const capped = `${facts.slice(0, 250)}...`;
		const tagLine = tags.length > 0 ? ` {${tags.join(", ")}}` : "";
		return `[${ex.num}] ${capped}${tagLine}`;
	}
	// Pure tool-work exchange
	return `[${ex.num}] ${work}`;
}

/**
 * Build the decision and error summary lines for the index footer.
 */
function buildIndexFooter(messages) {
	const footerLines = [];
	const decisions = extractDecisions(messages);
	const errorPairs = extractErrorResolutions(messages);

	if (decisions.length > 0) {
		const decisionStr = decisions
			.map((d) => `${d.text} [${d.num}]`)
			.join(" | ");
		footerLines.push("", `**Decisions:** ${decisionStr}`);
	}
	if (errorPairs.length > 0) {
		const errorStr = errorPairs
			.map((e) => `${e.error} → ${e.resolution} [${e.from}→${e.to}]`)
			.join(" | ");
		footerLines.push("", `**Errors resolved:** ${errorStr}`);
	}
	return footerLines;
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

	const exchanges = buildExchanges(messages);

	const entries = [];
	for (const ex of exchanges) {
		const entry = formatExchangeEntry(ex);
		if (entry) entries.push(entry);
	}
	if (entries.length === 0) return "";

	const lines = [
		"## Conversation Index",
		"",
		"Compact reference — exchange numbers map to the full conversation below.",
		"",
		...entries,
		...buildIndexFooter(messages),
	];
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
	let textOnly;
	if (Array.isArray(content)) {
		textOnly = content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	} else if (typeof content === "string") {
		textOnly = content;
	} else {
		textOnly = "";
	}
	return (
		/Context Guardian\s.{0,5}\d/.test(textOnly) &&
		textOnly.includes("Reply with 1,")
	);
}

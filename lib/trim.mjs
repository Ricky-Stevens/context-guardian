/**
 * Universal text trimming and classification utilities.
 *
 * These functions implement Context Guardian's "keep-start-and-end" strategy:
 * when content exceeds a size limit, we keep the first N and last N characters,
 * trimming only the middle. This preserves intent (start) and outcome (end).
 *
 * @module trim
 */

// ---------------------------------------------------------------------------
// Start+end trim — the universal truncation strategy
// ---------------------------------------------------------------------------

/**
 * Trim content by keeping the first and last portions, removing the middle.
 * Returns content unchanged if it's within the limit.
 *
 * @param {string} content - The text to potentially trim
 * @param {number} limit - Maximum total character length before trimming
 * @param {number} [keepStart] - Characters to keep from the start (default: limit/2)
 * @param {number} [keepEnd] - Characters to keep from the end (default: limit/2)
 * @returns {string} The original or trimmed content
 */
export function startEndTrim(content, limit, keepStart, keepEnd) {
	if (!content || content.length <= limit) return content || "";
	const half = Math.floor(limit / 2);
	const start = keepStart ?? half;
	const end = keepEnd ?? half;
	const trimmed = content.length - start - end;
	return (
		content.slice(0, start) +
		`\n[...${trimmed} chars trimmed from middle...]\n` +
		content.slice(-end)
	);
}

// ---------------------------------------------------------------------------
// Error detection for tool results
// ---------------------------------------------------------------------------

/** Patterns that indicate a tool result is an error, not normal output. */
const ERROR_PATTERNS = [
	/\berror\b/i,
	/\bfailed\b/i,
	/\bdenied\b/i,
	/\bnot found\b/i,
	/\bexception\b/i,
	/\bdoes not exist\b/i,
	/\bpermission\b/i,
	/\bEACCES\b/,
	/\bENOENT\b/,
	/\btimeout\b/i,
	/exit code [1-9]/i,
	/non-zero exit/i,
];

/**
 * Check whether a tool result string looks like an error response.
 * Used to decide whether to preserve results that would otherwise be removed.
 *
 * @param {string} content - The tool result text
 * @returns {boolean} True if the content appears to be an error
 */
export function isErrorResponse(content) {
	if (!content || typeof content !== "string") return false;
	return ERROR_PATTERNS.some((re) => re.test(content));
}

/**
 * Check whether a tool result is a SHORT error response (< 500 chars).
 * Used specifically for re-obtainable tools (Read/Grep/Glob) where we only
 * want to keep actual tool failures, not successful results that happen
 * to contain error-related strings in their content.
 *
 * @param {string} content - The tool result text
 * @returns {boolean} True if it's a short error-like response
 */
export function isShortErrorResponse(content) {
	if (!content || typeof content !== "string") return false;
	return content.length < 500 && isErrorResponse(content);
}

// ---------------------------------------------------------------------------
// Confirmation message detection
// ---------------------------------------------------------------------------

/**
 * Affirmative zero-information words that can be safely skipped.
 * These are user messages that confirm a direction without adding context.
 * NOT included: "no", "n" (rejections = decisions), bare numbers (selections).
 */
const CONFIRMATIONS = new Set([
	"yes",
	"y",
	"ok",
	"okay",
	"sure",
	"go ahead",
	"continue",
	"proceed",
	"do it",
	"correct",
	"right",
	"exactly",
	"thanks",
	"thank you",
	"yep",
	"yea",
	"yeah",
	"sounds good",
	"go for it",
	"please",
	"agreed",
	"lgtm",
	"ship it",
]);

/**
 * Check whether a user message is a short affirmative confirmation
 * that adds no meaningful context to the conversation.
 *
 * @param {string} text - The trimmed user message text
 * @returns {boolean} True if the message is a skippable confirmation
 */
export function isAffirmativeConfirmation(text) {
	if (!text || typeof text !== "string") return false;
	const normalised = text
		.trim()
		.toLowerCase()
		.replace(/[.!,]+$/, "");
	return CONFIRMATIONS.has(normalised);
}

// ---------------------------------------------------------------------------
// Structured injection detection
// ---------------------------------------------------------------------------

/**
 * Check whether a user message is a known system injection (checkpoint restore,
 * skill injection, etc.) rather than actual user input.
 * Only matches specific known patterns — never drops content based on size alone.
 *
 * @param {string} text - The user message text
 * @returns {boolean} True if the message is a known system injection
 */
export function isSystemInjection(text) {
	if (!text) return false;
	if (text.startsWith("# Context Checkpoint")) return true;
	if (text.includes("<prior_conversation_history>")) return true;
	if (text.includes("SKILL.md") && text.includes("plugin")) return true;
	return false;
}

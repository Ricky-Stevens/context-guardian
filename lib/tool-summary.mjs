/**
 * Tool-aware content summarisation for Claude Code transcripts.
 *
 * Generates compact representations of tool_use invocations and tool_result
 * outputs, preserving decision-relevant content while removing re-obtainable
 * noise. This is the core of Context Guardian's "noise removal, not
 * summarisation" approach.
 *
 * Built-in tool rules live here; MCP-specific rules are in mcp-tools.mjs.
 *
 * @module tool-summary
 */

import {
	isSerenaReadTool,
	isSerenaWriteTool,
	summarizeMcpToolUse,
} from "./mcp-tools.mjs";
import {
	isErrorResponse,
	isShortErrorResponse,
	startEndTrim,
} from "./trim.mjs";

// ---------------------------------------------------------------------------
// Constants — size thresholds for different content types
// ---------------------------------------------------------------------------

/** Maximum chars for edit diffs before start+end trim. */
const EDIT_LIMIT = 3000;
/** Maximum chars for write content before start+end trim. */
const WRITE_LIMIT = 3000;
/** Maximum chars for Bash commands before start+end trim (heredocs). */
const BASH_CMD_LIMIT = 3000;
/** Maximum chars for Bash output before start+end trim. */
const BASH_OUTPUT_LIMIT = 5000;
/** Maximum chars for agent results before start+end trim. */
const AGENT_RESULT_LIMIT = 2000;
/** Maximum chars for unknown tool results — kept if under, trimmed if over. */
const UNKNOWN_RESULT_LIMIT = 1000;
/** Maximum chars for unknown MCP tool inputs before start+end trim. */
const UNKNOWN_INPUT_LIMIT = 1000;
/** Maximum chars for web search results before start+end trim. */
const WEB_SEARCH_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Edit diff formatting
// ---------------------------------------------------------------------------

/**
 * Format an Edit tool invocation as a compact old/new diff block.
 * Uses labeled old:/new: format (NOT unified diff) to avoid doubling
 * content size — each line appears only once.
 *
 * @param {string} filePath - The file being edited
 * @param {string} oldStr - The old_string being replaced
 * @param {string} newStr - The new_string replacement
 * @returns {string} Formatted diff string
 */
export function formatEditDiff(filePath, oldStr, newStr) {
	const parts = [`→ Edit \`${filePath}\`:`];

	if (oldStr && newStr) {
		const oldTrimmed = startEndTrim(oldStr, EDIT_LIMIT / 2);
		const newTrimmed = startEndTrim(newStr, EDIT_LIMIT / 2);
		parts.push(indent("old: |", 4));
		parts.push(indent(oldTrimmed, 6));
		parts.push(indent("new: |", 4));
		parts.push(indent(newTrimmed, 6));
	} else if (newStr && !oldStr) {
		const newTrimmed = startEndTrim(newStr, EDIT_LIMIT);
		parts.push(indent("new: |", 4));
		parts.push(indent(newTrimmed, 6));
	} else if (oldStr && !newStr) {
		const oldTrimmed = startEndTrim(oldStr, EDIT_LIMIT);
		parts.push(indent("old: | [deleted]", 4));
		parts.push(indent(oldTrimmed, 6));
	}

	return parts.join("\n");
}

/**
 * Indent every line of a text block by a given number of spaces.
 * @param {string} text - Text to indent
 * @param {number} spaces - Number of leading spaces
 * @returns {string} Indented text
 */
function indent(text, spaces) {
	const pad = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => pad + line)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Bash command classification
// ---------------------------------------------------------------------------

/**
 * Read-like Bash commands whose output is re-obtainable from disk.
 * Results from these are stripped (like Read/Grep), keeping only errors.
 * Action commands (tests, builds, curl, etc.) keep their full output.
 */
const READ_LIKE_BASH_RE =
	/^\s*(?:ls|cat|head|tail|find|wc|du|date|pwd|which|file|stat|echo|tree|realpath)\b/;
const READ_LIKE_GIT_RE =
	/^\s*git\s+(?:log|show|diff|status|branch|tag|remote|config)\b/;

function isReadLikeBash(command) {
	if (!command) return false;
	// For piped/chained commands, check the first command
	const first = command.split(/[|;&]/).shift().trim();
	return READ_LIKE_BASH_RE.test(first) || READ_LIKE_GIT_RE.test(first);
}

// ---------------------------------------------------------------------------
// Tool use summarisation (assistant message → tool_use blocks)
// ---------------------------------------------------------------------------

/**
 * Generate a compact summary string for a tool_use content block.
 * Returns the formatted summary line(s) to include in the checkpoint.
 *
 * @param {object} block - A content block with type: "tool_use"
 * @returns {string|null} Formatted tool summary, or null to omit
 */
export function summarizeToolUse(block) {
	const { name, input } = block;
	if (!name) return `→ Tool: [unknown]`;

	// ── Built-in Claude Code tools ────────────────────────────────────────

	if (name === "Edit") {
		return formatEditDiff(
			input?.file_path || input?.path || "unknown",
			input?.old_string || "",
			input?.new_string || "",
		);
	}

	if (name === "Write") {
		const fp = input?.file_path || input?.path || "unknown";
		const content = input?.content || "";
		if (content.length <= WRITE_LIMIT) {
			return `→ Write \`${fp}\`:\n${indent(content, 4)}`;
		}
		return `→ Write \`${fp}\` (${content.length} chars):\n${indent(startEndTrim(content, WRITE_LIMIT), 4)}`;
	}

	if (name === "Read") {
		const fp = input?.file_path || input?.path || "unknown";
		const rangeInfo = input?.offset ? ` (from line ${input.offset})` : "";
		return `→ Read \`${fp}\`${rangeInfo}`;
	}

	if (name === "Bash") {
		const cmd = input?.command || "";
		return `→ Ran \`${startEndTrim(cmd, BASH_CMD_LIMIT)}\``;
	}

	if (name === "Grep") {
		const pattern = input?.pattern || "";
		const searchPath = input?.path || "";
		return `→ Grep \`${pattern}\`${searchPath ? ` in \`${searchPath}\`` : ""}`;
	}

	if (name === "Glob") return `→ Glob \`${input?.pattern || ""}\``;

	if (name === "Agent")
		return `→ Agent: ${input?.description || "[no description]"}`;

	if (name === "AskUserQuestion") {
		const question = input?.question || input?.text || JSON.stringify(input);
		return `→ Asked user: ${startEndTrim(question, 500)}`;
	}

	if (name === "WebSearch") return `→ WebSearch: \`${input?.query || ""}\``;
	if (name === "WebFetch") return `→ WebFetch: \`${input?.url || ""}\``;

	if (name === "NotebookEdit") {
		const content = input?.new_source || input?.source || "";
		if (content.length <= WRITE_LIMIT) {
			return `→ NotebookEdit cell:\n${indent(content, 4)}`;
		}
		return `→ NotebookEdit cell (${content.length} chars):\n${indent(startEndTrim(content, WRITE_LIMIT), 4)}`;
	}

	// ── MCP tools — delegate to mcp-tools.mjs ─────────────────────────────
	if (name.startsWith("mcp__")) {
		return summarizeMcpToolUse(name, input, indent, summarizeUnknownTool);
	}

	// ── Unknown built-in tools — conservative: preserve key params ────────
	return summarizeUnknownTool(name, input);
}

// ---------------------------------------------------------------------------
// Unknown tool fallback
// ---------------------------------------------------------------------------

/**
 * Generate a conservative summary for an unrecognised tool.
 * Always preserves the tool name and key input parameters.
 */
function summarizeUnknownTool(name, input) {
	const inputStr = input ? JSON.stringify(input) : "";
	if (inputStr.length <= UNKNOWN_INPUT_LIMIT) {
		return `→ Tool: \`${name}\` ${inputStr}`;
	}
	return `→ Tool: \`${name}\` ${startEndTrim(inputStr, UNKNOWN_INPUT_LIMIT)}`;
}

// ---------------------------------------------------------------------------
// Tool result summarisation (user message → tool_result blocks)
// ---------------------------------------------------------------------------

/** Re-obtainable tools — results can be fetched again from disk. */
const RE_OBTAINABLE_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"WebFetch",
	"NotebookEdit",
]);

/** Tools whose results are just success/failure confirmations or internal setup. */
const DISPOSABLE_RESULT_TOOLS = new Set(["Edit", "Write", "ToolSearch"]);

/**
 * Generate a summary for a tool_result content block, or null to remove it.
 * Decision is based on the originating tool type (looked up from the ID map).
 *
 * @param {object} resultBlock - A content block with type: "tool_result"
 * @param {object|null} toolInfo - The originating tool's {name, input}, or null
 * @returns {string|null} Formatted result summary, or null to omit
 */
export function summarizeToolResult(resultBlock, toolInfo) {
	const content = extractResultText(resultBlock);
	const toolName = toolInfo?.name || "";

	// AskUserQuestion — ALWAYS keep (user decision channel)
	if (toolName === "AskUserQuestion") return `← User answered: ${content}`;

	// Re-obtainable — only keep short error responses
	if (RE_OBTAINABLE_TOOLS.has(toolName) || isSerenaReadTool(toolName)) {
		return isShortErrorResponse(content) ? `← Error: ${content}` : null;
	}

	// Write tools — just success/failure
	if (DISPOSABLE_RESULT_TOOLS.has(toolName) || isSerenaWriteTool(toolName))
		return null;

	// WebSearch — ephemeral results, keep
	if (toolName === "WebSearch")
		return `← Search results:\n${startEndTrim(content, WEB_SEARCH_LIMIT)}`;

	// Bash — keep action output (tests, builds), strip read-like output (ls, cat, find)
	if (toolName === "Bash") {
		if (!content) return null;
		if (isReadLikeBash(toolInfo?.input?.command))
			return isShortErrorResponse(content) ? `← Error: ${content}` : null;
		return `← ${startEndTrim(content, BASH_OUTPUT_LIMIT)}`;
	}

	// Agent — keep with trim
	if (toolName === "Agent")
		return content
			? `← Agent result:\n${startEndTrim(content, AGENT_RESULT_LIMIT)}`
			: null;

	// Sequential Thinking — redundant with input
	if (toolName.includes("sequential-thinking")) return null;
	// Context-mode — sandbox-internal
	if (toolName.includes("context-mode")) return null;
	// Serena memory — externally persisted
	if (toolName.includes("serena") && toolName.includes("memory")) return null;

	// Non-re-obtainable with errors — always keep
	if (content && isErrorResponse(content))
		return `← Error: ${startEndTrim(content, BASH_OUTPUT_LIMIT)}`;

	// Unknown — conservative: keep small, trim large
	if (!content) return null;
	return content.length < UNKNOWN_RESULT_LIMIT
		? `← ${content}`
		: `← ${startEndTrim(content, UNKNOWN_RESULT_LIMIT)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from a tool_result block.
 * The content field can be a string or an array of content blocks.
 */
function extractResultText(block) {
	if (!block) return "";
	const c = block.content;
	if (!c) return "";
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

/**
 * Generate a placeholder for non-text, non-tool content blocks
 * (images, documents, unknown types).
 *
 * @param {object} block - A content block
 * @returns {string|null} Placeholder text, or null if not applicable
 */
export function contentBlockPlaceholder(block) {
	if (!block || !block.type) return null;
	if (block.type === "image") return "[User shared an image]";
	if (block.type === "document") {
		const name = block.source?.filename || block.filename || null;
		return name
			? `[User shared a document: ${name}]`
			: "[User shared a document]";
	}
	if (
		block.type !== "text" &&
		block.type !== "tool_use" &&
		block.type !== "tool_result" &&
		block.type !== "thinking" &&
		block.type !== "redacted_thinking"
	) {
		return `[Unknown content block: ${block.type}]`;
	}
	return null;
}

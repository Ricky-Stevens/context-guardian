/**
 * MCP tool summarisation rules for specific server integrations.
 *
 * Handles Serena, Sequential Thinking, Context-mode, Context7, and
 * unknown MCP tools. Each server has tailored rules that preserve
 * high-value content while removing re-obtainable noise.
 *
 * @module mcp-tools
 */

import { startEndTrim } from "./trim.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum chars for sequential thinking thoughts before start+end trim. */
const THOUGHT_LIMIT = 2000;
/** Maximum chars for write content before start+end trim. */
const WRITE_LIMIT = 3000;
// ---------------------------------------------------------------------------
// MCP tool use dispatch
// ---------------------------------------------------------------------------

/**
 * Summarise an MCP tool_use block based on server and tool name.
 *
 * @param {string} name - Full MCP tool name (e.g. "mcp__serena__find_symbol")
 * @param {object} input - The tool input object
 * @param {function} indent - Indent helper function
 * @param {function} summarizeUnknown - Fallback for unknown tools
 * @returns {string|null} Formatted summary, or null to remove
 */
export function summarizeMcpToolUse(name, input, indent, summarizeUnknown) {
	if (name.includes("__serena__"))
		return summarizeSerenaTool(name, input, indent);
	if (name.includes("__sequential-thinking__"))
		return summarizeThinking(name, input);
	if (name.includes("context-mode")) return summarizeContextMode(name, input);
	if (name.includes("__context7__")) {
		return `→ Docs: \`${input?.libraryName || input?.query || name}\``;
	}
	return summarizeUnknown(name, input);
}

// ---------------------------------------------------------------------------
// Serena rules
// ---------------------------------------------------------------------------

/**
 * Summarise a Serena MCP tool based on the specific operation.
 * Write tools preserve code changes; read/query tools are note-only.
 *
 * @param {string} name - Full tool name
 * @param {object} input - Tool input
 * @param {function} indent - Indent helper
 * @returns {string|null} Formatted summary, or null to remove
 */
function summarizeSerenaTool(name, input, indent) {
	const toolName = name.split("__").pop();

	// Write operations — preserve code changes like Edit/Write
	if (toolName === "replace_symbol_body") {
		const body = input?.new_body || "";
		const sym = input?.name_path || input?.symbol_name || "unknown";
		const file = input?.relative_path || "";
		const trimmed = startEndTrim(body, WRITE_LIMIT);
		return `→ Serena: replaced \`${sym}\` in \`${file}\`:\n${indent(trimmed, 4)}`;
	}
	if (
		toolName === "insert_after_symbol" ||
		toolName === "insert_before_symbol"
	) {
		const body = input?.code || input?.body || "";
		const sym = input?.name_path || "";
		const trimmed = startEndTrim(body, WRITE_LIMIT);
		const dir = toolName.includes("after") ? "after" : "before";
		return `→ Serena: inserted ${dir} \`${sym}\`:\n${indent(trimmed, 4)}`;
	}
	if (toolName === "rename_symbol") {
		return `→ Serena: renamed \`${input?.old_name || ""}\` → \`${input?.new_name || ""}\``;
	}

	// Memory operations — externally persisted, note only
	if (toolName === "write_memory" || toolName === "edit_memory") {
		return `→ Serena: wrote memory \`${input?.name || input?.title || ""}\``;
	}
	if (
		["read_memory", "list_memories", "rename_memory", "delete_memory"].includes(
			toolName,
		)
	) {
		return `→ Serena: ${toolName.replace(/_/g, " ")}`;
	}

	// Setup/onboarding — noise
	if (
		[
			"onboarding",
			"check_onboarding_performed",
			"initial_instructions",
		].includes(toolName)
	) {
		return null;
	}

	// Read/query operations — re-obtainable, note only
	const query =
		input?.name_path || input?.pattern || input?.relative_path || "";
	return `→ Serena: ${toolName.replace(/_/g, " ")}${query ? ` \`${query}\`` : ""}`;
}

// ---------------------------------------------------------------------------
// Sequential Thinking rules
// ---------------------------------------------------------------------------

/**
 * Summarise a sequential thinking tool call.
 * The thought field IS the reasoning chain — preserve it.
 */
function summarizeThinking(_name, input) {
	const thought = input?.thought || "";
	const step = input?.thoughtNumber || "?";
	const total = input?.totalThoughts || "?";
	const trimmed = startEndTrim(thought, THOUGHT_LIMIT);
	return `→ Thinking (step ${step}/${total}): ${trimmed}`;
}

// ---------------------------------------------------------------------------
// Context-mode rules
// ---------------------------------------------------------------------------

/**
 * Summarise a context-mode tool call.
 * Results are sandbox-internal — assistant text has the summary.
 */
function summarizeContextMode(name, input) {
	if (name.includes("batch_execute")) {
		const n = Array.isArray(input?.commands) ? input.commands.length : "?";
		return `→ Context-mode: batch executed ${n} commands`;
	}
	if (name.includes("execute")) {
		return `→ Context-mode: executed ${input?.language || "code"}`;
	}
	if (name.includes("search")) {
		const queries = Array.isArray(input?.queries)
			? input.queries.join(", ")
			: "";
		return `→ Context-mode: searched ${queries}`;
	}
	if (name.includes("fetch_and_index")) {
		return `→ Context-mode: fetched \`${input?.url || ""}\``;
	}
	// index, stats — operational noise
	return null;
}

// ---------------------------------------------------------------------------
// Serena tool classification (used by tool_result handling)
// ---------------------------------------------------------------------------

/**
 * Check if a tool name is a Serena read/query operation.
 * @param {string} name - Tool name
 * @returns {boolean}
 */
export function isSerenaReadTool(name) {
	if (!name?.includes("serena")) return false;
	const tool = name.split("__").pop();
	return [
		"find_symbol",
		"get_symbols_overview",
		"search_for_pattern",
		"list_dir",
		"find_file",
		"find_referencing_symbols",
		"read_memory",
		"list_memories",
	].includes(tool);
}

/**
 * Check if a tool name is a Serena write operation.
 * @param {string} name - Tool name
 * @returns {boolean}
 */
export function isSerenaWriteTool(name) {
	if (!name?.includes("serena")) return false;
	const tool = name.split("__").pop();
	return [
		"replace_symbol_body",
		"insert_after_symbol",
		"insert_before_symbol",
		"rename_symbol",
		"write_memory",
		"edit_memory",
	].includes(tool);
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	contentBlockPlaceholder,
	formatEditDiff,
	summarizeToolResult,
	summarizeToolUse,
} from "../lib/tool-summary.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a string of exactly N characters. */
function chars(n, ch = "x") {
	return ch.repeat(n);
}

/** Build a tool_use block. */
function toolUse(name, input, id = "t1") {
	return { type: "tool_use", id, name, input };
}

/** Build a tool_result block with string content. */
function toolResult(content, toolUseId = "t1") {
	return { type: "tool_result", tool_use_id: toolUseId, content };
}

/** Build a tool_result block with array content. */
function toolResultArray(texts, toolUseId = "t1") {
	return {
		type: "tool_result",
		tool_use_id: toolUseId,
		content: texts.map((t) => ({ type: "text", text: t })),
	};
}

// ===========================================================================
// summarizeToolUse
// ===========================================================================

describe("summarizeToolUse", () => {
	// ── 1. Edit tool ──────────────────────────────────────────────────────

	describe("Edit tool", () => {
		it("produces old:/new: format with file path for small edits", () => {
			const block = toolUse("Edit", {
				file_path: "app.js",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Edit `app.js`"));
			assert.ok(result.includes("old:"));
			assert.ok(result.includes("new:"));
			assert.ok(result.includes("const x = 1;"));
			assert.ok(result.includes("const x = 2;"));
		});

		it("trims large edits (>3000 chars total)", () => {
			const big = chars(3500);
			const block = toolUse("Edit", {
				file_path: "big.js",
				old_string: big,
				new_string: big,
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Edit `big.js`"));
			assert.ok(result.includes("trimmed from middle"));
			assert.ok(result.length < big.length * 2);
		});
	});

	// ── 2. Write tool ─────────────────────────────────────────────────────

	describe("Write tool", () => {
		it("includes file path and full content for small writes", () => {
			const block = toolUse("Write", {
				file_path: "out.txt",
				content: "hello world",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Write `out.txt`"));
			assert.ok(result.includes("hello world"));
			assert.ok(!result.includes("chars)"));
		});

		it("trims large content with char count", () => {
			const big = chars(5000);
			const block = toolUse("Write", {
				file_path: "big.txt",
				content: big,
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Write `big.txt`"));
			assert.ok(result.includes("5000 chars"));
			assert.ok(result.includes("trimmed from middle"));
		});
	});

	// ── 3. Read tool ──────────────────────────────────────────────────────

	describe("Read tool", () => {
		it("emits note-only with file path", () => {
			const block = toolUse("Read", { file_path: "config.json" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Read `config.json`"));
			// Should be a short note, not contain file content
			assert.ok(result.split("\n").length <= 2);
		});

		it("includes offset info when present", () => {
			const block = toolUse("Read", { file_path: "big.js", offset: 100 });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("from line 100"));
		});
	});

	// ── 4. Bash tool ──────────────────────────────────────────────────────

	describe("Bash tool", () => {
		it("keeps short commands in full", () => {
			const block = toolUse("Bash", { command: "bun test" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("bun test"));
		});

		it("trims very long heredoc commands (>3000 chars)", () => {
			const longCmd = `cat <<'EOF'\n${chars(4000)}\nEOF`;
			const block = toolUse("Bash", { command: longCmd });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("trimmed from middle"));
			assert.ok(result.length < longCmd.length);
		});
	});

	// ── 5. Grep tool ──────────────────────────────────────────────────────

	describe("Grep tool", () => {
		it("emits pattern and path", () => {
			const block = toolUse("Grep", {
				pattern: "TODO",
				path: "src/",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Grep `TODO`"));
			assert.ok(result.includes("`src/`"));
		});

		it("works without path", () => {
			const block = toolUse("Grep", { pattern: "fixme" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Grep `fixme`"));
		});
	});

	// ── 6. Glob tool ──────────────────────────────────────────────────────

	describe("Glob tool", () => {
		it("emits pattern", () => {
			const block = toolUse("Glob", { pattern: "**/*.mjs" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Glob `**/*.mjs`"));
		});
	});

	// ── 7. Agent tool ─────────────────────────────────────────────────────

	describe("Agent tool", () => {
		it("includes description", () => {
			const block = toolUse("Agent", {
				description: "Find all usages of deprecated API",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Agent:"));
			assert.ok(result.includes("Find all usages of deprecated API"));
		});
	});

	// ── 8. AskUserQuestion ────────────────────────────────────────────────

	describe("AskUserQuestion", () => {
		it("includes question text", () => {
			const block = toolUse("AskUserQuestion", {
				question: "Should I proceed with the refactor?",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Asked user:"));
			assert.ok(result.includes("Should I proceed with the refactor?"));
		});
	});

	// ── 9. WebSearch ──────────────────────────────────────────────────────

	describe("WebSearch", () => {
		it("includes query", () => {
			const block = toolUse("WebSearch", { query: "node.js streams" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("WebSearch:"));
			assert.ok(result.includes("node.js streams"));
		});
	});

	// ── 10. WebFetch ─────────────────────────────────────────────────────

	describe("WebFetch", () => {
		it("includes URL", () => {
			const block = toolUse("WebFetch", {
				url: "https://example.com/api",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("WebFetch:"));
			assert.ok(result.includes("https://example.com/api"));
		});
	});

	// ── 11. NotebookEdit ─────────────────────────────────────────────────

	describe("NotebookEdit", () => {
		it("preserves small cell content", () => {
			const block = toolUse("NotebookEdit", {
				new_source: "print('hello')",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("NotebookEdit cell"));
			assert.ok(result.includes("print('hello')"));
		});

		it("trims large cells", () => {
			const big = chars(5000);
			const block = toolUse("NotebookEdit", { new_source: big });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("NotebookEdit cell"));
			assert.ok(result.includes("5000 chars"));
			assert.ok(result.includes("trimmed from middle"));
		});
	});

	// ── 12. Serena replace_symbol_body ────────────────────────────────────

	describe("Serena replace_symbol_body", () => {
		it("includes symbol name, path, and code body", () => {
			const block = toolUse("mcp__serena__replace_symbol_body", {
				name_path: "MyClass.myMethod",
				relative_path: "src/foo.mjs",
				new_body: "return 42;",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("replaced `MyClass.myMethod`"));
			assert.ok(result.includes("`src/foo.mjs`"));
			assert.ok(result.includes("return 42;"));
		});
	});

	// ── 13. Serena insert_after_symbol ────────────────────────────────────

	describe("Serena insert_after_symbol", () => {
		it("preserves inserted code", () => {
			const block = toolUse("mcp__serena__insert_after_symbol", {
				name_path: "MyClass",
				code: "function newHelper() {}",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("inserted after `MyClass`"));
			assert.ok(result.includes("function newHelper() {}"));
		});
	});

	// ── 14. Serena write_memory ──────────────────────────────────────────

	describe("Serena write_memory", () => {
		it("note only with name", () => {
			const block = toolUse("mcp__serena__write_memory", {
				name: "architecture-notes",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("wrote memory"));
			assert.ok(result.includes("architecture-notes"));
		});
	});

	// ── 15. Serena find_symbol ───────────────────────────────────────────

	describe("Serena find_symbol", () => {
		it("note only with query", () => {
			const block = toolUse("mcp__serena__find_symbol", {
				name_path: "extractConversation",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("find symbol"));
			assert.ok(result.includes("extractConversation"));
		});
	});

	// ── 16. Serena onboarding ────────────────────────────────────────────

	describe("Serena onboarding", () => {
		it("returns null (removed)", () => {
			const block = toolUse("mcp__serena__onboarding", {});
			const result = summarizeToolUse(block);
			assert.equal(result, null);
		});
	});

	// ── 17. Serena rename_symbol ─────────────────────────────────────────

	describe("Serena rename_symbol", () => {
		it("shows old -> new name", () => {
			const block = toolUse("mcp__serena__rename_symbol", {
				old_name: "oldFunc",
				new_name: "newFunc",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("`oldFunc`"));
			assert.ok(result.includes("`newFunc`"));
		});
	});

	// ── 18. Sequential thinking ──────────────────────────────────────────

	describe("Sequential thinking", () => {
		it("includes step N/M and thought text", () => {
			const block = toolUse("mcp__sequential-thinking__sequentialthinking", {
				thought: "Let me consider the trade-offs here.",
				thoughtNumber: 2,
				totalThoughts: 5,
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("step 2/5"));
			assert.ok(result.includes("Let me consider the trade-offs here."));
		});

		it("trims long thoughts", () => {
			const longThought = chars(3000);
			const block = toolUse("mcp__sequential-thinking__sequentialthinking", {
				thought: longThought,
				thoughtNumber: 1,
				totalThoughts: 1,
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("trimmed from middle"));
			assert.ok(result.length < longThought.length);
		});
	});

	// ── 19. Context-mode execute ─────────────────────────────────────────

	describe("Context-mode execute", () => {
		it("note only with language", () => {
			const block = toolUse("mcp__plugin_context-mode_context-mode__execute", {
				language: "python",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Context-mode:"));
			assert.ok(result.includes("python"));
		});
	});

	// ── 20. Context-mode batch_execute ───────────────────────────────────

	describe("Context-mode batch_execute", () => {
		it("note with command count", () => {
			const block = toolUse(
				"mcp__plugin_context-mode_context-mode__batch_execute",
				{ commands: [{ cmd: "a" }, { cmd: "b" }, { cmd: "c" }] },
			);
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Context-mode:"));
			assert.ok(result.includes("3 commands"));
		});
	});

	// ── 21. Context-mode stats/index ─────────────────────────────────────

	describe("Context-mode stats/index", () => {
		it("returns null for stats (removed)", () => {
			const block = toolUse("mcp__plugin_context-mode_context-mode__stats", {});
			const result = summarizeToolUse(block);
			assert.equal(result, null);
		});

		it("returns null for index (removed)", () => {
			const block = toolUse("mcp__plugin_context-mode_context-mode__index", {});
			const result = summarizeToolUse(block);
			assert.equal(result, null);
		});
	});

	// ── 22. Context7 ────────────────────────────────────────────────────

	describe("Context7", () => {
		it("emits docs note with library name", () => {
			const block = toolUse("mcp__context7__query-docs", {
				libraryName: "react",
			});
			const result = summarizeToolUse(block);
			assert.ok(result.includes("Docs:"));
			assert.ok(result.includes("react"));
		});
	});

	// ── 23. Unknown MCP tool ────────────────────────────────────────────

	describe("Unknown MCP tool", () => {
		it("preserves name and start+end trimmed input", () => {
			const bigInput = { data: chars(2000) };
			const block = toolUse("mcp__custom__my_tool", bigInput);
			const result = summarizeToolUse(block);
			assert.ok(result.includes("`mcp__custom__my_tool`"));
			assert.ok(result.includes("trimmed from middle"));
		});

		it("keeps small input in full", () => {
			const block = toolUse("mcp__custom__small_tool", { key: "val" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("`mcp__custom__small_tool`"));
			assert.ok(result.includes('"key"'));
		});
	});

	// ── 24. Unknown built-in tool ───────────────────────────────────────

	describe("Unknown built-in tool", () => {
		it("same conservative treatment", () => {
			const block = toolUse("SomeFutureTool", { foo: "bar" });
			const result = summarizeToolUse(block);
			assert.ok(result.includes("`SomeFutureTool`"));
			assert.ok(result.includes('"foo"'));
		});
	});

	// ── 25. Missing/null name ───────────────────────────────────────────

	describe("Missing/null name", () => {
		it("returns generic fallback for null name", () => {
			const block = { type: "tool_use", id: "t1", name: null, input: {} };
			const result = summarizeToolUse(block);
			assert.ok(result.includes("[unknown]"));
		});

		it("returns generic fallback for undefined name", () => {
			const block = { type: "tool_use", id: "t1", input: {} };
			const result = summarizeToolUse(block);
			assert.ok(result.includes("[unknown]"));
		});
	});
});

// ===========================================================================
// summarizeToolResult
// ===========================================================================

describe("summarizeToolResult", () => {
	// ── 1. AskUserQuestion — ALWAYS kept ─────────────────────────────────

	it("keeps AskUserQuestion result in full (user decision)", () => {
		const result = summarizeToolResult(
			toolResult("Yes, please proceed with option B"),
			{ name: "AskUserQuestion" },
		);
		assert.ok(result.includes("User answered:"));
		assert.ok(result.includes("Yes, please proceed with option B"));
	});

	// ── 2. Read result — removed ─────────────────────────────────────────

	it("removes Read result (re-obtainable)", () => {
		const longContent = chars(5000);
		const result = summarizeToolResult(toolResult(longContent), {
			name: "Read",
		});
		assert.equal(result, null);
	});

	// ── 3. Read result with short error ──────────────────────────────────

	it("keeps short error from Read result (<500 chars)", () => {
		const result = summarizeToolResult(toolResult("Error: file not found"), {
			name: "Read",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("Error"));
	});

	// ── 4. Read result with long content containing 'error' ──────────────

	it("removes Read result with long content containing 'error' (false positive)", () => {
		// A long file that happens to mention "error" is not a tool failure
		const longContent = `${chars(600)} error ${chars(600)}`;
		const result = summarizeToolResult(toolResult(longContent), {
			name: "Read",
		});
		assert.equal(result, null);
	});

	// ── 5. Grep/Glob result — removed ────────────────────────────────────

	it("removes Grep result", () => {
		const result = summarizeToolResult(toolResult("src/a.js:10: match"), {
			name: "Grep",
		});
		assert.equal(result, null);
	});

	it("removes Glob result", () => {
		const result = summarizeToolResult(toolResult("src/a.js\nsrc/b.js"), {
			name: "Glob",
		});
		assert.equal(result, null);
	});

	// ── 6. Edit/Write result — removed ───────────────────────────────────

	it("removes Edit result", () => {
		const result = summarizeToolResult(toolResult("File edited successfully"), {
			name: "Edit",
		});
		assert.equal(result, null);
	});

	it("removes Write result", () => {
		const result = summarizeToolResult(
			toolResult("File written successfully"),
			{ name: "Write" },
		);
		assert.equal(result, null);
	});

	// ── 7. Bash result, short (<5000) ────────────────────────────────────

	it("keeps short Bash result in full", () => {
		const result = summarizeToolResult(toolResult("12 passed, 0 failed"), {
			name: "Bash",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("12 passed, 0 failed"));
	});

	// ── 8. Bash result, long (>5000) ─────────────────────────────────────

	it("trims long Bash result with start+end", () => {
		const longOutput = chars(8000, "o");
		const result = summarizeToolResult(toolResult(longOutput), {
			name: "Bash",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("trimmed from middle"));
		assert.ok(result.length < longOutput.length);
	});

	// ── 9. Agent result, short ───────────────────────────────────────────

	it("keeps short Agent result in full", () => {
		const result = summarizeToolResult(
			toolResult("Found 3 usages of deprecated API"),
			{ name: "Agent" },
		);
		assert.ok(result !== null);
		assert.ok(result.includes("Agent result:"));
		assert.ok(result.includes("Found 3 usages"));
	});

	// ── 10. Agent result, long (>2000) ───────────────────────────────────

	it("trims long Agent result with start+end", () => {
		const longResult = chars(3000);
		const result = summarizeToolResult(toolResult(longResult), {
			name: "Agent",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("Agent result:"));
		assert.ok(result.includes("trimmed from middle"));
	});

	// ── 11. Sequential thinking result — removed ─────────────────────────

	it("removes sequential thinking result (redundant)", () => {
		const result = summarizeToolResult(toolResult("Thought recorded"), {
			name: "mcp__sequential-thinking__sequentialthinking",
		});
		assert.equal(result, null);
	});

	// ── 12. Context-mode result — removed ────────────────────────────────

	it("removes context-mode result", () => {
		const result = summarizeToolResult(toolResult("Execution complete"), {
			name: "mcp__plugin_context-mode_context-mode__execute",
		});
		assert.equal(result, null);
	});

	// ── 13. Serena memory result — removed ───────────────────────────────

	it("removes Serena memory result", () => {
		const result = summarizeToolResult(toolResult("Memory saved"), {
			name: "mcp__serena__write_memory",
		});
		assert.equal(result, null);
	});

	// ── 14. Non-re-obtainable tool with error content ────────────────────

	it("keeps error from non-re-obtainable tool", () => {
		const result = summarizeToolResult(
			toolResult("Error: connection timeout"),
			{ name: "SomeCustomTool" },
		);
		assert.ok(result !== null);
		assert.ok(result.includes("Error"));
	});

	// ── 15. Unknown tool, short result (<1000) ──────────────────────────

	it("keeps short unknown tool result", () => {
		const result = summarizeToolResult(toolResult("some short output"), {
			name: "UnknownTool",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("some short output"));
	});

	// ── 16. Unknown tool, long result (>=1000) ──────────────────────────

	it("trims long unknown tool result", () => {
		const longResult = chars(1500);
		const result = summarizeToolResult(toolResult(longResult), {
			name: "UnknownTool",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("trimmed from middle"));
	});

	// ── 17. Null/empty result content ───────────────────────────────────

	it("returns null for null result block", () => {
		const result = summarizeToolResult(null, { name: "Bash" });
		assert.equal(result, null);
	});

	it("returns null for empty string content", () => {
		const result = summarizeToolResult(toolResult(""), { name: "Bash" });
		assert.equal(result, null);
	});

	it("returns null for missing content field", () => {
		const result = summarizeToolResult(
			{ type: "tool_result", tool_use_id: "t1" },
			{ name: "Bash" },
		);
		assert.equal(result, null);
	});

	// ── Array content format ────────────────────────────────────────────

	it("handles array content format in tool_result", () => {
		const result = summarizeToolResult(toolResultArray(["line 1", "line 2"]), {
			name: "Bash",
		});
		assert.ok(result !== null);
		assert.ok(result.includes("line 1"));
		assert.ok(result.includes("line 2"));
	});
});

// ===========================================================================
// formatEditDiff
// ===========================================================================

describe("formatEditDiff", () => {
	it("shows both old and new for small edit", () => {
		const result = formatEditDiff("app.js", "const a = 1;", "const a = 2;");
		assert.ok(result.includes("Edit `app.js`"));
		assert.ok(result.includes("old:"));
		assert.ok(result.includes("new:"));
		assert.ok(result.includes("const a = 1;"));
		assert.ok(result.includes("const a = 2;"));
	});

	it("trims each side independently for large edit", () => {
		const bigOld = chars(3000, "a");
		const bigNew = chars(3000, "b");
		const result = formatEditDiff("big.js", bigOld, bigNew);
		assert.ok(result.includes("Edit `big.js`"));
		assert.ok(result.includes("old:"));
		assert.ok(result.includes("new:"));
		assert.ok(result.includes("trimmed from middle"));
		// Both sides should be trimmed — total should be well under 6000
		assert.ok(result.length < bigOld.length + bigNew.length);
	});

	it("shows only new: block for pure insertion (no old_string)", () => {
		const result = formatEditDiff("app.js", "", "const b = 2;");
		assert.ok(result.includes("new:"));
		assert.ok(!result.includes("old:"));
		assert.ok(result.includes("const b = 2;"));
	});

	it("shows old: block with [deleted] note for pure deletion", () => {
		const result = formatEditDiff("app.js", "const c = 3;", "");
		assert.ok(result.includes("old:"));
		assert.ok(result.includes("[deleted]"));
		assert.ok(!result.includes("new:"));
		assert.ok(result.includes("const c = 3;"));
	});

	it("still has Edit header when both are empty", () => {
		const result = formatEditDiff("app.js", "", "");
		assert.ok(result.includes("Edit `app.js`"));
	});
});

// ===========================================================================
// contentBlockPlaceholder
// ===========================================================================

describe("contentBlockPlaceholder", () => {
	it("returns image placeholder for image block", () => {
		const result = contentBlockPlaceholder({ type: "image" });
		assert.equal(result, "[User shared an image]");
	});

	it("returns document placeholder with filename", () => {
		const result = contentBlockPlaceholder({
			type: "document",
			source: { filename: "report.pdf" },
		});
		assert.equal(result, "[User shared a document: report.pdf]");
	});

	it("returns document placeholder without filename", () => {
		const result = contentBlockPlaceholder({ type: "document" });
		assert.equal(result, "[User shared a document]");
	});

	it("returns null for text block", () => {
		assert.equal(contentBlockPlaceholder({ type: "text", text: "hi" }), null);
	});

	it("returns null for tool_use block", () => {
		assert.equal(
			contentBlockPlaceholder({ type: "tool_use", name: "Edit" }),
			null,
		);
	});

	it("returns null for tool_result block", () => {
		assert.equal(
			contentBlockPlaceholder({ type: "tool_result", content: "ok" }),
			null,
		);
	});

	it("returns null for thinking block", () => {
		assert.equal(
			contentBlockPlaceholder({ type: "thinking", thinking: "hmm" }),
			null,
		);
	});

	it("returns unknown placeholder for unrecognised type", () => {
		const result = contentBlockPlaceholder({ type: "foo" });
		assert.equal(result, "[Unknown content block: foo]");
	});

	it("returns null for null/missing block", () => {
		assert.equal(contentBlockPlaceholder(null), null);
		assert.equal(contentBlockPlaceholder(undefined), null);
		assert.equal(contentBlockPlaceholder({}), null);
	});
});

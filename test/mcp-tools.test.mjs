import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isSerenaReadTool,
	isSerenaWriteTool,
	summarizeMcpToolUse,
} from "../lib/mcp-tools.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chars(n, ch = "x") {
	return ch.repeat(n);
}

function indent(text, n = 4) {
	const pad = " ".repeat(n);
	return text
		.split("\n")
		.map((l) => pad + l)
		.join("\n");
}

function unknownFallback(name, input) {
	return `→ \`${name}\`: ${JSON.stringify(input).slice(0, 200)}`;
}

// ===========================================================================
// summarizeMcpToolUse
// ===========================================================================

describe("summarizeMcpToolUse", () => {
	// ── Serena tools ─────────────────────────────────────────────────────

	describe("Serena tools", () => {
		it("replace_symbol_body preserves code body", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__replace_symbol_body",
				{
					name_path: "Foo.bar",
					relative_path: "src/foo.mjs",
					new_body: "return 42;",
				},
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("replaced `Foo.bar`"));
			assert.ok(result.includes("`src/foo.mjs`"));
			assert.ok(result.includes("return 42;"));
		});

		it("replace_symbol_body trims large bodies", () => {
			const big = chars(5000);
			const result = summarizeMcpToolUse(
				"mcp__serena__replace_symbol_body",
				{ name_path: "X", relative_path: "a.js", new_body: big },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("trimmed from middle"));
			assert.ok(result.length < big.length);
		});

		it("insert_after_symbol preserves code", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__insert_after_symbol",
				{ name_path: "MyClass", code: "function helper() {}" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("inserted after `MyClass`"));
			assert.ok(result.includes("function helper() {}"));
		});

		it("insert_before_symbol says 'before'", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__insert_before_symbol",
				{ name_path: "MyClass", code: "const x = 1;" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("inserted before `MyClass`"));
		});

		it("rename_symbol shows old and new names", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__rename_symbol",
				{ old_name: "oldFn", new_name: "newFn" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("`oldFn`"));
			assert.ok(result.includes("`newFn`"));
		});

		it("write_memory emits note with name", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__write_memory",
				{ name: "arch-notes" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("wrote memory"));
			assert.ok(result.includes("arch-notes"));
		});

		it("edit_memory emits note with name", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__edit_memory",
				{ name: "my-mem" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("wrote memory"));
			assert.ok(result.includes("my-mem"));
		});

		const readOnlyOps = [
			"read_memory",
			"list_memories",
			"rename_memory",
			"delete_memory",
		];
		for (const op of readOnlyOps) {
			it(`${op} emits note-only`, () => {
				const result = summarizeMcpToolUse(
					`mcp__serena__${op}`,
					{},
					indent,
					unknownFallback,
				);
				assert.ok(result.includes(op.replace(/_/g, " ")));
			});
		}

		const removedOps = [
			"onboarding",
			"check_onboarding_performed",
			"initial_instructions",
		];
		for (const op of removedOps) {
			it(`${op} returns null (noise)`, () => {
				const result = summarizeMcpToolUse(
					`mcp__serena__${op}`,
					{},
					indent,
					unknownFallback,
				);
				assert.equal(result, null);
			});
		}

		it("find_symbol emits note with query", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__find_symbol",
				{ name_path: "extractConversation" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("find symbol"));
			assert.ok(result.includes("extractConversation"));
		});

		it("get_symbols_overview emits note with path", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__get_symbols_overview",
				{ relative_path: "lib/" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("get symbols overview"));
			assert.ok(result.includes("lib/"));
		});

		it("handles missing input fields gracefully", () => {
			const result = summarizeMcpToolUse(
				"mcp__serena__replace_symbol_body",
				{},
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("replaced `unknown`"));
		});
	});

	// ── Sequential thinking ──────────────────────────────────────────────

	describe("Sequential thinking", () => {
		it("includes step number and thought", () => {
			const result = summarizeMcpToolUse(
				"mcp__sequential-thinking__sequentialthinking",
				{ thought: "Consider trade-offs.", thoughtNumber: 2, totalThoughts: 5 },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("step 2/5"));
			assert.ok(result.includes("Consider trade-offs."));
		});

		it("trims long thoughts", () => {
			const long = chars(4000);
			const result = summarizeMcpToolUse(
				"mcp__sequential-thinking__sequentialthinking",
				{ thought: long, thoughtNumber: 1, totalThoughts: 1 },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("trimmed from middle"));
			assert.ok(result.length < long.length);
		});

		it("handles missing fields with ? placeholders", () => {
			const result = summarizeMcpToolUse(
				"mcp__sequential-thinking__sequentialthinking",
				{},
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("step ?/?"));
		});
	});

	// ── Context-mode ─────────────────────────────────────────────────────

	describe("Context-mode", () => {
		it("execute shows language", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__execute",
				{ language: "python" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("Context-mode:"));
			assert.ok(result.includes("python"));
		});

		it("batch_execute shows command count", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__batch_execute",
				{ commands: [{ cmd: "a" }, { cmd: "b" }] },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("2 commands"));
		});

		it("batch_execute with non-array shows ?", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__batch_execute",
				{ commands: "not-an-array" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("? commands"));
		});

		it("search shows queries", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__search",
				{ queries: ["foo", "bar"] },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("searched foo, bar"));
		});

		it("fetch_and_index shows URL", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__fetch_and_index",
				{ url: "https://example.com" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("https://example.com"));
		});

		it("stats returns null (noise)", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__stats",
				{},
				indent,
				unknownFallback,
			);
			assert.equal(result, null);
		});

		it("index returns null (noise)", () => {
			const result = summarizeMcpToolUse(
				"mcp__plugin_context-mode_context-mode__index",
				{},
				indent,
				unknownFallback,
			);
			assert.equal(result, null);
		});
	});

	// ── Context7 ─────────────────────────────────────────────────────────

	describe("Context7", () => {
		it("shows library name", () => {
			const result = summarizeMcpToolUse(
				"mcp__context7__query-docs",
				{ libraryName: "react" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("Docs:"));
			assert.ok(result.includes("react"));
		});

		it("falls back to query field", () => {
			const result = summarizeMcpToolUse(
				"mcp__context7__resolve-library-id",
				{ query: "next.js" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("Docs:"));
			assert.ok(result.includes("next.js"));
		});

		it("falls back to tool name when no input fields", () => {
			const result = summarizeMcpToolUse(
				"mcp__context7__query-docs",
				{},
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("Docs:"));
			assert.ok(result.includes("mcp__context7__query-docs"));
		});
	});

	// ── Unknown MCP tool ─────────────────────────────────────────────────

	describe("Unknown MCP tool", () => {
		it("delegates to unknownFallback", () => {
			const result = summarizeMcpToolUse(
				"mcp__custom__my_tool",
				{ key: "val" },
				indent,
				unknownFallback,
			);
			assert.ok(result.includes("`mcp__custom__my_tool`"));
			assert.ok(result.includes('"key"'));
		});
	});
});

// ===========================================================================
// isSerenaReadTool
// ===========================================================================

describe("isSerenaReadTool", () => {
	const readTools = [
		"mcp__serena__find_symbol",
		"mcp__serena__get_symbols_overview",
		"mcp__serena__search_for_pattern",
		"mcp__serena__list_dir",
		"mcp__serena__find_file",
		"mcp__serena__find_referencing_symbols",
		"mcp__serena__read_memory",
		"mcp__serena__list_memories",
	];
	for (const name of readTools) {
		it(`returns true for ${name.split("__").pop()}`, () => {
			assert.equal(isSerenaReadTool(name), true);
		});
	}

	const notReadTools = [
		"mcp__serena__replace_symbol_body",
		"mcp__serena__insert_after_symbol",
		"mcp__serena__rename_symbol",
		"mcp__serena__write_memory",
		"mcp__serena__onboarding",
	];
	for (const name of notReadTools) {
		it(`returns false for ${name.split("__").pop()}`, () => {
			assert.equal(isSerenaReadTool(name), false);
		});
	}

	it("returns false for null", () => {
		assert.equal(isSerenaReadTool(null), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isSerenaReadTool(undefined), false);
	});

	it("returns false for non-serena tool", () => {
		assert.equal(isSerenaReadTool("Read"), false);
		assert.equal(isSerenaReadTool("mcp__context7__query-docs"), false);
	});
});

// ===========================================================================
// isSerenaWriteTool
// ===========================================================================

describe("isSerenaWriteTool", () => {
	const writeTools = [
		"mcp__serena__replace_symbol_body",
		"mcp__serena__insert_after_symbol",
		"mcp__serena__insert_before_symbol",
		"mcp__serena__rename_symbol",
		"mcp__serena__write_memory",
		"mcp__serena__edit_memory",
	];
	for (const name of writeTools) {
		it(`returns true for ${name.split("__").pop()}`, () => {
			assert.equal(isSerenaWriteTool(name), true);
		});
	}

	const notWriteTools = [
		"mcp__serena__find_symbol",
		"mcp__serena__get_symbols_overview",
		"mcp__serena__list_dir",
		"mcp__serena__onboarding",
	];
	for (const name of notWriteTools) {
		it(`returns false for ${name.split("__").pop()}`, () => {
			assert.equal(isSerenaWriteTool(name), false);
		});
	}

	it("returns false for null", () => {
		assert.equal(isSerenaWriteTool(null), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isSerenaWriteTool(undefined), false);
	});

	it("returns false for non-serena tool", () => {
		assert.equal(isSerenaWriteTool("Edit"), false);
		assert.equal(isSerenaWriteTool("mcp__context7__query-docs"), false);
	});
});

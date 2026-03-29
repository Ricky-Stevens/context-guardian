import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dirname, "../lib/statusline.mjs");

function runStatusline(input) {
	const result = spawnSync("node", [scriptPath], {
		input: typeof input === "string" ? input : JSON.stringify(input),
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PLUGIN_DATA: "/tmp/cg-statusline-test-nonexistent",
		},
	});
	return result.stdout;
}

describe("statusline render", () => {
	test("empty object shows '--'", () => {
		const out = runStatusline({});
		expect(out).toContain("Context usage: --");
	});

	test("empty context_window shows '--'", () => {
		const out = runStatusline({ context_window: {} });
		expect(out).toContain("Context usage: --");
	});

	test("null used_percentage shows '--'", () => {
		const out = runStatusline({ context_window: { used_percentage: null } });
		expect(out).toContain("Context usage: --");
	});

	test("0% is valid, not '--'", () => {
		const out = runStatusline({ context_window: { used_percentage: 0 } });
		expect(out).toContain("Context usage: 0%");
		expect(out).not.toContain("--");
	});

	test("3% shows percentage and remaining until alert", () => {
		const out = runStatusline({ context_window: { used_percentage: 3 } });
		expect(out).toContain("Context usage: 3%");
		expect(out).toContain("32% remaining until alert");
	});

	test("55% includes yellow ANSI code", () => {
		const out = runStatusline({ context_window: { used_percentage: 55 } });
		expect(out).toContain("\x1b[33m");
	});

	test("70% includes red ANSI code", () => {
		const out = runStatusline({ context_window: { used_percentage: 70 } });
		expect(out).toContain("\x1b[31m");
	});

	test("40% shows alert threshold reached (>= 35 default)", () => {
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		expect(out).toContain("alert threshold reached");
	});

	test("invalid JSON input falls back to 'Context: --'", () => {
		const out = runStatusline("not valid json {{{");
		expect(out).toBe("Context: --");
	});

	test("output contains /cg:stats for more", () => {
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		expect(out).toContain("/cg:stats for more");
	});
});

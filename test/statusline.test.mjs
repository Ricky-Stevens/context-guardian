import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dirname, "../lib/statusline.mjs");

function runStatusline(input, env) {
	const result = spawnSync("node", [scriptPath], {
		input: typeof input === "string" ? input : JSON.stringify(input),
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PLUGIN_DATA: "/tmp/cg-statusline-test-nonexistent",
			...env,
		},
	});
	return result.stdout;
}

function runWithThreshold(input, threshold) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sl-"));
	fs.writeFileSync(
		path.join(tmpDir, "config.json"),
		JSON.stringify({ threshold }),
	);
	const out = runStatusline(input, { CLAUDE_PLUGIN_DATA: tmpDir });
	fs.rmSync(tmpDir, { recursive: true, force: true });
	return out;
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

	test("invalid JSON input falls back to 'Context: --'", () => {
		const out = runStatusline("not valid json {{{");
		expect(out).toBe("Context: --");
	});

	test("output contains /cg:stats for more", () => {
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		expect(out).toContain("/cg:stats for more");
	});
});

describe("threshold-relative colors", () => {
	test("well below threshold shows green", () => {
		// Default threshold 35%, pct 10% → 10 < 35*0.7=24.5 → green
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		expect(out).toContain("\x1b[32m"); // green
	});

	test("approaching threshold shows yellow", () => {
		// Default threshold 35%, pct 30% → 30 >= 24.5 && 30 < 35 → yellow
		const out = runStatusline({ context_window: { used_percentage: 30 } });
		expect(out).toContain("\x1b[33m"); // yellow
	});

	test("at threshold shows bold red", () => {
		// Default threshold 35%, pct 40% → 40 >= 35 → bold red
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		expect(out).toContain("\x1b[1;31m"); // bold red
	});

	test("colors adjust with custom threshold", () => {
		// threshold 0.70 → green < 49%, yellow 49-70%, red >= 70%
		const greenOut = runWithThreshold(
			{ context_window: { used_percentage: 20 } },
			0.7,
		);
		expect(greenOut).toContain("\x1b[32m");

		const yellowOut = runWithThreshold(
			{ context_window: { used_percentage: 55 } },
			0.7,
		);
		expect(yellowOut).toContain("\x1b[33m");

		const redOut = runWithThreshold(
			{ context_window: { used_percentage: 75 } },
			0.7,
		);
		expect(redOut).toContain("\x1b[1;31m");
	});
});

describe("alert state messaging", () => {
	test("at threshold shows actionable compaction message", () => {
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		expect(out).toContain("compaction recommended");
		expect(out).toContain("/cg:compact");
	});

	test("at threshold uses bold red for alert text", () => {
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		// Alert string itself should use bold red
		expect(out).toContain("\x1b[1;31m| compaction recommended");
	});

	test("below threshold shows remaining until alert", () => {
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		expect(out).toContain("remaining until alert");
		expect(out).not.toContain("compaction recommended");
	});
});

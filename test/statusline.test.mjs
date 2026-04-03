import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

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
	it("empty object shows '--'", () => {
		const out = runStatusline({});
		assert.ok(out.includes("Context usage: --"));
	});

	it("empty context_window shows '--'", () => {
		const out = runStatusline({ context_window: {} });
		assert.ok(out.includes("Context usage: --"));
	});

	it("null used_percentage shows '--'", () => {
		const out = runStatusline({ context_window: { used_percentage: null } });
		assert.ok(out.includes("Context usage: --"));
	});

	it("0% is valid, not '--'", () => {
		const out = runStatusline({ context_window: { used_percentage: 0 } });
		assert.ok(out.includes("Context usage: 0%"));
		assert.ok(!out.includes("--"));
	});

	it("3% shows percentage and remaining until alert", () => {
		const out = runStatusline({ context_window: { used_percentage: 3 } });
		assert.ok(out.includes("Context usage: 3%"));
		assert.ok(out.includes("32% remaining until alert"));
	});

	it("invalid JSON input falls back to 'Context: --'", () => {
		const out = runStatusline("not valid json {{{");
		assert.equal(out, "Context: --");
	});

	it("output contains /cg:stats for more", () => {
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		assert.ok(out.includes("/cg:stats for more"));
	});
});

describe("threshold-relative colors", () => {
	it("well below threshold shows green", () => {
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		assert.ok(out.includes("\x1b[32m")); // green
	});

	it("approaching threshold shows yellow", () => {
		const out = runStatusline({ context_window: { used_percentage: 30 } });
		assert.ok(out.includes("\x1b[33m")); // yellow
	});

	it("at threshold shows bold red", () => {
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		assert.ok(out.includes("\x1b[1;31m")); // bold red
	});

	it("colors adjust with custom threshold", () => {
		const greenOut = runWithThreshold(
			{ context_window: { used_percentage: 20 } },
			0.7,
		);
		assert.ok(greenOut.includes("\x1b[32m"));

		const yellowOut = runWithThreshold(
			{ context_window: { used_percentage: 55 } },
			0.7,
		);
		assert.ok(yellowOut.includes("\x1b[33m"));

		const redOut = runWithThreshold(
			{ context_window: { used_percentage: 75 } },
			0.7,
		);
		assert.ok(redOut.includes("\x1b[1;31m"));
	});
});

describe("alert state messaging", () => {
	it("at threshold shows actionable compaction message", () => {
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		assert.ok(out.includes("compaction recommended"));
		assert.ok(out.includes("/cg:compact"));
	});

	it("at threshold uses bold red for alert text", () => {
		const out = runStatusline({ context_window: { used_percentage: 40 } });
		assert.ok(out.includes("\x1b[1;31m| compaction recommended"));
	});

	it("below threshold shows remaining until alert", () => {
		const out = runStatusline({ context_window: { used_percentage: 10 } });
		assert.ok(out.includes("remaining until alert"));
		assert.ok(!out.includes("compaction recommended"));
	});
});

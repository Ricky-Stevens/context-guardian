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

function runWithPayload(input, payloadBytes) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sl-"));
	fs.writeFileSync(
		path.join(tmpDir, "config.json"),
		JSON.stringify({ threshold: 0.35 }),
	);
	fs.writeFileSync(
		path.join(tmpDir, "state-test.json"),
		JSON.stringify({ payload_bytes: payloadBytes, ts: Date.now() }),
	);
	const out = runStatusline(input, { CLAUDE_PLUGIN_DATA: tmpDir });
	fs.rmSync(tmpDir, { recursive: true, force: true });
	return out;
}

// Strip ANSI escape codes for content-only assertions
function strip(str) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code stripping
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("statusline render", () => {
	it("empty object shows '--'", () => {
		const out = strip(runStatusline({}));
		assert.ok(out.includes("Context usage: --"));
	});

	it("empty context_window shows '--'", () => {
		const out = strip(runStatusline({ context_window: {} }));
		assert.ok(out.includes("Context usage: --"));
	});

	it("null used_percentage shows '--'", () => {
		const out = strip(
			runStatusline({ context_window: { used_percentage: null } }),
		);
		assert.ok(out.includes("Context usage: --"));
	});

	it("0% is valid, not 'Context usage: --'", () => {
		const out = strip(
			runStatusline({ context_window: { used_percentage: 0 } }),
		);
		assert.ok(out.includes("Context usage:"));
		assert.ok(out.includes("0%"));
		assert.ok(!out.includes("Context usage: --"));
	});

	it("3% shows percentage and /cg:stats hint", () => {
		const out = strip(
			runStatusline({ context_window: { used_percentage: 3 } }),
		);
		assert.ok(out.includes("Context usage:"));
		assert.ok(out.includes("3%"));
		assert.ok(out.includes("/cg:stats for more"));
	});

	it("invalid JSON input falls back to 'Context: --'", () => {
		const out = runStatusline("not valid json {{{");
		assert.equal(out, "Context: --");
	});

	it("output contains /cg:stats for more", () => {
		const out = strip(
			runStatusline({ context_window: { used_percentage: 10 } }),
		);
		assert.ok(out.includes("/cg:stats for more"));
	});
});

describe("threshold-relative colors", () => {
	it("well below threshold: dim label, green number", () => {
		const raw = runStatusline({ context_window: { used_percentage: 10 } });
		assert.ok(raw.includes("\x1b[2mContext usage:\x1b[0m")); // dim label
		assert.ok(raw.includes("\x1b[32m10%")); // green number
	});

	it("approaching threshold: dim label, yellow number", () => {
		// Default adaptive threshold for 200K is 55%, yellow starts at 55*0.7=38.5%
		const raw = runStatusline({ context_window: { used_percentage: 45 } });
		assert.ok(raw.includes("\x1b[2mContext usage:\x1b[0m")); // dim label
		assert.ok(raw.includes("\x1b[33m45%")); // yellow number
	});

	it("at threshold: bold red on entire label+number", () => {
		// Default adaptive threshold for 200K is 55%
		const raw = runStatusline({ context_window: { used_percentage: 60 } });
		assert.ok(raw.includes("\x1b[1;31mContext usage: 60%")); // bold red full
	});

	it("colors adjust with custom threshold", () => {
		const greenRaw = runWithThreshold(
			{ context_window: { used_percentage: 20 } },
			0.7,
		);
		assert.ok(greenRaw.includes("\x1b[32m20%"));

		const yellowRaw = runWithThreshold(
			{ context_window: { used_percentage: 55 } },
			0.7,
		);
		assert.ok(yellowRaw.includes("\x1b[33m55%"));

		const redRaw = runWithThreshold(
			{ context_window: { used_percentage: 75 } },
			0.7,
		);
		assert.ok(redRaw.includes("\x1b[1;31mContext usage: 75%"));
	});

	it("adaptive threshold: 1M window uses lower threshold than 200K", () => {
		// 1M adaptive threshold = 30%, so 25% is yellow (above 30*0.7=21%)
		const yellowRaw = runStatusline({
			context_window: { used_percentage: 25, context_window_size: 1000000 },
		});
		assert.ok(yellowRaw.includes("\x1b[33m25%")); // yellow

		// 35% is red on 1M (above 30% threshold)
		const redRaw = runStatusline({
			context_window: { used_percentage: 35, context_window_size: 1000000 },
		});
		assert.ok(redRaw.includes("\x1b[1;31mContext usage: 35%")); // bold red

		// Same 35% on 200K is green (below 55*0.7=38.5%)
		const greenRaw = runStatusline({
			context_window: { used_percentage: 35, context_window_size: 200000 },
		});
		assert.ok(greenRaw.includes("\x1b[32m35%")); // green
	});
});

describe("session size display", () => {
	it("shows session size when state file has payload_bytes", () => {
		const out = strip(
			runWithPayload(
				{ context_window: { used_percentage: 10 } },
				5 * 1024 * 1024,
			),
		);
		assert.ok(out.includes("Session size:"));
		assert.ok(out.includes("5.0/20MB"));
	});

	it("under 10MB: dim label, green number, dim /20MB", () => {
		const raw = runWithPayload(
			{ context_window: { used_percentage: 10 } },
			5 * 1024 * 1024,
		);
		assert.ok(raw.includes("\x1b[2mSession size:\x1b[0m")); // dim label
		assert.ok(raw.includes("\x1b[32m")); // green number
		assert.ok(raw.includes("\x1b[2m/20MB")); // dim /20MB
	});

	it("10-15MB: dim label, yellow number", () => {
		const raw = runWithPayload(
			{ context_window: { used_percentage: 10 } },
			12 * 1024 * 1024,
		);
		assert.ok(raw.includes("\x1b[2mSession size:\x1b[0m")); // dim label
		assert.ok(raw.includes("\x1b[33m")); // yellow
		assert.ok(strip(raw).includes("/20MB"));
	});

	it("15MB+: bold red on entire label+number", () => {
		const raw = runWithPayload(
			{ context_window: { used_percentage: 10 } },
			17 * 1024 * 1024,
		);
		assert.ok(raw.includes("\x1b[1;31mSession size:")); // bold red full
		assert.ok(strip(raw).includes("17.0/20MB"));
	});

	it("shows -- when state file missing", () => {
		const out = strip(
			runStatusline({ context_window: { used_percentage: 10 } }),
		);
		assert.ok(!out.includes("Session size:"));
		assert.ok(out.includes("--"));
	});

	it("shows -- when payload_bytes is 0", () => {
		const out = strip(
			runWithPayload({ context_window: { used_percentage: 10 } }, 0),
		);
		assert.ok(!out.includes("Session size:"));
		assert.ok(out.includes("--"));
	});
});

describe("context window size persistence", () => {
	const stateDir = path.join(os.homedir(), ".claude", "cg");

	it("writes context_window_size into per-session state file", () => {
		const sessionId = `sl-test-${Date.now()}`;
		const stateFile = path.join(stateDir, `state-${sessionId}.json`);
		try {
			runStatusline({
				session_id: sessionId,
				context_window: {
					used_percentage: 10,
					context_window_size: 1000000,
				},
			});

			assert.ok(fs.existsSync(stateFile), "state file should exist");
			const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			assert.equal(data.context_window_size, 1000000);
		} finally {
			try {
				fs.unlinkSync(stateFile);
			} catch {}
		}
	});

	it("merges context_window_size into existing state file", () => {
		const sessionId = `sl-test-${Date.now()}`;
		const stateFile = path.join(stateDir, `state-${sessionId}.json`);
		try {
			// Pre-populate state file (as a hook would)
			fs.mkdirSync(stateDir, { recursive: true });
			fs.writeFileSync(
				stateFile,
				JSON.stringify({ current_tokens: 5000, max_tokens: 200000 }),
			);

			runStatusline({
				session_id: sessionId,
				context_window: {
					used_percentage: 10,
					context_window_size: 1000000,
				},
			});

			const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			assert.equal(data.context_window_size, 1000000);
			assert.equal(data.current_tokens, 5000); // preserved
		} finally {
			try {
				fs.unlinkSync(stateFile);
			} catch {}
		}
	});

	it("does not write when context_window_size is missing", () => {
		const sessionId = `sl-test-nowrite-${Date.now()}`;
		const stateFile = path.join(stateDir, `state-${sessionId}.json`);
		try {
			runStatusline({
				session_id: sessionId,
				context_window: { used_percentage: 10 },
			});

			assert.equal(fs.existsSync(stateFile), false);
		} finally {
			try {
				fs.unlinkSync(stateFile);
			} catch {}
		}
	});

	it("does not write when session_id is missing", () => {
		// Without session_id, we can't target a state file
		// Just verify no crash — the render output should still work
		const out = strip(
			runStatusline({
				context_window: {
					used_percentage: 10,
					context_window_size: 1000000,
				},
			}),
		);
		assert.ok(out.includes("10%"));
	});
});

describe("alert state messaging", () => {
	it("at threshold shows actionable compaction message", () => {
		// Default adaptive threshold for 200K is 55%
		const out = strip(
			runStatusline({ context_window: { used_percentage: 60 } }),
		);
		assert.ok(out.includes("compaction recommended"));
		assert.ok(out.includes("/cg:compact"));
	});

	it("at threshold uses bold red for alert text", () => {
		// Default adaptive threshold for 200K is 55%
		const raw = runStatusline({ context_window: { used_percentage: 60 } });
		assert.ok(raw.includes("\x1b[1;31mcompaction recommended"));
	});

	it("below threshold shows /cg:stats hint instead of compaction message", () => {
		const out = strip(
			runStatusline({ context_window: { used_percentage: 10 } }),
		);
		assert.ok(out.includes("/cg:stats for more"));
		assert.ok(!out.includes("compaction recommended"));
	});
});

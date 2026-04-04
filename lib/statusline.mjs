#!/usr/bin/env node
/**
 * Statusline renderer for Claude Code's terminal status bar.
 *
 * Reads JSON from stdin (piped by Claude Code) containing session stats,
 * outputs a compact context usage line. Zero context window cost.
 *
 * Auto-configured by the session-start hook.
 *
 * @module statusline
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	raw += chunk;
});
process.stdin.on("error", () => {
	process.stdout.write("Context: --");
});
process.stdin.on("end", () => {
	try {
		const data = JSON.parse(raw);
		process.stdout.write(render(data));
	} catch {
		process.stdout.write("Context: --");
	}
});

/**
 * Render the statusline output from Claude Code's session data.
 *
 * Claude Code pipes JSON with this structure:
 *   context_window: { used_percentage, remaining_percentage, total_input_tokens, total_output_tokens }
 *   model: { id, display_name }
 */
function render(data) {
	const pctRaw = data.context_window?.used_percentage;
	if (pctRaw == null) {
		const dim = "\x1b[2m";
		const reset = "\x1b[0m";
		return `${dim}Context usage: --${reset}`;
	}

	const pct = Math.round(pctRaw);

	// Read threshold from config if available, fallback to 35%
	const dataDir =
		process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "cg");
	let threshold = 35;
	try {
		const configPath = path.join(dataDir, "config.json");
		if (fs.existsSync(configPath)) {
			const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
			if (cfg.threshold) threshold = Math.round(cfg.threshold * 100);
		}
	} catch {}

	// Color strategy:
	// - Green: labels dim/grey, only numbers colored green
	// - Yellow: labels dim/grey, only numbers colored yellow
	// - Red: entire label+number is bold red (maximum visibility)
	const reset = "\x1b[0m";
	const dim = "\x1b[2m";

	let contextStr;
	if (pct >= threshold) {
		contextStr = `\x1b[1;31mContext usage: ${pct}%${reset}`;
	} else {
		const numColor = pct < threshold * 0.7 ? "\x1b[32m" : "\x1b[33m";
		contextStr = `${dim}Context usage:${reset} ${numColor}${pct}%${reset}`;
	}

	// Session size — proxy for the ~20MB API request limit (separate from token limit).
	// Read from the most recent state file written by submit/stop hooks.
	let sessionStr = `${dim}--${reset}`;
	try {
		const stateFiles = fs
			.readdirSync(dataDir)
			.filter((f) => f.startsWith("state-") && f.endsWith(".json"));
		if (stateFiles.length > 0) {
			// Pick the most recently modified state file
			let newest = stateFiles[0];
			let newestMtime = 0;
			for (const f of stateFiles) {
				const mt = fs.statSync(path.join(dataDir, f)).mtimeMs;
				if (mt > newestMtime) {
					newestMtime = mt;
					newest = f;
				}
			}
			const state = JSON.parse(
				fs.readFileSync(path.join(dataDir, newest), "utf8"),
			);
			// Total payload = transcript file + system overhead (prompts, tools, CLAUDE.md).
			// The transcript JSONL only contains conversation messages, not the full
			// API request. baseline_overhead (tokens) × 4 ≈ system overhead in bytes.
			const overheadBytes = (state.baseline_overhead || 0) * 4;
			const totalBytes = (state.payload_bytes || 0) + overheadBytes;
			if (totalBytes > 0) {
				const mb = Math.max(0.1, totalBytes / (1024 * 1024)).toFixed(1);
				if (mb >= 15) {
					sessionStr = `\x1b[1;31mSession size: ${mb}/20MB${reset}`;
				} else {
					const numColor = mb < 10 ? "\x1b[32m" : "\x1b[33m";
					sessionStr = `${dim}Session size:${reset} ${numColor}${mb}${dim}/20MB${reset}`;
				}
			}
		}
	} catch {}

	const untilAlert = Math.max(0, threshold - pct);
	const tail =
		untilAlert > 0
			? `${dim}/cg:stats for more${reset}`
			: `\x1b[1;31mcompaction recommended \u2014 /cg:compact${reset}`;

	return `${contextStr} ${dim}|${reset} ${sessionStr} ${dim}|${reset} ${tail}`;
}

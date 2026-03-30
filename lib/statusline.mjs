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
	let threshold = 35;
	try {
		const dataDir =
			process.env.CLAUDE_PLUGIN_DATA ||
			path.join(os.homedir(), ".claude", "cg");
		const configPath = path.join(dataDir, "config.json");
		if (fs.existsSync(configPath)) {
			const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
			if (cfg.threshold) threshold = Math.round(cfg.threshold * 100);
		}
	} catch {}

	const untilAlert = Math.max(0, threshold - pct);

	// Color: threshold-relative so colors match the user's configured threshold
	// Green = well below threshold, Yellow = approaching, Red = at/past threshold
	let color;
	if (pct < threshold * 0.7) color = "\x1b[32m";
	else if (pct < threshold) color = "\x1b[33m";
	else color = "\x1b[1;31m"; // bold red at threshold

	const reset = "\x1b[0m";
	const dim = "\x1b[2m";

	const alertStr =
		untilAlert > 0
			? `${dim}| ${untilAlert}% remaining until alert${reset}`
			: `\x1b[1;31m| compaction recommended \u2014 /cg:compact${reset}`;

	return `${color}Context usage: ${pct}%${reset} ${alertStr} ${dim}| /cg:stats for more${reset}`;
}

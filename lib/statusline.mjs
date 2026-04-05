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
		persistSessionMetadata(data);
		process.stdout.write(render(data));
	} catch {
		process.stdout.write("Context: --");
	}
});

/**
 * Persist authoritative session metadata from Claude Code's statusline JSON
 * into the per-session state file. The statusline is the only CG component
 * that receives these values directly from CC. Hooks read them from here.
 */
function persistSessionMetadata(data) {
	const size = data.context_window?.context_window_size;
	const modelId = data.model?.id;
	const sessionId = data.session_id;
	if (!sessionId || (typeof size !== "number" && !modelId)) return;
	try {
		const dir = path.join(os.homedir(), ".claude", "cg");
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `state-${sessionId}.json`);

		// Read-modify-write: merge CC-provided values into existing state.
		// Skip the write if nothing changed — minimises race window with hooks.
		let state = {};
		try {
			state = JSON.parse(fs.readFileSync(filePath, "utf8"));
		} catch {}

		let changed = false;
		if (
			typeof size === "number" &&
			size > 0 &&
			state.context_window_size !== size
		) {
			state.context_window_size = size;
			changed = true;
		}
		if (modelId && state.cc_model_id !== modelId) {
			state.cc_model_id = modelId;
			changed = true;
		}
		if (!changed) return;

		const rand = Math.random().toString(36).slice(2, 10);
		const tmp = `${filePath}.${process.pid}.${Date.now()}.${rand}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state));
		fs.renameSync(tmp, filePath);
	} catch {}
}

// ---------------------------------------------------------------------------
// Threshold resolution — adaptive based on context window size, with
// user-configured override. Same formula as computeAdaptiveThreshold in
// config.mjs: 55% at 200K, 30% at 1M, clamped [25%, 55%].
// ---------------------------------------------------------------------------
function resolveThreshold(data) {
	const dataDir =
		process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "cg");
	try {
		const configPath = path.join(dataDir, "config.json");
		if (fs.existsSync(configPath)) {
			const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
			if ("threshold" in cfg) return Math.round(cfg.threshold * 100);
		}
	} catch {}
	const windowSize = data.context_window?.context_window_size || 200000;
	const adaptive = Math.min(
		0.55,
		Math.max(0.25, 0.55 - ((windowSize - 200000) * 0.25) / 800000),
	);
	return Math.round(adaptive * 100);
}

// ---------------------------------------------------------------------------
// Session size — reads the most recent state file from the data dir to get
// payload_bytes and baseline_overhead for the ~20MB API limit display.
// ---------------------------------------------------------------------------
function readSessionSize(dataDir) {
	const stateFiles = fs
		.readdirSync(dataDir)
		.filter((f) => f.startsWith("state-") && f.endsWith(".json"));
	if (stateFiles.length === 0) return 0;

	let newest = stateFiles[0];
	let newestMtime = 0;
	for (const f of stateFiles) {
		const mt = fs.statSync(path.join(dataDir, f)).mtimeMs;
		if (mt > newestMtime) {
			newestMtime = mt;
			newest = f;
		}
	}
	const state = JSON.parse(fs.readFileSync(path.join(dataDir, newest), "utf8"));
	const overheadBytes = (state.baseline_overhead || 0) * 4;
	return (state.payload_bytes || 0) + overheadBytes;
}

// ---------------------------------------------------------------------------
// Color-coded session size string.
// ---------------------------------------------------------------------------
function formatSessionSize(totalBytes, dim, reset) {
	if (totalBytes <= 0) return `${dim}--${reset}`;
	const mb = Math.max(0.1, totalBytes / (1024 * 1024)).toFixed(1);
	if (mb >= 15) return `\x1b[1;31mSession size: ${mb}/20MB${reset}`;
	const numColor = mb < 10 ? "\x1b[32m" : "\x1b[33m";
	return `${dim}Session size:${reset} ${numColor}${mb}${dim}/20MB${reset}`;
}

/**
 * Render the statusline output from Claude Code's session data.
 */
function render(data) {
	const pctRaw = data.context_window?.used_percentage;
	if (pctRaw == null) {
		return "\x1b[2mContext usage: --\x1b[0m";
	}

	const pct = Math.round(pctRaw);
	const threshold = resolveThreshold(data);
	const reset = "\x1b[0m";
	const dim = "\x1b[2m";

	let contextStr;
	if (pct >= threshold) {
		contextStr = `\x1b[1;31mContext usage: ${pct}%${reset}`;
	} else {
		const numColor = pct < threshold * 0.7 ? "\x1b[32m" : "\x1b[33m";
		contextStr = `${dim}Context usage:${reset} ${numColor}${pct}%${reset}`;
	}

	const dataDir =
		process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "cg");
	let sessionStr = `${dim}--${reset}`;
	try {
		sessionStr = formatSessionSize(readSessionSize(dataDir), dim, reset);
	} catch {}

	const untilAlert = Math.max(0, threshold - pct);
	const tail =
		untilAlert > 0
			? `${dim}/cg:stats for more${reset}`
			: `\x1b[1;31mcompaction recommended \u2014 /cg:compact${reset}`;

	return `${contextStr} ${dim}|${reset} ${sessionStr} ${dim}|${reset} ${tail}`;
}

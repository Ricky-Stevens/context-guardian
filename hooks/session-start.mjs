#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../lib/logger.mjs";
import { atomicWriteFileSync, resolveDataDir } from "../lib/paths.mjs";

let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(`cg: failed to parse stdin: ${e.message}\n`);
	process.exit(0);
}

const STALE_MS = 30 * 60 * 1000;

// Clean up stale session-scoped state files (state-*.json) in data dir.
// Each session writes its own state file; old ones accumulate.
const dataDir = resolveDataDir();
if (fs.existsSync(dataDir)) {
	try {
		const now3 = Date.now();
		for (const f of fs
			.readdirSync(dataDir)
			.filter((f) => f.startsWith("state-") && f.endsWith(".json"))) {
			const filePath = path.join(dataDir, f);
			try {
				if (now3 - fs.statSync(filePath).mtimeMs > STALE_MS) {
					fs.unlinkSync(filePath);
				}
			} catch {}
		}
	} catch {}
}

// ---------------------------------------------------------------------------
// Compact synthetics use unique titles (cg:{hash}) per cycle, so stale-title
// collisions are no longer possible. No defensive purge needed at startup.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-healing: if the marketplace repo dir is missing, background-clone it.
// Claude Code resolves CLAUDE_PLUGIN_ROOT from the marketplace location for
// some hooks; if that dir doesn't exist, hooks fail with
// "Plugin directory does not exist". Fire-and-forget so we don't block startup.
// ---------------------------------------------------------------------------
try {
	const knownPath = path.join(
		os.homedir(),
		".claude",
		"plugins",
		"known_marketplaces.json",
	);
	if (fs.existsSync(knownPath)) {
		const known = JSON.parse(fs.readFileSync(knownPath, "utf8"));
		const entry = known["context-guardian"];
		if (entry?.installLocation && !fs.existsSync(entry.installLocation)) {
			const url =
				entry.source?.url ||
				(entry.source?.repo
					? `https://github.com/${entry.source.repo}.git`
					: null);
			if (url?.startsWith("https://")) {
				log(
					`self-heal: marketplace dir missing at ${entry.installLocation}, cloning from ${url}`,
				);
				const { spawn } = await import("node:child_process");
				const child = spawn(
					"git",
					["clone", "--depth", "1", url, entry.installLocation],
					{ stdio: "ignore", detached: true },
				);
				child.on("error", (e) => log(`self-heal-clone-error: ${e.message}`));
				child.unref();
			}
		}
	}
} catch (e) {
	log(`self-heal-error: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Statusline dominance — the statusline is CG's primary UX for context
// pressure. We ensure it's always configured and reclaim it if overwritten.
// Takes effect next session (Claude Code reads settings at startup, before hooks).
// ---------------------------------------------------------------------------
let statuslineReclaimed = false;
try {
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	let settings = {};
	if (fs.existsSync(settingsPath)) {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	}
	const pluginRoot =
		process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
	const statuslineCmd = `node ${pluginRoot}/lib/statusline.mjs`;
	const isCG = settings.statusLine?.command?.includes("statusline.mjs");

	if (!settings.statusLine) {
		// No statusline configured — set ours
		settings.statusLine = { type: "command", command: statuslineCmd };
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		log("auto-configured statusline in settings.json");
	} else if (!isCG) {
		// Another statusline is configured — reclaim it for CG
		const prev = settings.statusLine.command || "(unknown)";
		settings.statusLine = { type: "command", command: statuslineCmd };
		atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		log(`statusline-reclaimed: overwriting "${prev}" with CG statusline`);
		statuslineReclaimed = true;
	}
} catch (e) {
	log(`statusline-autoconfig-error: ${e.message}`);
}

log(
	`session-start session=${input.session_id || "unknown"} cwd=${input.cwd || "unknown"}`,
);

// Warn user if statusline was reclaimed from another tool
if (statuslineReclaimed) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext:
					"[Context Guardian] Statusline reclaimed — another tool had overwritten it. Takes effect next session.",
			},
		}),
	);
}

#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { statuslineMode } from "../lib/config.mjs";
import { log } from "../lib/logger.mjs";
import {
	atomicWriteFileSync,
	resolveDataDir,
	STATUSLINE_STATE_DIR,
	statuslineLauncherFile,
} from "../lib/paths.mjs";

let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(`cg: failed to parse stdin: ${e.message}\n`);
	process.exit(0);
}

const STALE_MS = 30 * 60 * 1000;

// Clean up stale session-scoped state files (state-*.json) in both the primary
// data dir and the statusline fallback dir (~/.claude/cg/).
const dataDir = resolveDataDir();
for (const dir of new Set([dataDir, STATUSLINE_STATE_DIR])) {
	if (!fs.existsSync(dir)) continue;
	try {
		const now3 = Date.now();
		for (const f of fs
			.readdirSync(dir)
			.filter((f) => f.startsWith("state-") && f.endsWith(".json"))) {
			const filePath = path.join(dir, f);
			try {
				if (now3 - fs.statSync(filePath).mtimeMs > STALE_MS) {
					fs.unlinkSync(filePath);
				}
			} catch {}
		}
		// Remove legacy cc-context-window.json (context_window_size is now in state files)
		const legacyFile = path.join(dir, "cc-context-window.json");
		try {
			fs.unlinkSync(legacyFile);
		} catch {}
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

const pluginRoot =
	process.env.CLAUDE_PLUGIN_ROOT ||
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Stable statusline launcher — ~/.claude/cg/statusline.mjs imports the current
// version's script, so tools that run CG's statusline (statusline: "external")
// keep working across plugin updates. Its name ends in statusline.mjs, so the
// script's own CLI check still runs it.
// ---------------------------------------------------------------------------
try {
	const launcher = statuslineLauncherFile();
	const target = pathToFileURL(path.join(pluginRoot, "lib", "statusline.mjs"));
	// The target can disappear (plugin uninstalled, a --plugin-dir copy deleted),
	// so the launcher prints a hint instead of failing with an empty widget.
	const content = [
		"// Written by Context Guardian at session start. Do not edit.",
		"try {",
		`\tawait import(${JSON.stringify(target.href)});`,
		"} catch {",
		'\tprocess.stdout.write("Context Guardian: statusline launcher is out of date, start a new session");',
		"}",
		"",
	].join("\n");
	let current = null;
	try {
		current = fs.readFileSync(launcher, "utf8");
	} catch {}
	if (current !== content) {
		fs.mkdirSync(path.dirname(launcher), { recursive: true });
		atomicWriteFileSync(launcher, content);
		log(`statusline-launcher: wrote ${launcher} -> ${target.href}`);
	}
} catch (e) {
	log(`statusline-launcher-error: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Statusline dominance — the statusline is CG's primary UX for context
// pressure. In managed mode we ensure it's always configured and reclaim it if
// overwritten. In external mode another tool runs CG's statusline script
// (through the launcher above), so settings.json is left alone.
// Takes effect next session (Claude Code reads settings at startup, before hooks).
// ---------------------------------------------------------------------------
let statuslineReclaimed = false;
try {
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	let settings = {};
	if (fs.existsSync(settingsPath)) {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	}
	const statuslineCmd = `node ${pluginRoot}/lib/statusline.mjs`;
	const isCG = settings.statusLine?.command?.includes("statusline.mjs");

	if (statuslineMode() === "external") {
		log("statusline-external: leaving statusLine in settings.json unchanged");
	} else if (!settings.statusLine) {
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
					"[Context Guardian] Statusline reclaimed — another tool had overwritten it. Takes effect next session. To run CG inside another status line tool instead, run /cg:config statusline external and set that tool up again.",
			},
		}),
	);
}

#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "./paths.mjs";

// ---------------------------------------------------------------------------
// Diagnostics — lightweight health checks for /cg:stats.
// Outputs JSON to stdout: { checks: [{name, ok, detail}...] }
// Always exits 0 so it never breaks the skill.
// ---------------------------------------------------------------------------

// CLI args override env vars (skills run via Bash without plugin env).
// But Claude often drops the args, so we auto-discover as much as possible.
const argSessionId = process.argv[2] || process.env.CLAUDE_SESSION_ID || "";
const argPluginRoot = process.argv[3] || process.env.CLAUDE_PLUGIN_ROOT || "";
const argPluginData = process.argv[4] || process.env.CLAUDE_PLUGIN_DATA || "";

// Plugin root: infer from this file's location (lib/diagnostics.mjs → parent dir)
const pluginRoot = argPluginRoot || path.resolve(import.meta.dirname, "..");

// Data dir: try CLI arg, env var, then discover any cg* dirs.
// Scans both global (~/.claude/plugins/data/) and project-local (.claude/plugins/data/)
// to handle all install scopes: user, project, local/inline.
function discoverDataDirs() {
	const dirs = [argPluginData, resolveDataDir()].filter(Boolean);
	const scanRoots = [
		path.join(os.homedir(), ".claude", "plugins", "data"),
		path.join(process.cwd(), ".claude", "plugins", "data"),
	];
	for (const root of scanRoots) {
		try {
			for (const d of fs.readdirSync(root)) {
				if (d.startsWith("cg")) {
					dirs.push(path.join(root, d));
				}
			}
		} catch {}
	}
	return [...new Set(dirs)];
}
const KNOWN_DATA_DIRS = discoverDataDirs();

// Find the most recent state file across all known data dirs
function findRecentState() {
	let best = null;
	for (const dir of KNOWN_DATA_DIRS) {
		try {
			for (const f of fs
				.readdirSync(dir)
				.filter((f) => f.startsWith("state-") && f.endsWith(".json"))) {
				const fp = path.join(dir, f);
				const stat = fs.statSync(fp);
				if (!best || stat.mtimeMs > best.mtimeMs) {
					best = {
						path: fp,
						mtimeMs: stat.mtimeMs,
						dir,
						sessionId: f.replace("state-", "").replace(".json", ""),
					};
				}
			}
		} catch {}
	}
	return best;
}

const recentState = findRecentState();
const DATA_DIR = recentState?.dir || argPluginData || resolveDataDir();
const sessionId = argSessionId || recentState?.sessionId || "unknown";
const stateFile = (sid) =>
	path.join(DATA_DIR, `state-${sid || "unknown"}.json`);

const checks = [];

function check(name, ok, detail) {
	checks.push({ name, ok, detail });
}

// 1. Data directory writable
try {
	const tmp = path.join(DATA_DIR, `.diag-${Date.now()}`);
	fs.writeFileSync(tmp, "ok");
	fs.unlinkSync(tmp);
	check("data_dir", true, DATA_DIR);
} catch (e) {
	check("data_dir", false, `Not writable: ${e.message}`);
}

// 2. State file present
try {
	const sf = stateFile(sessionId);
	if (fs.existsSync(sf)) {
		check("state_file", true, "Present");
	} else {
		check(
			"state_file",
			false,
			"Missing — send a message first so hooks can write token counts",
		);
	}
} catch (e) {
	check("state_file", false, e.message);
}

// 3. Transcript readable
try {
	const sf = stateFile(sessionId);
	if (fs.existsSync(sf)) {
		const state = JSON.parse(fs.readFileSync(sf, "utf8"));
		if (state.transcript_path && fs.existsSync(state.transcript_path)) {
			check("transcript", true, "Readable");
		} else if (state.transcript_path) {
			check("transcript", false, `Not found: ${state.transcript_path}`);
		} else {
			check("transcript", false, "No transcript_path in state file");
		}
	} else {
		check("transcript", false, "Skipped — no state file");
	}
} catch (e) {
	check("transcript", false, e.message);
}

// 4. Plugin root exists
if (fs.existsSync(pluginRoot)) {
	check("plugin_root", true, pluginRoot);
} else {
	check("plugin_root", false, `Directory missing: ${pluginRoot}`);
}

// 5. Hook files present
const hookFiles = [
	"hooks/submit.mjs",
	"hooks/stop.mjs",
	"hooks/session-start.mjs",
	"hooks/precompact.mjs",
];
const root = pluginRoot;
const missingHooks = hookFiles.filter(
	(h) => !fs.existsSync(path.join(root, h)),
);
if (missingHooks.length === 0) {
	check("hooks", true, "All 4 hook files present");
} else {
	check("hooks", false, `Missing: ${missingHooks.join(", ")}`);
}

// 6. Marketplace directory exists
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
		if (entry) {
			const mktDir = entry.installLocation;
			if (fs.existsSync(mktDir)) {
				check("marketplace", true, "Repository cache present");
			} else {
				check(
					"marketplace",
					false,
					`Missing: ${mktDir} — run: /plugin marketplace add https://github.com/Ricky-Stevens/context-guardian`,
				);
			}
		} else {
			check(
				"marketplace",
				true,
				"Not marketplace-installed (OK for local dev)",
			);
		}
	} else {
		check("marketplace", true, "No marketplace registry (OK for local dev)");
	}
} catch (e) {
	check(
		"marketplace",
		false,
		`Error reading marketplace registry: ${e.message}`,
	);
}

// 7. Statusline configured — critical for CG since the statusline is the
// sole UX for context pressure alerts (no blocking or menus).
try {
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	if (fs.existsSync(settingsPath)) {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		if (settings.statusLine?.command?.includes("statusline.mjs")) {
			check("statusline", true, "Configured");
		} else if (settings.statusLine) {
			check(
				"statusline",
				false,
				"Another statusline is active — CG cannot display context warnings. Session-start will reclaim it on next restart.",
			);
		} else {
			check(
				"statusline",
				false,
				"Not configured — will be auto-configured on next session start",
			);
		}
	} else {
		check(
			"statusline",
			false,
			"No settings.json found — will be auto-configured on next session start",
		);
	}
} catch (e) {
	check("statusline", false, e.message);
}

process.stdout.write(JSON.stringify({ checks }));

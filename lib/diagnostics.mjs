#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, stateFile } from "./paths.mjs";

// ---------------------------------------------------------------------------
// Diagnostics — lightweight health checks for /cg:stats.
// Outputs JSON to stdout: { checks: [{name, ok, detail}...] }
// Always exits 0 so it never breaks the skill.
// ---------------------------------------------------------------------------

const sessionId = process.env.CLAUDE_SESSION_ID || "unknown";
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || "";
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
		check("state_file", false, "Missing — send a message first so hooks can write token counts");
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
if (pluginRoot) {
	if (fs.existsSync(pluginRoot)) {
		check("plugin_root", true, pluginRoot);
	} else {
		check("plugin_root", false, `Directory missing: ${pluginRoot}`);
	}
} else {
	check("plugin_root", false, "CLAUDE_PLUGIN_ROOT not set (running outside plugin context?)");
}

// 5. Hook files present
const hookFiles = ["hooks/submit.mjs", "hooks/stop.mjs", "hooks/session-start.mjs"];
const root = pluginRoot || path.resolve(import.meta.dirname, "..");
const missingHooks = hookFiles.filter(
	(h) => !fs.existsSync(path.join(root, h)),
);
if (missingHooks.length === 0) {
	check("hooks", true, "All 3 hook files present");
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
			check("marketplace", true, "Not marketplace-installed (OK for local dev)");
		}
	} else {
		check("marketplace", true, "No marketplace registry (OK for local dev)");
	}
} catch (e) {
	check("marketplace", false, `Error reading marketplace registry: ${e.message}`);
}

process.stdout.write(JSON.stringify({ checks }));

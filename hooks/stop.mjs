#!/usr/bin/env node
import fs from "node:fs";
import { log } from "../lib/logger.mjs";

// ---------------------------------------------------------------------------
// Stop hook — logs session end. Token state is written by the submit hook
// (via getTokenUsage reading the transcript) since the Stop hook input
// does not include the context_window or usage fields needed for tracking.
// ---------------------------------------------------------------------------
let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(
		`context-guardian: failed to parse stdin: ${e.message}\n`,
	);
	process.exit(0);
}

log(`STOP session=${input.session_id || "unknown"}`);

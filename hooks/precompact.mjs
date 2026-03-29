#!/usr/bin/env node
/**
 * PreCompact hook — safety net for native auto-compaction.
 *
 * When Claude Code's built-in compaction fires (auto or manual /compact),
 * this hook runs CG's deterministic extraction and injects it as
 * additionalContext. The native compaction model then works with pre-cleaned
 * input, producing a better summary than it would from the raw transcript.
 *
 * This is a silent safety net — no user-facing output.
 *
 * @module precompact-hook
 */
import fs from "node:fs";
import { log } from "../lib/logger.mjs";
import { extractConversation } from "../lib/transcript.mjs";

let input;
try {
	input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
	process.stderr.write(`cg: precompact parse error: ${e.message}\n`);
	process.exit(0);
}

const { session_id = "unknown", transcript_path, trigger = "unknown" } = input;
log(`PRECOMPACT session=${session_id} trigger=${trigger}`);

if (!transcript_path || !fs.existsSync(transcript_path)) {
	log(`precompact-skip: no transcript`);
	process.exit(0);
}

try {
	const extraction = extractConversation(transcript_path);

	if (!extraction || extraction === "(no transcript available)") {
		log(`precompact-skip: empty extraction`);
		process.exit(0);
	}

	// Inject the extraction as context for the compaction model.
	// Limit to 50K chars to avoid overwhelming the compaction prompt.
	const MAX_INJECT = 50000;
	const trimmed =
		extraction.length > MAX_INJECT
			? `${extraction.slice(0, MAX_INJECT)}\n\n[...extraction truncated at ${MAX_INJECT} chars for compaction input...]`
			: extraction;

	const output = {
		hookSpecificOutput: {
			hookEventName: "PreCompact",
			additionalContext: [
				"[Context Guardian — Pre-Compaction Extraction]",
				"The following is a high-fidelity deterministic extraction of the conversation.",
				"Tool outputs that can be re-obtained (file reads, search results) have been stripped.",
				"All user messages, assistant reasoning, code changes, and command outputs are preserved.",
				"Use this extraction as the primary basis for your compaction summary — preserve its content verbatim where possible.",
				"",
				trimmed,
			].join("\n"),
		},
	};

	process.stdout.write(JSON.stringify(output));
	log(
		`precompact-injected session=${session_id} chars=${extraction.length} injected=${trimmed.length}`,
	);
} catch (e) {
	log(`precompact-error: ${e.message}`);
	// Fail silently — don't block compaction
	process.exit(0);
}

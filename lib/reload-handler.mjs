/**
 * Checkpoint reload and resume handlers for Context Guardian.
 *
 * Manages the post-/clear checkpoint injection flow:
 * - Reload: inject a previously saved checkpoint into the new session
 * - Resume: replay the user's original prompt after checkpoint restoration
 *
 * @module reload-handler
 */

import fs from "node:fs";
import { writeCompactionState } from "./checkpoint.mjs";
import { resolveMaxTokens } from "./config.mjs";
import { log } from "./logger.mjs";
import { ensureDataDir } from "./paths.mjs";

// ---------------------------------------------------------------------------
// Injection framing text
// ---------------------------------------------------------------------------

/**
 * The preserved-record framing for checkpoint injection.
 * Uses "preserved record" language (NOT "summary") to prime the LLM
 * to treat checkpoint content as authoritative and exact.
 */
const INJECTION_FRAMING =
	"The following is a preserved record of the prior conversation with noise removed. " +
	"Tool outputs that can be re-obtained (file reads, search results) were stripped. " +
	"All user messages, assistant reasoning, code changes, and command outputs are preserved verbatim. " +
	"This is a chronological record — the LAST actions and decisions reflect the current state. " +
	"Do not re-address issues already resolved in this history. " +
	"You have NOT read any files in this session — re-read any file before referencing its contents or making further edits.";

// ---------------------------------------------------------------------------
// Resume detection
// ---------------------------------------------------------------------------

/**
 * Handle the "resume" command — replay the user's original prompt after
 * a checkpoint restore.
 *
 * @param {string} prompt - The user's input
 * @param {string} sessionId - Current session ID
 * @param {object} pState - Project state file paths
 * @param {function} output - Output function
 * @returns {boolean} True if handled (caller should exit), false otherwise
 */
export function handleResume(prompt, sessionId, pState, output) {
	if (!fs.existsSync(pState.resume)) return false;

	const resumeInput = (prompt || "").trim().toLowerCase();
	if (resumeInput !== "resume") return false;

	try {
		const resumeData = JSON.parse(fs.readFileSync(pState.resume, "utf8"));
		fs.unlinkSync(pState.resume);

		if (
			resumeData.original_prompt &&
			Date.now() - resumeData.ts < 2 * 60 * 1000
		) {
			log(
				`resume-replay session=${sessionId} prompt="${resumeData.original_prompt.slice(0, 50)}"`,
			);
			output({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: `The user typed "resume" to continue from where they left off before context compaction.\n\n<original_request>\n${resumeData.original_prompt}\n</original_request>\n\nTreat the above <original_request> as if the user just typed it. Respond to it now.`,
				},
			});
			return true;
		}

		// Expired or no prompt
		const ts = resumeData.ts || 0;
		const ageStr =
			ts > 0
				? `${Math.round((Date.now() - ts) / 60000)} minutes old`
				: "of unknown age";
		log(`resume-expired session=${sessionId} age=${ageStr}`);
		output({
			decision: "block",
			reason: `Resume expired — the saved prompt is ${ageStr} (limit: 2 minutes). Your original message has been discarded. Please retype your request.`,
		});
		return true;
	} catch (e) {
		log(`resume-error: ${e.message}`);
		output({
			decision: "block",
			reason: `Resume failed — the saved prompt data was corrupted. Please retype your request.`,
		});
		return true;
	}
}

// ---------------------------------------------------------------------------
// Reload injection
// ---------------------------------------------------------------------------

/**
 * Format the stats line for checkpoint restoration display.
 *
 * @param {object} stats - The compaction stats object
 * @returns {string} Formatted stats line (may be empty)
 */
function formatReloadStats(stats) {
	if (!stats) return "";
	return (
		`\n\nCompaction Stats\n` +
		`   Before:  ${stats.preTokens.toLocaleString()} tokens (~${stats.prePct}% of context)\n` +
		`   After:   ~${stats.postTokens.toLocaleString()} tokens (~${stats.postPct}% of context)\n` +
		`   Saved:   ~${stats.saved.toLocaleString()} tokens (${stats.savedPct}% reduction)`
	);
}

/**
 * Handle checkpoint reload — inject a previously saved checkpoint into
 * the new session after /clear.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The user's input
 * @param {string} opts.sessionId - Current session ID
 * @param {string} opts.transcriptPath - Path to the transcript
 * @param {object} opts.pState - Project state file paths
 * @param {object} opts.flags - Session flag paths
 * @param {function} opts.output - Output function
 * @returns {boolean} True if handled (caller should exit), false to continue
 */
export function handleReload(opts) {
	const { prompt, sessionId, transcriptPath, pState, flags, output } = opts;

	if (!fs.existsSync(pState.reload)) return false;

	try {
		const reload = JSON.parse(fs.readFileSync(pState.reload, "utf8"));

		// Expired (>10 min)
		if (Date.now() - reload.ts >= 10 * 60 * 1000) {
			fs.unlinkSync(pState.reload);
			log(`reload-expired session=${sessionId}`);
			return false;
		}

		// Same session — user hasn't /cleared yet
		if (reload.created_session === sessionId) {
			return handleSameSession(sessionId, pState, flags, output);
		}

		// Fresh session — inject the checkpoint
		return injectCheckpoint(
			reload,
			prompt,
			sessionId,
			transcriptPath,
			pState,
			output,
		);
	} catch (e) {
		try {
			fs.unlinkSync(pState.reload);
		} catch {}
		log(`reload-error: ${e.message}`);
		return false;
	}
}

/**
 * Handle reload when still in the same session that created the compaction.
 * Shows a one-time reminder to /clear.
 */
function handleSameSession(sessionId, _pState, flags, output) {
	log(
		`reload-skip session=${sessionId} — same session that created the compaction`,
	);
	if (!fs.existsSync(flags.clearReminded)) {
		fs.mkdirSync(flags.dir, { recursive: true });
		fs.writeFileSync(flags.clearReminded, "1");
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext:
					"[Context Guardian] A compaction checkpoint is ready but hasn't been applied. " +
					"Remind the user: type /clear to apply it, or continue working to dismiss. " +
					"The checkpoint expires in 10 minutes. Process the user's message normally.",
			},
		});
		return true;
	}
	return false;
}

/**
 * Inject a checkpoint into a fresh session after /clear.
 */
function injectCheckpoint(
	reload,
	prompt,
	sessionId,
	transcriptPath,
	pState,
	output,
) {
	if (!fs.existsSync(reload.checkpoint_path)) {
		log(
			`reload-error session=${sessionId} — checkpoint file missing: ${reload.checkpoint_path}`,
		);
		fs.unlinkSync(pState.reload);
		output({
			decision: "block",
			reason: `Context Guardian: checkpoint file was deleted before it could be restored. Your compacted context has been lost. Please continue with a fresh session.`,
		});
		return true;
	}

	const checkpoint = fs.readFileSync(reload.checkpoint_path, "utf8");
	fs.unlinkSync(pState.reload);
	try {
		fs.unlinkSync(pState.cooldown);
	} catch {}

	const reloadStatsLine = formatReloadStats(reload.stats);
	const isResumeNow = (prompt || "").trim().toLowerCase() === "resume";
	const hasOriginal = !!reload.original_prompt;
	const restoreMarker =
		reload.mode === "recent"
			? "[KEEP RECENT — restored checkpoint]"
			: "[SMART COMPACT — restored checkpoint]";

	const historyBlock = `${restoreMarker}\n\n<prior_conversation_history>\n${INJECTION_FRAMING}\n\n${checkpoint}\n</prior_conversation_history>\n\n---${reloadStatsLine}`;

	if (isResumeNow && hasOriginal) {
		log(
			`reload-resume-immediate session=${sessionId} prompt="${reload.original_prompt.slice(0, 50)}"`,
		);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext:
					`${historyBlock}\n\n` +
					`The user typed "resume" after /clear. Context has been restored.\n\n<original_request>\n${reload.original_prompt}\n</original_request>\n\nTreat the above <original_request> as if the user just typed it. Respond to it now.`,
			},
		});
	} else {
		if (hasOriginal) {
			ensureDataDir();
			fs.writeFileSync(
				pState.resume,
				JSON.stringify({
					original_prompt: reload.original_prompt,
					ts: Date.now(),
				}),
			);
		}
		const resumeHint = hasOriginal
			? `\n\nTell the user: "Type **resume** to continue where you left off — your previous prompt will be replayed automatically."`
			: "";
		log(
			`reload-inject session=${sessionId} checkpoint=${reload.checkpoint_path}`,
		);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `${historyBlock}\n\nThe user cleared context and this checkpoint was auto-restored. Show the compaction stats above so they can see the savings.${resumeHint}`,
			},
		});
	}

	// Write state for /context-guardian:status
	const rlTokens =
		reload.stats?.postTokens || Math.round(checkpoint.length / 4);
	const rlMax = reload.stats?.maxTokens || resolveMaxTokens() || 200000;
	writeCompactionState(
		sessionId,
		transcriptPath,
		rlTokens,
		rlMax,
		"Context restored from checkpoint.",
	);
	return true;
}

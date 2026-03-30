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
	"IMPORTANT: The following is a preserved record of the prior conversation. " +
	"This is NOT a summary — it is a verbatim extraction with re-obtainable noise (file reads, search results) stripped. " +
	"All user messages, decisions, code changes, command outputs, and errors are preserved exactly.\n\n" +
	"HOW TO USE THIS RECORD:\n" +
	"1. You have NOT read any files in this session — re-read any file before referencing its contents or making edits.\n" +
	"2. The '## Conversation Index' at the top is your reference map. ALWAYS check it first when answering questions about the session.\n" +
	"3. Exchange numbers [N] in the index correspond to exchanges in the chronological body below.\n" +
	"4. If the index mentions a fact, it IS in the full record — scan the body at that exchange number for details.\n" +
	"5. The LAST exchanges reflect the current state. Earlier exchanges are context.\n" +
	"6. Do not re-address issues already resolved in this history.";

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
	try {
		fs.mkdirSync(flags.dir, { recursive: true });
		fs.writeFileSync(flags.clearReminded, "1", { flag: "ax" });
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext:
					"IMPORTANT — A compaction checkpoint is ready to be applied. " +
					"Inform the user: 'Type /clear to apply the checkpoint, or continue working to dismiss it (expires in 10 minutes).'\n\n" +
					"Process the user's message after delivering this notice.",
			},
		});
		return true;
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
		// Another instance already wrote the reminder — skip
	}
	return false;
}

/**
 * Extract the conversation index from a checkpoint.
 *
 * The checkpoint has: ## Session State → ## Conversation Index → --- → [1] body.
 * We extract everything before the chronological body (the first `\n[1]` or
 * the `---` separator after the index), giving Claude the high-signal preamble
 * as guaranteed `additionalContext`.
 *
 * @param {string} checkpoint - Full checkpoint content
 * @returns {string} The index portion (Session State + Conversation Index)
 */
function extractIndex(checkpoint) {
	// Look for the start of the chronological body — first exchange marker
	const bodyStart = checkpoint.indexOf("\n[1]");
	if (bodyStart > 0) {
		// Include everything up to the body, trim trailing separators
		return checkpoint
			.slice(0, bodyStart)
			.replace(/\n---\s*$/, "")
			.trim();
	}
	// Fallback: take the first 5000 chars if no body marker found
	return checkpoint.slice(0, 5000).trim();
}

/**
 * Inject a checkpoint into a fresh session after /clear.
 *
 * Uses a hybrid approach for best quality:
 * 1. Conversation Index injected as additionalContext (guaranteed baseline)
 * 2. Read instruction for the full checkpoint file (high-attention tool result)
 *
 * If Claude reads the file: full quality restore (~42/47).
 * If Claude skips the Read: index provides key facts (~25-30/47).
 * If both fail: user can run /cg:resume all (hint shown by compact/prune skills).
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
			reason: `Context Guardian: checkpoint file was deleted before it could be restored. Your compacted context has been lost. Please continue with a fresh session, or try /cg:resume all to find other checkpoints.`,
		});
		return true;
	}

	const checkpoint = fs.readFileSync(reload.checkpoint_path, "utf8");
	fs.unlinkSync(pState.reload);

	const reloadStatsLine = formatReloadStats(reload.stats);
	const isResumeNow = (prompt || "").trim().toLowerCase() === "resume";
	const hasOriginal = !!reload.original_prompt;
	const restoreMarker =
		reload.mode === "recent"
			? "[KEEP RECENT — restored checkpoint]"
			: "[SMART COMPACT — restored checkpoint]";

	// Extract the conversation index for guaranteed baseline context
	const index = extractIndex(checkpoint);

	// Build the hybrid injection: index (guaranteed) + Read instruction (high quality)
	const indexBlock =
		`${restoreMarker}\n\n` +
		`<conversation_index>\n${INJECTION_FRAMING}\n\n${index}\n</conversation_index>` +
		`${reloadStatsLine}`;

	const readInstruction =
		`\n\nIMPORTANT — RESTORE FULL CONTEXT: The index above is a reference map only — ` +
		`it IS INCOMPLETE without the full file.\n\n` +
		`The full session history is in this file:\n\n` +
		`${reload.checkpoint_path}\n\n` +
		`You MUST Read that file now before responding. The index references exchanges by number, ` +
		`but you have NOT yet seen the actual conversation content. ` +
		`The file contains all decisions, code changes, and reasoning needed to continue this work.`;

	if (isResumeNow && hasOriginal) {
		log(
			`reload-resume-immediate session=${sessionId} prompt="${reload.original_prompt.slice(0, 50)}"`,
		);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext:
					`${indexBlock}${readInstruction}\n\n` +
					`After reading the file, the user's original request was:\n\n` +
					`<original_request>\n${reload.original_prompt}\n</original_request>\n\n` +
					`Respond to the original request using the restored context.`,
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
			? `\n\nAfter confirming the restore, tell the user: "Type **resume** to continue where you left off — your previous prompt will be replayed automatically."`
			: "";
		log(
			`reload-inject session=${sessionId} checkpoint=${reload.checkpoint_path}`,
		);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext:
					`${indexBlock}${readInstruction}\n\n` +
					`After reading the file, confirm the restore by showing the compaction stats and saying context has been restored.${resumeHint}`,
			},
		});
	}

	// Write state for /cg:stats
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

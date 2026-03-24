#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { log } from "../lib/logger.mjs";
import {
	CHECKPOINTS_DIR,
	ensureDataDir,
	projectStateFiles,
	rotateCheckpoints,
	sessionFlags,
	stateFile,
} from "../lib/paths.mjs";
import { formatCompactionStats } from "../lib/stats.mjs";
import { estimateTokens, getTokenUsage } from "../lib/tokens.mjs";
import { extractConversation, extractRecent } from "../lib/transcript.mjs";

// ---------------------------------------------------------------------------
// Input
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
const { session_id = "unknown", prompt, transcript_path } = input;

const flags = sessionFlags(input.cwd, session_id);
const pState = projectStateFiles(input.cwd);

function output(obj) {
	process.stdout.write(JSON.stringify(obj));
}

/** Check if extracted content has actual conversation data, not just headers/empty. */
function hasExtractedContent(text) {
	return (
		text &&
		text !== "(no transcript available)" &&
		text.length > 50 &&
		(text.includes("**User:**") || text.includes("**Assistant:**"))
	);
}

/**
 * Cap checkpoint content to prevent oversized additionalContext injections.
 * Limits to ~25% of context window (maxChars ≈ max_tokens, since 1 token ≈ 4 chars).
 * Trims at the nearest message boundary to avoid cutting mid-sentence.
 */
function capCheckpointContent(content, maxTokens) {
	const maxChars = Math.max(20000, maxTokens || 200000);
	if (content.length <= maxChars) return content;
	const truncated = content.slice(0, maxChars);
	const lastSep = truncated.lastIndexOf("\n\n---\n\n");
	const cutPoint = lastSep > maxChars * 0.5 ? lastSep : maxChars;
	log(
		`checkpoint-truncated original=${content.length} capped=${cutPoint} max=${maxChars}`,
	);
	return (
		truncated.slice(0, cutPoint) +
		"\n\n> [Checkpoint truncated — oldest messages removed to fit within context window limits]"
	);
}

// ---------------------------------------------------------------------------
// Helper — write state file with post-compaction estimates
// ---------------------------------------------------------------------------
function writeCompactionState(tokens, max, rec) {
	try {
		const c = loadConfig();
		const th = c.threshold ?? 0.35;
		const p = tokens / max;
		ensureDataDir();
		fs.writeFileSync(
			stateFile(session_id),
			JSON.stringify({
				current_tokens: tokens,
				max_tokens: max,
				pct: p,
				pct_display: (p * 100).toFixed(1),
				threshold: th,
				threshold_display: Math.round(th * 100),
				headroom: Math.max(0, Math.round(max * th - tokens)),
				recommendation: rec,
				source: "estimated",
				model: "unknown",
				session_id,
				transcript_path,
				ts: Date.now(),
			}),
		);
	} catch {}
}

// ---------------------------------------------------------------------------
// Handle manual compact — direct skill command OR legacy flag file
// ---------------------------------------------------------------------------
let cMode = null;
if (fs.existsSync(flags.compactMenu)) {
	cMode = (fs.readFileSync(flags.compactMenu, "utf8") || "").trim();
	fs.unlinkSync(flags.compactMenu);
} else {
	const p = (prompt || "").trim().toLowerCase();
	if (p.startsWith("/context-guardian:compact")) cMode = "smart";
	else if (p.startsWith("/context-guardian:prune")) cMode = "recent";
}

if (cMode) {

	if (cMode !== "smart" && cMode !== "recent") {
		log(`manual-compact-invalid-mode mode="${cMode}" session=${session_id}`);
		output({
			decision: "block",
			reason:
				"Context Guardian: invalid compaction mode. Use /context-guardian:compact or /context-guardian:prune.",
		});
		process.exit(0);
	}

	const cLabel = cMode === "smart" ? "Smart Compact" : "Keep Recent 20";
	log(`manual-compact mode=${cMode} session=${session_id}`);

	ensureDataDir();
	fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
	const cStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const cExportFile = path.join(
		CHECKPOINTS_DIR,
		`session-${cStamp}-${session_id.slice(0, 8)}.md`,
	);

	const cMaxTokens =
		getTokenUsage(transcript_path)?.max_tokens || resolveMaxTokens() || 200000;
	let cContent =
		cMode === "smart"
			? extractConversation(transcript_path)
			: extractRecent(transcript_path, 20);
	cContent = capCheckpointContent(cContent, cMaxTokens);

	if (!hasExtractedContent(cContent)) {
		log(`manual-compact-empty mode=${cMode} session=${session_id}`);
		output({
			decision: "block",
			reason: `Context Guardian could not extract meaningful conversation content. Your session may consist primarily of tool interactions with minimal text. Try ${cMode === "smart" ? "/context-guardian:prune" : "/context-guardian:compact"} instead, or continue working.`,
		});
		process.exit(0);
	}

	fs.writeFileSync(
		cExportFile,
		`# Context Checkpoint (${cLabel})\n> Created: ${new Date().toISOString()}\n\n${cContent}`,
	);

	// Get current token counts for stats
	const cUsage = getTokenUsage(transcript_path);
	const cPreTokens = cUsage
		? cUsage.current_tokens
		: estimateTokens(transcript_path);
	const cPreMax = cUsage?.max_tokens || resolveMaxTokens();
	const cFull = fs.readFileSync(cExportFile, "utf8");
	const { stats: cStats, block: cStatsBlock } = formatCompactionStats(
		cPreTokens,
		cPreMax,
		cFull,
		{ hasOriginalPrompt: false },
	);

	// Write reload flag (no original_prompt — manual compact, not blocking a message)
	fs.writeFileSync(
		pState.reload,
		JSON.stringify({
			checkpoint_path: cExportFile,
			original_prompt: "",
			ts: Date.now(),
			stats: cStats,
			mode: cMode,
			created_session: session_id,
		}),
	);

	log(
		`manual-compact-saved mode=${cMode} file=${cExportFile} pre=${cPreTokens} post=${cStats.postTokens} saved=${cStats.saved}`,
	);
	rotateCheckpoints();

	output({
		decision: "block",
		reason: cStatsBlock,
	});

	// Cooldown — prevent re-trigger for 2 minutes after compaction
	try {
		fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
	} catch {}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Handle warning menu response (user replied 1/2/3/4)
// ---------------------------------------------------------------------------
if (fs.existsSync(flags.menu)) {
	const choice = (prompt || "").trim();
	if (choice === "0" || choice.toLowerCase() === "cancel") {
		fs.unlinkSync(flags.menu);
		let originalPrompt = "";
		try {
			originalPrompt = fs.readFileSync(flags.prompt, "utf8");
		} catch {}
		try {
			fs.unlinkSync(flags.prompt);
		} catch {}
		try {
			fs.unlinkSync(flags.warned);
		} catch {}
		try {
			fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
		} catch {}
		log(`menu-cancel session=${session_id}`);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `The user dismissed the context warning.\n\n<original_request>\n${originalPrompt}\n</original_request>\n\nTreat the above <original_request> as if the user just typed it. Respond to it now.`,
			},
		});
		process.exit(0);
	}
	if (["1", "2", "3", "4"].includes(choice)) {
		fs.unlinkSync(flags.menu);
		let originalPrompt = "";
		try {
			originalPrompt = fs.readFileSync(flags.prompt, "utf8");
		} catch {}
		// NOTE: prompt file cleanup deferred to after output — see end of block

		ensureDataDir();
		fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const exportFile = path.join(
			CHECKPOINTS_DIR,
			`session-${stamp}-${session_id.slice(0, 8)}.md`,
		);

		log(`menu-reply choice=${choice} session=${session_id}`);

		if (choice === "1") {
			// Clear warned flag so it can re-trigger as context grows.
			// Use cooldown to prevent immediate re-trigger.
			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			try {
				fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
			} catch {}
			output({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: `The user chose to continue normally.\n\n<original_request>\n${originalPrompt}\n</original_request>\n\nTreat the above <original_request> as if the user just typed it. Respond to it now.`,
				},
			});
		} else if (choice === "2") {
			const capMax =
				getTokenUsage(transcript_path)?.max_tokens ||
				resolveMaxTokens() ||
				200000;
			let exportContent = extractConversation(transcript_path);
			exportContent = capCheckpointContent(exportContent, capMax);
			if (!hasExtractedContent(exportContent)) {
				log(`compact-empty choice=2 session=${session_id}`);
				try {
					fs.unlinkSync(flags.warned);
				} catch {}
				output({
					decision: "block",
					reason: `Context Guardian could not extract meaningful conversation content for Smart Compact. Your session may consist primarily of tool interactions. Try "Keep Recent" (option 3) instead.\n\nYour original message has been saved — reply with 3 to try Keep Recent, or 0 to cancel.`,
				});
				// Re-create menu so user can pick another option
				fs.writeFileSync(flags.menu, "1");
				fs.writeFileSync(flags.prompt, originalPrompt || "");
				process.exit(0);
			}
			fs.writeFileSync(
				exportFile,
				`# Context Checkpoint (Smart Compact)\n> Created: ${new Date().toISOString()}\n\n${exportContent}`,
			);
			let preStats = {};
			try {
				preStats = JSON.parse(fs.readFileSync(flags.warned, "utf8"));
			} catch {}
			const preTokens =
				preStats.currentTokens || estimateTokens(transcript_path);
			const preMax = preStats.maxTokens || resolveMaxTokens();
			const fullCheckpoint = fs.readFileSync(exportFile, "utf8");
			const { stats, block: statsBlock } = formatCompactionStats(
				preTokens,
				preMax,
				fullCheckpoint,
				{ hasOriginalPrompt: !!originalPrompt },
			);
			fs.writeFileSync(
				pState.reload,
				JSON.stringify({
					checkpoint_path: exportFile,
					original_prompt: originalPrompt,
					ts: Date.now(),
					stats,
					mode: "smart",
					created_session: session_id,
				}),
			);
			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			rotateCheckpoints();
			log(
				`checkpoint-saved choice=2 file=${exportFile} pre=${preTokens} post=${stats.postTokens} saved=${stats.saved}`,
			);
			output({
				decision: "block",
				reason: statsBlock,
			});
		} else if (choice === "3") {
			const capMax3 =
				getTokenUsage(transcript_path)?.max_tokens ||
				resolveMaxTokens() ||
				200000;
			let recentContent = extractRecent(transcript_path, 20);
			recentContent = capCheckpointContent(recentContent, capMax3);
			if (!hasExtractedContent(recentContent)) {
				log(`compact-empty choice=3 session=${session_id}`);
				try {
					fs.unlinkSync(flags.warned);
				} catch {}
				output({
					decision: "block",
					reason: `Context Guardian could not extract meaningful conversation content for Keep Recent. Your session may consist primarily of tool interactions. Consider using /clear to start fresh.\n\nYour original message has been saved — reply with 1 to continue without compacting, or 0 to cancel.`,
				});
				fs.writeFileSync(flags.menu, "1");
				fs.writeFileSync(flags.prompt, originalPrompt || "");
				process.exit(0);
			}
			fs.writeFileSync(
				exportFile,
				`# Context Checkpoint (Keep Recent 20)\n> Created: ${new Date().toISOString()}\n\n${recentContent}`,
			);
			let preStats3 = {};
			try {
				preStats3 = JSON.parse(fs.readFileSync(flags.warned, "utf8"));
			} catch {}
			const preTokens3 =
				preStats3.currentTokens || estimateTokens(transcript_path);
			const preMax3 = preStats3.maxTokens || resolveMaxTokens();
			const fullCheckpoint3 = fs.readFileSync(exportFile, "utf8");
			const { stats: stats3, block: statsBlock3 } = formatCompactionStats(
				preTokens3,
				preMax3,
				fullCheckpoint3,
				{ hasOriginalPrompt: !!originalPrompt },
			);
			fs.writeFileSync(
				pState.reload,
				JSON.stringify({
					checkpoint_path: exportFile,
					original_prompt: originalPrompt,
					ts: Date.now(),
					stats: stats3,
					mode: "recent",
					created_session: session_id,
				}),
			);
			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			rotateCheckpoints();
			log(
				`checkpoint-saved choice=3 file=${exportFile} pre=${preTokens3} post=${stats3.postTokens} saved=${stats3.saved}`,
			);
			output({
				decision: "block",
				reason: statsBlock3,
			});
		} else if (choice === "4") {
			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			output({
				decision: "block",
				reason: `Context cleared. Type /clear to wipe context and start fresh. No checkpoint was saved.`,
			});
		}

		// Cooldown — prevent re-trigger for 2 minutes after any compaction
		if (["2", "3", "4"].includes(choice)) {
			try {
				fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
			} catch {}
		}

		// Clean up prompt file now that all work is done
		try {
			fs.unlinkSync(flags.prompt);
		} catch {}
	} else {
		// Invalid choice — re-show the menu
		log(`menu-invalid choice="${choice}" session=${session_id}`);
		output({
			decision: "block",
			reason: `"${choice}" is not a valid option. Please reply with 1, 2, 3, 4, or 0 to cancel.\n\n  1  Continue\n  2  Smart Compact\n  3  Keep Recent\n  4  Clear\n  0  Cancel (continue without warning)`,
		});
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Resume detection — replay original prompt after /clear + checkpoint restore
// ---------------------------------------------------------------------------
if (fs.existsSync(pState.resume)) {
	const resumeInput = (prompt || "").trim().toLowerCase();
	if (resumeInput === "resume") {
		try {
			const resumeData = JSON.parse(fs.readFileSync(pState.resume, "utf8"));
			fs.unlinkSync(pState.resume);
			if (
				resumeData.original_prompt &&
				Date.now() - resumeData.ts < 2 * 60 * 1000
			) {
				log(
					`resume-replay session=${session_id} prompt="${resumeData.original_prompt.slice(0, 50)}"`,
				);
				output({
					hookSpecificOutput: {
						hookEventName: "UserPromptSubmit",
						additionalContext: `The user typed "resume" to continue from where they left off before context compaction.\n\n<original_request>\n${resumeData.original_prompt}\n</original_request>\n\nTreat the above <original_request> as if the user just typed it. Respond to it now.`,
					},
				});
				process.exit(0);
			}
			// Expired or no prompt — tell the user
			const ts = resumeData.ts || 0;
			const ageStr =
				ts > 0
					? `${Math.round((Date.now() - ts) / 60000)} minutes old`
					: "of unknown age";
			log(`resume-expired session=${session_id} age=${ageStr}`);
			output({
				decision: "block",
				reason: `Resume expired — the saved prompt is ${ageStr} (limit: 2 minutes). Your original message has been discarded. Please retype your request.`,
			});
			process.exit(0);
		} catch (e) {
			log(`resume-error: ${e.message}`);
			output({
				decision: "block",
				reason: `Resume failed — the saved prompt data was corrupted. Please retype your request.`,
			});
			process.exit(0);
		}
	}
}

// ---------------------------------------------------------------------------
// Bypass slash commands (but write state preview if reload pending)
// ---------------------------------------------------------------------------
const trimmed = (prompt || "").trim().toLowerCase();
if (trimmed.startsWith("/")) {
	if (fs.existsSync(pState.reload)) {
		try {
			const rl = JSON.parse(fs.readFileSync(pState.reload, "utf8"));
			if (Date.now() - rl.ts < 10 * 60 * 1000 && rl.stats) {
				const pt = rl.stats.postTokens || 0;
				const pm = rl.stats.maxTokens || resolveMaxTokens() || 200000;
				writeCompactionState(
					pt,
					pm,
					"Context checkpoint ready — send a message to restore.",
				);
			}
		} catch {}
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Reload detection — inject checkpoint after /clear
// ---------------------------------------------------------------------------
if (fs.existsSync(pState.reload)) {
	try {
		const reload = JSON.parse(fs.readFileSync(pState.reload, "utf8"));
		if (Date.now() - reload.ts < 10 * 60 * 1000) {
			// Guard: only inject into a different session (post-/clear).
			// If created_session matches, user hasn't /cleared yet.
			if (reload.created_session === session_id) {
				log(
					`reload-skip session=${session_id} — same session that created the compaction`,
				);
				// One-time non-blocking reminder to /clear
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
					process.exit(0);
				}
				// Don't delete the reload file — the new session after /clear needs it
				// (fall through to normal token check)
			} else {
				// Fresh session — inject the checkpoint
				if (!fs.existsSync(reload.checkpoint_path)) {
					log(
						`reload-error session=${session_id} — checkpoint file missing: ${reload.checkpoint_path}`,
					);
					fs.unlinkSync(pState.reload);
					output({
						decision: "block",
						reason: `Context Guardian: checkpoint file was deleted before it could be restored. Your compacted context has been lost. Please continue with a fresh session.`,
					});
					process.exit(0);
				}
				const checkpoint = fs.readFileSync(reload.checkpoint_path, "utf8");
				fs.unlinkSync(pState.reload);
				try {
					fs.unlinkSync(pState.cooldown);
				} catch {}
				let reloadStatsLine = "";
				if (reload.stats) {
					const s = reload.stats;
					reloadStatsLine =
						`\n\nCompaction Stats\n` +
						`   Before:  ${s.preTokens.toLocaleString()} tokens (~${s.prePct}% of context)\n` +
						`   After:   ~${s.postTokens.toLocaleString()} tokens (~${s.postPct}% of context)\n` +
						`   Saved:   ~${s.saved.toLocaleString()} tokens (${s.savedPct}% reduction)`;
				}

				// If user typed "resume" as their first message after /clear, replay
				// the original prompt immediately — no need for a second "resume".
				const isResumeNow = (prompt || "").trim().toLowerCase() === "resume";
				const hasOriginal = !!reload.original_prompt;
				const restoreMarker =
					reload.mode === "recent"
						? "[KEEP RECENT — restored checkpoint]"
						: "[SMART COMPACT — restored checkpoint]";

				if (isResumeNow && hasOriginal) {
					log(
						`reload-resume-immediate session=${session_id} prompt="${reload.original_prompt.slice(0, 50)}"`,
					);
					output({
						hookSpecificOutput: {
							hookEventName: "UserPromptSubmit",
							additionalContext:
								`${restoreMarker}\n\n<prior_conversation_history>\nThe following is a summary of the conversation before compaction. This is HISTORY — do NOT respond to these messages individually.\n\n${checkpoint}\n</prior_conversation_history>\n\n---${reloadStatsLine}\n\n` +
								`The user typed "resume" after /clear. Context has been restored.\n\n<original_request>\n${reload.original_prompt}\n</original_request>\n\nTreat the above <original_request> as if the user just typed it. Respond to it now.`,
						},
					});
				} else {
					// Not "resume" — inject checkpoint and tell them about resume
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
						`reload-inject session=${session_id} checkpoint=${reload.checkpoint_path}`,
					);
					output({
						hookSpecificOutput: {
							hookEventName: "UserPromptSubmit",
							additionalContext: `${restoreMarker}\n\n<prior_conversation_history>\nThe following is a summary of the conversation before compaction. This is HISTORY — do NOT respond to these messages individually.\n\n${checkpoint}\n</prior_conversation_history>\n\n---${reloadStatsLine}\n\nThe user cleared context and this checkpoint was auto-restored. Show the compaction stats above so they can see the savings.${resumeHint}`,
						},
					});
				}
				// Write state file so /context-guardian:status works immediately
				const rlTokens =
					reload.stats?.postTokens || Math.round(checkpoint.length / 4);
				const rlMax = reload.stats?.maxTokens || resolveMaxTokens() || 200000;
				writeCompactionState(
					rlTokens,
					rlMax,
					"Context restored from checkpoint.",
				);
				process.exit(0);
			}
		} else {
			fs.unlinkSync(pState.reload);
			log(`reload-expired session=${session_id}`);
		}
	} catch (e) {
		try {
			fs.unlinkSync(pState.reload);
		} catch {}
		log(`reload-error: ${e.message}`);
	}
}

// ---------------------------------------------------------------------------
// Token usage check
// ---------------------------------------------------------------------------
if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

const cfg = loadConfig();
const threshold = cfg.threshold ?? 0.35;

const realUsage = getTokenUsage(transcript_path);
const currentTokens = realUsage
	? realUsage.current_tokens
	: estimateTokens(transcript_path);
const maxTokens = realUsage?.max_tokens || resolveMaxTokens() || 200000;
const pct = currentTokens / maxTokens;
const source = realUsage ? "real" : "estimated";

log(
	`check session=${session_id} tokens=${currentTokens}/${maxTokens} pct=${(pct * 100).toFixed(1)}% threshold=${(threshold * 100).toFixed(0)}% source=${source} warned=${fs.existsSync(flags.warned)}`,
);

// Write state so /context-guardian:status can read it (session-scoped).
// Also written by the stop hook after each response for fresher counts.
// Pre-compute values so the status skill just reads and formats — no arithmetic.
const headroom = Math.max(0, Math.round(maxTokens * threshold - currentTokens));
const pctDisplay = (pct * 100).toFixed(1);
const thresholdDisplay = Math.round(threshold * 100);
let recommendation;
if (pct < threshold * 0.5)
	recommendation = "All clear. Plenty of context remaining.";
else if (pct < threshold)
	recommendation = "Approaching threshold. Consider wrapping up complex tasks.";
else
	recommendation =
		"At threshold. Compaction recommended — the warning menu will trigger on your next message.";

try {
	ensureDataDir();
	fs.writeFileSync(
		stateFile(session_id),
		JSON.stringify({
			current_tokens: currentTokens,
			max_tokens: maxTokens,
			pct,
			pct_display: pctDisplay,
			threshold,
			threshold_display: thresholdDisplay,
			headroom,
			recommendation,
			source,
			model: realUsage?.model || "unknown",
			session_id,
			transcript_path,
			ts: Date.now(),
		}),
	);
} catch {}

// Below threshold: reset warned flag so it can re-fire if context grows back
if (pct < threshold) {
	try {
		fs.unlinkSync(flags.warned);
	} catch {}
	process.exit(0);
}

// Cooldown after compaction — don't re-trigger for 2 minutes
if (fs.existsSync(pState.cooldown)) {
	try {
		const cd = JSON.parse(fs.readFileSync(pState.cooldown, "utf8"));
		if (Date.now() - cd.ts < 2 * 60 * 1000) {
			log(
				`cooldown active — skipping threshold (${Math.round((Date.now() - cd.ts) / 1000)}s since compaction)`,
			);
			process.exit(0);
		}
		fs.unlinkSync(pState.cooldown);
	} catch {}
}

// Already warned this session
if (fs.existsSync(flags.warned)) process.exit(0);

// ---------------------------------------------------------------------------
// Show menu
// ---------------------------------------------------------------------------
fs.mkdirSync(flags.dir, { recursive: true });
fs.writeFileSync(
	flags.warned,
	JSON.stringify({ pct, currentTokens, maxTokens, ts: Date.now() }),
);
fs.writeFileSync(flags.menu, "1");
fs.writeFileSync(flags.prompt, prompt || "");

log(
	`BLOCKED session=${session_id} pct=${(pct * 100).toFixed(1)}% source=${source}`,
);

output({
	decision: "block",
	reason: [
		`Context Guardian — ~${(pct * 100).toFixed(1)}% used (~${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens)`,
		``,
		`  1  Continue          proceed with your request (it's saved, don't retype it)`,
		`  2  Smart Compact     keep text conversation, strip tool calls & code output`,
		`  3  Keep Recent       drop oldest, keep last 20 messages`,
		`  4  Clear             wipe everything`,
		`  0  Cancel            dismiss this warning and continue`,
		``,
		`Reply with 1, 2, 3, 4, or 0.`,
	].join("\n"),
});

process.exit(0);

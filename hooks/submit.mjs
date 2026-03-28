#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Context Guardian's main entry point.
 *
 * Runs on every user message. Handles (in order):
 * 1. Manual compaction commands (/context-guardian:compact, :prune)
 * 2. Warning menu responses (1-4, 0/cancel)
 * 3. Resume detection ("resume" after /clear)
 * 4. Slash command bypass
 * 5. Checkpoint reload after /clear
 * 6. Token usage check + threshold warning
 *
 * Heavy logic is delegated to lib/checkpoint.mjs and lib/reload-handler.mjs.
 *
 * @module submit-hook
 */
import fs from "node:fs";
import { performCompaction, writeCompactionState } from "../lib/checkpoint.mjs";
import { loadConfig, resolveMaxTokens } from "../lib/config.mjs";
import { log } from "../lib/logger.mjs";
import {
	ensureDataDir,
	projectStateFiles,
	sessionFlags,
	stateFile,
} from "../lib/paths.mjs";
import { handleReload, handleResume } from "../lib/reload-handler.mjs";
import { estimateTokens, getTokenUsage } from "../lib/tokens.mjs";

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

// ---------------------------------------------------------------------------
// 1. Manual compact — direct skill command OR legacy flag file
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

	log(`manual-compact mode=${cMode} session=${session_id}`);
	const result = performCompaction({
		mode: cMode,
		transcriptPath: transcript_path,
		sessionId: session_id,
		originalPrompt: "",
		reloadPath: pState.reload,
	});

	if (!result) {
		log(`manual-compact-empty mode=${cMode} session=${session_id}`);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `[Context Guardian] Could not extract meaningful conversation content. Your session may consist primarily of tool interactions with minimal text. Try ${cMode === "smart" ? "/context-guardian:prune" : "/context-guardian:compact"} instead, or continue working.`,
			},
		});
		process.exit(0);
	}

	output({
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: `[Context Guardian] Manual compaction complete.\n\n${result.statsBlock}\n\nDisplay the stats box above verbatim. Then tell the user to type /clear to apply the compaction.`,
		},
	});
	try {
		fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
	} catch {}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Warning menu response (user replied 1/2/3/4/0/cancel)
// ---------------------------------------------------------------------------
if (fs.existsSync(flags.menu)) {
	const choice = (prompt || "").trim();

	// Cancel / dismiss
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

	// Valid choices
	if (["1", "2", "3", "4"].includes(choice)) {
		fs.unlinkSync(flags.menu);
		let originalPrompt = "";
		try {
			originalPrompt = fs.readFileSync(flags.prompt, "utf8");
		} catch {}

		log(`menu-reply choice=${choice} session=${session_id}`);

		if (choice === "1") {
			// Continue — clear warned, set cooldown, replay prompt
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
		} else if (choice === "2" || choice === "3") {
			// Smart Compact or Keep Recent
			const mode = choice === "2" ? "smart" : "recent";
			let preStats = {};
			try {
				preStats = JSON.parse(fs.readFileSync(flags.warned, "utf8"));
			} catch {}

			const result = performCompaction({
				mode,
				transcriptPath: transcript_path,
				sessionId: session_id,
				originalPrompt,
				reloadPath: pState.reload,
				preStats,
			});

			if (!result) {
				log(`compact-empty choice=${choice} session=${session_id}`);
				try {
					fs.unlinkSync(flags.warned);
				} catch {}
				const alt = choice === "2" ? "3" : "1";
				const altName =
					choice === "2" ? "Keep Recent" : "continue without compacting";
				output({
					decision: "block",
					reason: `Context Guardian could not extract meaningful conversation content. Try option ${alt} (${altName}) instead.\n\nYour original message has been saved — reply with ${alt}, or 0 to cancel.`,
				});
				fs.writeFileSync(flags.menu, "1");
				fs.writeFileSync(flags.prompt, originalPrompt || "");
				process.exit(0);
			}

			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			output({ decision: "block", reason: result.statsBlock });
		} else if (choice === "4") {
			// Clear — wipe everything
			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			output({
				decision: "block",
				reason: `Context cleared. Type /clear to wipe context and start fresh. No checkpoint was saved.`,
			});
		}

		// Cooldown for compaction/clear choices
		if (["2", "3", "4"].includes(choice)) {
			try {
				fs.writeFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
			} catch {}
		}
		try {
			fs.unlinkSync(flags.prompt);
		} catch {}
	} else {
		// Invalid choice — re-show menu
		log(`menu-invalid choice="${choice}" session=${session_id}`);
		output({
			decision: "block",
			reason: `"${choice}" is not a valid option. Please reply with 1, 2, 3, 4, or 0 to cancel.\n\n  1  Continue\n  2  Smart Compact\n  3  Keep Recent\n  4  Clear\n  0  Cancel (continue without warning)`,
		});
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Resume detection
// ---------------------------------------------------------------------------
if (handleResume(prompt, session_id, pState, output)) process.exit(0);

// ---------------------------------------------------------------------------
// 4. Slash command bypass (but write state preview if reload pending)
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
					session_id,
					transcript_path,
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
// 5. Reload detection — inject checkpoint after /clear
// ---------------------------------------------------------------------------
if (
	handleReload({
		prompt,
		sessionId: session_id,
		transcriptPath: transcript_path,
		pState,
		flags,
		output,
	})
)
	process.exit(0);

// ---------------------------------------------------------------------------
// 6. Token usage check
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

// Write state for /context-guardian:status
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

// Below threshold — reset warned flag so it can re-fire
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
// Show warning menu
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

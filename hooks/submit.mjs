#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Context Guardian's main entry point.
 *
 * Runs on every user message. Handles (in order):
 * 1. Manual compaction commands (/cg:compact, :prune)
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
import { estimateSavings } from "../lib/estimate.mjs";
import { log } from "../lib/logger.mjs";
import {
	atomicWriteFileSync,
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
	process.stderr.write(`cg: failed to parse stdin: ${e.message}\n`);
	process.exit(0);
}
const { session_id = "unknown", prompt, transcript_path } = input;

const flags = sessionFlags(input.cwd, session_id);
const pState = projectStateFiles(input.cwd);

// Ensure flags directory exists early — all code paths may write flag files
try {
	fs.mkdirSync(flags.dir, { recursive: true });
} catch {}

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
	if (p.startsWith("/cg:compact")) cMode = "smart";
	else if (p.startsWith("/cg:prune")) cMode = "recent";
}

if (cMode) {
	if (cMode !== "smart" && cMode !== "recent") {
		log(`manual-compact-invalid-mode mode="${cMode}" session=${session_id}`);
		output({
			decision: "block",
			reason:
				"Context Guardian: invalid compaction mode. Use /cg:compact or /cg:prune.",
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
				additionalContext: `[Context Guardian] Could not extract meaningful conversation content. Your session may consist primarily of tool interactions with minimal text. Try ${cMode === "smart" ? "/cg:prune" : "/cg:compact"} instead, or continue working.`,
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
		atomicWriteFileSync(pState.cooldown, JSON.stringify({ ts: Date.now() }));
	} catch {}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Warning menu response (user replied 1/2/3/4)
// ---------------------------------------------------------------------------
if (fs.existsSync(flags.menu)) {
	const choice = (prompt || "").trim();

	if (["1", "2", "3", "4"].includes(choice)) {
		fs.unlinkSync(flags.menu);
		let originalPrompt = "";
		try {
			originalPrompt = fs.readFileSync(flags.prompt, "utf8");
		} catch (e) {
			log(`prompt-read-error session=${session_id}: ${e.message}`);
		}

		log(`menu-reply choice=${choice} session=${session_id}`);

		if (choice === "1") {
			// Continue — clear warned, set cooldown, replay prompt
			try {
				fs.unlinkSync(flags.warned);
			} catch {}
			try {
				atomicWriteFileSync(
					pState.cooldown,
					JSON.stringify({ ts: Date.now() }),
				);
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
				atomicWriteFileSync(
					pState.cooldown,
					JSON.stringify({ ts: Date.now() }),
				);
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
			reason: `"${choice}" is not a valid option. Please reply with 1, 2, 3, or 4.\n\n  1  Continue\n  2  Smart Compact\n  3  Keep Recent 20\n  4  Clear`,
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

// Write state for /cg:stats
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

// Read measured baseline overhead from state (captured by stop hook on first response)
let baselineOverhead = 0;
try {
	const sf = stateFile(session_id);
	if (fs.existsSync(sf)) {
		const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
		baselineOverhead = prev.baseline_overhead ?? 0;
	}
} catch {}

const savings = estimateSavings(
	transcript_path,
	currentTokens,
	maxTokens,
	baselineOverhead,
);

try {
	ensureDataDir();
	atomicWriteFileSync(
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
			smart_estimate_pct: savings.smartPct,
			recent_estimate_pct: savings.recentPct,
			baseline_overhead: baselineOverhead,
			session_id,
			transcript_path,
			ts: Date.now(),
		}),
	);
} catch (e) {
	log(`state-write-error session=${session_id}: ${e.message}`);
}

// Below threshold — reset warned flag so it can re-fire
if (pct < threshold) {
	try {
		fs.unlinkSync(flags.warned);
	} catch {}

	// Graduated nudges — soft context hints via additionalContext (no blocking).
	// One-time per crossing: uses flag files so each level only fires once.
	const nudge50 = `${flags.dir}/cg-nudge50-${session_id}`;
	const nudge65 = `${flags.dir}/cg-nudge65-${session_id}`;
	const pctInt = Math.round(pct * 100);
	const tokensRemaining = Math.max(
		0,
		maxTokens - currentTokens,
	).toLocaleString();

	if (pct >= 0.65 && !fs.existsSync(nudge65)) {
		fs.mkdirSync(flags.dir, { recursive: true });
		fs.writeFileSync(nudge65, "1");
		log(`nudge-65 session=${session_id} pct=${pctInt}%`);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `[Context Guardian] Context window is ${pctInt}% full (~${tokensRemaining} tokens remaining). Consider running /cg:compact soon. Prefer concise responses and avoid unnecessary file reads.`,
			},
		});
		process.exit(0);
	}

	if (pct >= 0.5 && !fs.existsSync(nudge50)) {
		fs.mkdirSync(flags.dir, { recursive: true });
		fs.writeFileSync(nudge50, "1");
		log(`nudge-50 session=${session_id} pct=${pctInt}%`);
		output({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `[Context Guardian] Context window is ${pctInt}% full (~${tokensRemaining} tokens remaining). Run /cg:stats for details.`,
			},
		});
		process.exit(0);
	}

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

const currentPct = Math.round(pct * 100);
// Reuse `savings` computed at line 281 — avoid duplicate transcript scan
output({
	decision: "block",
	reason: [
		`Context Guardian — ~${currentPct}% used (~${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens)`,
		``,
		`  1  Continue           ~${currentPct}%`,
		`  2  Smart Compact      ~${currentPct}% → ~${savings.smartPct}%`,
		`  3  Keep Recent 20     ~${currentPct}% → ~${savings.recentPct}%`,
		`  4  Clear              ~${currentPct}% → 0%`,
		``,
		`Reply with 1, 2, 3, or 4.`,
	].join("\n"),
});

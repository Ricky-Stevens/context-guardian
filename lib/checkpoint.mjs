/**
 * Checkpoint creation and validation utilities.
 *
 * Provides the shared compaction pipeline: extract → cap → validate → save
 * checkpoint file → compute stats → write reload flag. Used by the manual
 * compact and prune skills (/cg:compact, /cg:prune).
 *
 * @module checkpoint
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveMaxTokens } from "./config.mjs";
import { log } from "./logger.mjs";
import {
	CHECKPOINTS_DIR,
	ensureDataDir,
	rotateCheckpoints,
	stateFile,
} from "./paths.mjs";
import { formatCompactionStats } from "./stats.mjs";
import { estimateOverhead, estimateTokens, getTokenUsage } from "./tokens.mjs";
import { extractConversation, extractRecent } from "./transcript.mjs";

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

/**
 * Check if extracted content has actual conversation data, not just
 * headers, empty strings, or placeholder text.
 *
 * @param {string} text - Extracted checkpoint content
 * @returns {boolean} True if the content contains real conversation
 */
export function hasExtractedContent(text) {
	return (
		text &&
		text !== "(no transcript available)" &&
		text.length > 50 &&
		(text.includes("User:") || text.includes("Assistant:"))
	);
}

// ---------------------------------------------------------------------------
// Checkpoint size cap
// ---------------------------------------------------------------------------

/**
 * Cap checkpoint content to prevent oversized additionalContext injections.
 * Uses start+end trim: keeps the first half and last half, trims the middle.
 *
 * @param {string} content - The checkpoint text
 * @param {number} maxTokens - The model's max token limit
 * @returns {string} The original or trimmed content
 */
export function capCheckpointContent(content, maxTokens) {
	// ~3.5 chars per token for English. Using 3x as conservative multiplier.
	const maxChars = Math.max(50000, (maxTokens || 200000) * 3);
	if (content.length <= maxChars) return content;
	const half = Math.floor(maxChars / 2);
	const trimmed = content.length - maxChars;
	log(
		`checkpoint-trimmed original=${content.length} kept=${maxChars} trimmed=${trimmed}`,
	);
	return (
		content.slice(0, half) +
		`\n\n> [${trimmed} chars trimmed from middle to fit context window]\n\n` +
		content.slice(-half)
	);
}

// ---------------------------------------------------------------------------
// State file writer
// ---------------------------------------------------------------------------

/**
 * Write a state file with post-compaction token estimates so
 * /cg:stats works immediately after compaction.
 *
 * @param {string} sessionId - Current session ID
 * @param {string} transcriptPath - Path to the transcript
 * @param {number} tokens - Estimated token count
 * @param {number} max - Max tokens for the model
 * @param {string} rec - Recommendation text
 */
export function writeCompactionState(
	sessionId,
	transcriptPath,
	tokens,
	max,
	rec,
) {
	try {
		const c = loadConfig();
		const th = c.threshold ?? 0.35;
		const p = tokens / max;

		// Carry forward baseline_overhead from existing state
		let baselineOverhead = 0;
		try {
			const sf = stateFile(sessionId);
			if (fs.existsSync(sf)) {
				const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
				baselineOverhead = prev.baseline_overhead ?? 0;
			}
		} catch {}

		ensureDataDir();
		fs.writeFileSync(
			stateFile(sessionId),
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
				smart_estimate_pct: 0,
				recent_estimate_pct: 0,
				baseline_overhead: baselineOverhead,
				session_id: sessionId,
				transcript_path: transcriptPath,
				ts: Date.now(),
			}),
		);
	} catch (e) {
		log(`writeCompactionState-error: ${e.message}`);
	}
}

// ---------------------------------------------------------------------------
// Shared compaction pipeline
// ---------------------------------------------------------------------------

/**
 * Perform the full compaction pipeline: extract → cap → validate → save
 * checkpoint → compute stats → write reload flag.
 *
 * Returns the stats block for display, or null if extraction produced
 * no meaningful content (caller should handle the empty case).
 *
 * @param {object} opts
 * @param {string} opts.mode - "smart" or "recent"
 * @param {string} opts.transcriptPath - Path to the JSONL transcript
 * @param {string} opts.sessionId - Current session ID
 * @param {string} opts.originalPrompt - The user's original prompt (empty for manual compaction)
 * @param {string} opts.reloadPath - Path to the reload flag file
 * @param {object} [opts.preStats] - Pre-compaction token counts { currentTokens, maxTokens }
 * @returns {{ statsBlock: string, stats: object, checkpointPath: string } | null}
 */
export function performCompaction(opts) {
	const {
		mode,
		transcriptPath,
		sessionId,
		originalPrompt,
		reloadPath,
		preStats,
	} = opts;
	const label = mode === "smart" ? "Smart Compact" : "Keep Recent 20";

	ensureDataDir();
	fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

	// Generate checkpoint filename
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const checkpointPath = path.join(
		CHECKPOINTS_DIR,
		`session-${stamp}-${sessionId.slice(0, 8)}.md`,
	);

	// Extract and cap content
	const usage = getTokenUsage(transcriptPath);
	const capMax = usage?.max_tokens || resolveMaxTokens() || 200000;
	let content =
		mode === "smart"
			? extractConversation(transcriptPath)
			: extractRecent(transcriptPath, 10);
	content = capCheckpointContent(content, capMax);

	if (!hasExtractedContent(content)) return null;

	// Save checkpoint file
	const fullCheckpoint = `# Context Checkpoint (${label})\n> Created: ${new Date().toISOString()}\n\n${content}`;
	fs.writeFileSync(checkpointPath, fullCheckpoint);

	// Also copy to .context-guardian/ for visibility and /cg:resume access
	try {
		const cgDir = path.join(process.cwd(), ".context-guardian");
		fs.mkdirSync(cgDir, { recursive: true });
		const cgCheckpointPath = path.join(
			cgDir,
			`cg-checkpoint-${stamp}-${sessionId.slice(0, 8)}.md`,
		);
		fs.writeFileSync(cgCheckpointPath, fullCheckpoint);
		// Rotate — keep last 5 checkpoint copies
		const cpFiles = fs
			.readdirSync(cgDir)
			.filter((f) => f.startsWith("cg-checkpoint-") && f.endsWith(".md"))
			.sort()
			.reverse();
		for (const f of cpFiles.slice(5)) {
			try {
				fs.unlinkSync(path.join(cgDir, f));
			} catch {}
		}
	} catch (e) {
		log(`checkpoint-copy-error: ${e.message}`);
	}

	// Compute stats
	const preTokens =
		preStats?.currentTokens ||
		usage?.current_tokens ||
		estimateTokens(transcriptPath);
	const preMax = preStats?.maxTokens || usage?.max_tokens || resolveMaxTokens();

	// Read baseline overhead from state file if available
	let baselineOverhead = 0;
	try {
		const sf = stateFile(sessionId);
		if (fs.existsSync(sf)) {
			const prev = JSON.parse(fs.readFileSync(sf, "utf8"));
			baselineOverhead = prev.baseline_overhead ?? 0;
		}
	} catch {}

	const overhead = estimateOverhead(
		preTokens,
		transcriptPath,
		baselineOverhead,
	);

	const { stats, block: statsBlock } = formatCompactionStats(
		preTokens,
		preMax,
		fullCheckpoint,
		{ hasOriginalPrompt: !!originalPrompt, overhead },
	);

	// Write reload flag
	fs.writeFileSync(
		reloadPath,
		JSON.stringify({
			checkpoint_path: checkpointPath,
			original_prompt: originalPrompt || "",
			ts: Date.now(),
			stats,
			mode,
			created_session: sessionId,
		}),
	);

	rotateCheckpoints();

	log(
		`checkpoint-saved mode=${mode} file=${checkpointPath} pre=${preTokens} post=${stats.postTokens} saved=${stats.saved}`,
	);

	return { statsBlock, stats, checkpointPath };
}

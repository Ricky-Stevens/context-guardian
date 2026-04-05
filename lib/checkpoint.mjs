/**
 * Checkpoint creation and validation utilities.
 *
 * Provides the shared compaction pipeline: extract → cap → validate → save
 * checkpoint file → compute stats. Used by the compact and prune skills
 * (/cg:compact, /cg:prune) via compact-cli.mjs.
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
	statuslineStateFile,
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
	{ payloadBytes = 0 } = {},
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
				remaining_to_alert: Math.max(
					0,
					Math.round(
						Math.round(th * 100) - Number.parseFloat((p * 100).toFixed(1)),
					),
				),
				headroom: Math.max(0, Math.round(max * th - tokens)),
				recommendation: rec,
				source: "estimated",
				model: "unknown",
				baseline_overhead: baselineOverhead,
				payload_bytes: payloadBytes,
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
 * checkpoint → compute stats.
 *
 * Returns the stats block for display, or null if extraction produced
 * no meaningful content (caller should handle the empty case).
 *
 * @param {object} opts
 * @param {string} opts.mode - "smart" or "recent"
 * @param {string} opts.transcriptPath - Path to the JSONL transcript
 * @param {string} opts.sessionId - Current session ID
 * @param {object} [opts.preStats] - Pre-compaction token counts { currentTokens, maxTokens }
 * @returns {{ statsBlock: string, stats: object, checkpointPath: string } | null}
 */
export function performCompaction(opts) {
	const { mode, transcriptPath, sessionId, preStats } = opts;
	const label = mode === "smart" ? "Smart Compact" : "Keep Recent 10";

	ensureDataDir();
	fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

	// Generate checkpoint filename
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
	const checkpointPath = path.join(
		CHECKPOINTS_DIR,
		`session-${stamp}-${sessionId.slice(0, 8)}.md`,
	);

	// Extract and cap content
	const usage = getTokenUsage(transcriptPath);

	// Read authoritative context_window_size from statusline state file.
	let ccContextWindowSize = null;
	try {
		const slFile = statuslineStateFile(sessionId);
		if (fs.existsSync(slFile)) {
			const slState = JSON.parse(fs.readFileSync(slFile, "utf8"));
			ccContextWindowSize = slState.context_window_size ?? null;
		}
	} catch {}
	const capMax = ccContextWindowSize || resolveMaxTokens() || 200000;
	let content =
		mode === "smart"
			? extractConversation(transcriptPath)
			: extractRecent(transcriptPath, 10);
	content = capCheckpointContent(content, capMax);

	if (!hasExtractedContent(content)) return null;

	// Save checkpoint file
	const fullCheckpoint = `# Context Checkpoint (${label})\n> Created: ${new Date().toISOString()}\n\n${content}`;
	fs.writeFileSync(checkpointPath, fullCheckpoint);

	// Also copy to .context-guardian/ for user visibility
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
	const preMax =
		preStats?.maxTokens || ccContextWindowSize || resolveMaxTokens();

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

	// Measure transcript file size for payload reporting
	let prePayloadBytes = 0;
	try {
		prePayloadBytes = fs.statSync(transcriptPath).size;
	} catch {}

	const { stats, block: statsBlock } = formatCompactionStats(
		preTokens,
		preMax,
		fullCheckpoint,
		{ overhead, prePayloadBytes },
	);

	rotateCheckpoints();

	log(
		`checkpoint-saved mode=${mode} file=${checkpointPath} pre=${preTokens} post=${stats.postTokens} saved=${stats.saved}`,
	);

	return { statsBlock, stats, checkpointPath };
}

/**
 * Session handoff — save extracted conversation to a project-local file
 * so a future session can pick up where you left off.
 *
 * Writes to .context-guardian/ in the project root. The /cg:resume skill
 * scans this directory to offer restore options.
 *
 * @module handoff
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { resolveMaxTokens } from "./config.mjs";
import { log } from "./logger.mjs";
import { stateFile } from "./paths.mjs";
import { estimateOverhead, getTokenUsage } from "./tokens.mjs";
import { extractConversation } from "./transcript.mjs";

/** Directory name for CG artifacts in the project root */
export const CG_DIR_NAME = ".context-guardian";

// ---------------------------------------------------------------------------
// Perform handoff
// ---------------------------------------------------------------------------

/**
 * Generate a handoff file from the current session transcript.
 *
 * @param {object} opts
 * @param {string} opts.transcriptPath - Path to the JSONL transcript
 * @param {string} opts.sessionId - Current session ID
 * @param {string} [opts.label] - Optional user-provided name for the handoff
 * @returns {{ statsBlock: string, handoffPath: string } | null}
 */
export function performHandoff({ transcriptPath, sessionId, label = "" }) {
	if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

	const content = extractConversation(transcriptPath);
	if (
		!content ||
		content === "(no transcript available)" ||
		content.includes("Messages preserved: 0")
	) {
		return null;
	}

	const projectDir = process.cwd();
	const cgDir = path.join(projectDir, CG_DIR_NAME);
	fs.mkdirSync(cgDir, { recursive: true });

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	// Slugify label for filename: lowercase, replace non-alphanumeric with dashes, trim
	const slug = label
		? `${label
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 50)}-`
		: "";
	const handoffPath = path.join(cgDir, `cg-handoff-${slug}${stamp}.md`);

	const labelLine = label ? `\n> Label: ${label}` : "";
	const fullContent = `# Session Handoff\n> Created: ${new Date().toISOString()}\n> Session: ${sessionId}${labelLine}\n\n${content}`;
	fs.writeFileSync(handoffPath, fullContent);

	// Rotate old handoff files (keep last 5)
	rotateFiles(cgDir, "cg-handoff-", 5);

	// Compute stats
	const usage = getTokenUsage(transcriptPath);
	const preTokens =
		usage?.current_tokens || Math.round(Buffer.byteLength(content, "utf8") / 4);
	const maxTokens = usage?.max_tokens || resolveMaxTokens() || 200000;
	const postTokens = Math.round(Buffer.byteLength(fullContent, "utf8") / 4);

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
	const effectivePost = postTokens + overhead;
	const saved = Math.max(0, preTokens - effectivePost);
	const savedPct =
		preTokens > 0 ? ((saved / preTokens) * 100).toFixed(1) : "0.0";
	const prePct =
		maxTokens > 0 ? ((preTokens / maxTokens) * 100).toFixed(1) : "?";
	const postPct =
		maxTokens > 0 ? ((effectivePost / maxTokens) * 100).toFixed(1) : "0.0";

	const statsBlock = [
		`┌──────────────────────────────────────────────────────────────────────────────────────────────────`,
		`│  Session Handoff`,
		`│`,
		`│  Before:  ${preTokens.toLocaleString()} tokens (~${prePct}% of context)`,
		`│  After:   ~${effectivePost.toLocaleString()} tokens (~${postPct}% of context)`,
		`│  Saved:   ~${saved.toLocaleString()} tokens (${savedPct}% reduction)`,
		`├──────────────────────────────────────────────────────────────────────────────────────────────────`,
		`│`,
		`│  Handoff saved to: ${handoffPath}`,
		`│`,
		`│  To restore in a future session, run /cg:resume`,
		`│`,
		`└──────────────────────────────────────────────────────────────────────────────────────────────────`,
	].join("\n");

	log(
		`handoff-saved session=${sessionId} file=${handoffPath} pre=${preTokens} post=${effectivePost}`,
	);

	return { statsBlock, handoffPath };
}

// ---------------------------------------------------------------------------
// List available restore files
// ---------------------------------------------------------------------------

/**
 * Scan .context-guardian/ for handoff and checkpoint files.
 * Returns them sorted newest-first with metadata parsed from headers.
 *
 * @param {string} projectDir - Project root directory
 * @returns {Array<{ path: string, filename: string, type: string, created: string, goal: string, size: number }>}
 */
export function listRestoreFiles(
	projectDir,
	{ includeCheckpoints = false } = {},
) {
	const cgDir = path.join(projectDir, CG_DIR_NAME);
	if (!fs.existsSync(cgDir)) return [];

	const files = [];
	for (const f of fs.readdirSync(cgDir)) {
		let type = null;
		if (f.startsWith("cg-handoff-") && f.endsWith(".md")) type = "handoff";
		else if (
			includeCheckpoints &&
			f.startsWith("cg-checkpoint-") &&
			f.endsWith(".md")
		)
			type = "checkpoint";
		if (!type) continue;

		const fullPath = path.join(cgDir, f);
		try {
			const stat = fs.statSync(fullPath);
			const head = readFileHead(fullPath, 512);
			const created = parseCreatedDate(head) || stat.mtime.toISOString();
			const label = parseLabel(head);
			const goal = parseGoal(head);
			const sizeKB = Math.round(stat.size / 1024);

			files.push({
				path: fullPath,
				filename: f,
				type,
				created,
				label,
				goal,
				size: sizeKB,
			});
		} catch {
			// Skip unreadable files
		}
	}

	// Sort newest first
	files.sort((a, b) => b.created.localeCompare(a.created));

	// Limit: 10 per type
	if (includeCheckpoints) {
		const handoffs = files.filter((f) => f.type === "handoff").slice(0, 10);
		const checkpoints = files
			.filter((f) => f.type === "checkpoint")
			.slice(0, 10);
		return [...handoffs, ...checkpoints].sort((a, b) =>
			b.created.localeCompare(a.created),
		);
	}
	return files.slice(0, 10);
}

/**
 * Format the restore menu for display.
 *
 * @param {Array} files - From listRestoreFiles()
 * @returns {string} Formatted menu text
 */
export function formatRestoreMenu(files, { showType = false } = {}) {
	if (files.length === 0) {
		return [
			`┌──────────────────────────────────────────────────────────────────────────`,
			`│  No saved sessions found in .context-guardian/`,
			`│  Run /cg:handoff [name] to save your current session.`,
			`└──────────────────────────────────────────────────────────────────────────`,
		].join("\n");
	}

	const lines = [
		`┌──────────────────────────────────────────────────────────────────────────`,
		`│  Previous Sessions`,
		`├──────────────────────────────────────────────────────────────────────────`,
	];

	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		const date = formatDate(f.created);
		const goalDisplay = f.label || f.goal || "no description";
		const typeSuffix = showType
			? ` [${f.type === "handoff" ? "HANDOFF" : "CHECKPOINT"}]`
			: "";
		lines.push(
			`│  [${i + 1}]  ${goalDisplay} (${date} · ${f.size}KB)${typeSuffix}`,
		);
	}

	lines.push(`│`);
	lines.push(
		`│  Reply with a number to restore, or continue to start a new session.`,
	);
	lines.push(
		`└──────────────────────────────────────────────────────────────────────────`,
	);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileHead(filePath, bytes) {
	const fd = fs.openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
		return buf.toString("utf8", 0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

function parseCreatedDate(head) {
	const m = head.match(/> Created: (.+)/);
	return m ? m[1].trim() : null;
}

function parseLabel(head) {
	const m = head.match(/> Label: (.+)/);
	return m ? m[1].trim() : null;
}

function parseGoal(head) {
	const m = head.match(/Goal: (.+)/);
	if (!m) return null;
	const goal = m[1].trim();
	return goal === "[not available]" ? null : goal;
}

function formatDate(isoString) {
	try {
		const d = new Date(isoString);
		const now = new Date();
		const diffMs = now - d;
		const diffM = Math.round(diffMs / (60 * 1000));
		const diffH = Math.round(diffMs / (60 * 60 * 1000));

		if (diffM < 1) return "just now";
		if (diffM === 1) return "1 minute ago";
		if (diffM < 60) return `${diffM} minutes ago`;
		if (diffH === 1) return "1 hour ago";
		if (diffH < 24) return `${diffH} hours ago`;
		const diffD = Math.round(diffH / 24);
		if (diffD === 1) return "yesterday";
		return `${diffD} days ago`;
	} catch {
		return isoString;
	}
}

/**
 * Rotate files matching a prefix, keeping the most recent N.
 */
export function rotateFiles(dir, prefix, maxKeep) {
	try {
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith(prefix) && f.endsWith(".md"));

		// Sort by file mtime (newest first) — filename sort is unreliable
		// when labels are prepended before the timestamp.
		files.sort((a, b) => {
			try {
				return (
					fs.statSync(path.join(dir, b)).mtimeMs -
					fs.statSync(path.join(dir, a)).mtimeMs
				);
			} catch {
				return 0;
			}
		});

		for (const f of files.slice(maxKeep)) {
			try {
				fs.unlinkSync(path.join(dir, f));
			} catch {}
		}
	} catch {}
}

import fs from "node:fs";
import { flattenContent } from "./content.mjs";

// Matches any compact/restore marker that signals a compaction boundary.
const COMPACT_MARKER_RE = /^\[(SMART COMPACT|KEEP RECENT|RESTORED CONTEXT)/;

// Maximum bytes to read from a transcript to prevent OOM on large sessions.
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10MB

// Maximum preamble size in characters. Beyond this, prior history is truncated
// to prevent checkpoints growing unboundedly across successive compactions.
const MAX_PREAMBLE_CHARS = 20000;

// ---------------------------------------------------------------------------
// Read transcript lines with a memory cap. Returns an array of non-empty lines.
// For files > MAX_READ_BYTES, reads only the tail and drops the first partial line.
// ---------------------------------------------------------------------------
function readTranscriptLines(transcriptPath) {
	const stat = fs.statSync(transcriptPath);
	if (stat.size <= MAX_READ_BYTES) {
		return fs
			.readFileSync(transcriptPath, "utf8")
			.split("\n")
			.filter((l) => l.trim());
	}
	const buf = Buffer.alloc(MAX_READ_BYTES);
	const fd = fs.openSync(transcriptPath, "r");
	try {
		fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
	} finally {
		fs.closeSync(fd);
	}
	let text = buf.toString("utf8");
	const firstNewline = text.indexOf("\n");
	if (firstNewline > 0) text = text.slice(firstNewline + 1);
	return text.split("\n").filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// Extract file paths from tool_use blocks in a message content array.
// ---------------------------------------------------------------------------
function extractFilePaths(content) {
	const paths = [];
	if (!Array.isArray(content)) return paths;
	for (const block of content) {
		if (block.type === "tool_use" && block.input) {
			if (block.input.path) paths.push(block.input.path);
			if (block.input.file_path) paths.push(block.input.file_path);
			if (block.input.command && /\S+\.\w+/.test(block.input.command)) {
				// Don't try to parse commands — too noisy
			}
		}
	}
	return paths;
}

// ---------------------------------------------------------------------------
// Smart Compact — extract full conversation history, strip tool noise.
//
// Keeps:  user messages, assistant text blocks, tool-only placeholders
// Strips: tool_use content, tool_result content, thinking blocks,
//         system messages, skill injections, CG menu replies,
//         previous compact markers
// Adds:   file reference summary, tool-only gap placeholders
// Preserves: the most recent compact block as a preamble (prior history)
// ---------------------------------------------------------------------------
export function extractConversation(transcriptPath) {
	if (!transcriptPath || !fs.existsSync(transcriptPath))
		return "(no transcript available)";
	const lines = readTranscriptLines(transcriptPath);

	// Find the last compact marker — everything before it is already summarised.
	let compactPreamble = "";
	let compactIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(lines[i]);
			const text = flattenContent(obj.message?.content).trim();
			if (
				COMPACT_MARKER_RE.test(text) ||
				text.startsWith("# Context Checkpoint")
			) {
				compactPreamble = text;
				compactIdx = i;
				break;
			}
		} catch {}
	}

	let parseErrors = 0;
	let lastAssistantIsCGMenu = false;
	const messages = [];
	const filesReferenced = new Set();

	for (let i = compactIdx + 1; i < lines.length; i++) {
		let obj;
		try {
			obj = JSON.parse(lines[i]);
		} catch {
			parseErrors++;
			continue;
		}

		if (obj.type === "assistant" && obj.message?.role === "assistant") {
			const content = obj.message.content;
			const text = Array.isArray(content)
				? content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n")
						.trim()
				: typeof content === "string"
					? content.trim()
					: "";

			// Collect file paths from tool_use blocks (C1)
			for (const fp of extractFilePaths(content)) filesReferenced.add(fp);

			const hasToolUse =
				Array.isArray(content) && content.some((b) => b.type === "tool_use");

			lastAssistantIsCGMenu =
				/Context Guardian\s.{0,5}\d/.test(text) &&
				text.includes("Reply with 1,");

			if (text) {
				messages.push(`**Assistant:** ${text}`);
			} else if (hasToolUse) {
				// C2: Preserve conversational flow for tool-only responses
				messages.push(`**Assistant:** [Performed tool operations]`);
			}
		}

		if (obj.type === "user" && obj.message?.role === "user") {
			const text = flattenContent(obj.message.content).trim();
			if (!text) continue;
			// Skip slash commands — not meaningful conversation content
			if (text.startsWith("/")) continue;
			if (
				lastAssistantIsCGMenu &&
				(/^[0-4]$/.test(text) || text.toLowerCase() === "cancel")
			) {
				lastAssistantIsCGMenu = false;
				continue;
			}
			lastAssistantIsCGMenu = false;
			if (
				COMPACT_MARKER_RE.test(text) ||
				text.startsWith("# Context Checkpoint")
			)
				continue;
			if (
				text.length > 800 &&
				/^#{1,3} /.test(text) &&
				(text.match(/\n#{1,3} /g) || []).length >= 2
			)
				continue;
			messages.push(`**User:** ${text}`);
		}
	}

	// C1: Add file reference summary at the top if any files were touched
	let extracted = messages.join("\n\n---\n\n");
	if (filesReferenced.size > 0) {
		const sortedFiles = Array.from(filesReferenced).sort();
		extracted = `**Files referenced in this session:** ${sortedFiles.join(", ")}\n\n---\n\n${extracted}`;
	}

	// B1: Cap preamble size to prevent unbounded growth across compactions
	if (compactPreamble && compactPreamble.length > MAX_PREAMBLE_CHARS) {
		compactPreamble =
			compactPreamble.slice(0, MAX_PREAMBLE_CHARS) +
			"\n\n[Prior history truncated — too large to preserve in full]";
	}

	let result = compactPreamble
		? `${compactPreamble}\n\n---\n\n${extracted}`
		: extracted;
	if (parseErrors > 0) {
		result += `\n\n> Warning: ${parseErrors} transcript line(s) could not be parsed and may be missing from this summary.`;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Keep Recent — take the last N user/assistant messages.
// Simpler than Smart Compact: no preamble logic, just a sliding window.
// ---------------------------------------------------------------------------
export function extractRecent(transcriptPath, n) {
	if (!transcriptPath || !fs.existsSync(transcriptPath))
		return "(no transcript available)";
	const lines = readTranscriptLines(transcriptPath);

	let parseErrors = 0;
	let lastAssistantIsCGMenu = false;
	const messages = [];
	for (const line of lines) {
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			parseErrors++;
			continue;
		}

		if (obj.type === "assistant" && obj.message?.role === "assistant") {
			const content = obj.message.content;
			const text = Array.isArray(content)
				? content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n")
						.trim()
				: typeof content === "string"
					? content.trim()
					: "";

			lastAssistantIsCGMenu =
				/Context Guardian\s.{0,5}\d/.test(text) &&
				text.includes("Reply with 1,");

			// Only count messages with real text content toward the N limit.
			// Tool-only assistant turns are excluded so they don't eat message slots.
			if (text) {
				messages.push({ role: "assistant", text });
			}
		}

		if (obj.type === "user" && obj.message?.role === "user") {
			const text = flattenContent(obj.message.content).trim();
			if (!text) continue;
			// Skip slash commands — not meaningful conversation content
			if (text.startsWith("/")) continue;
			if (
				lastAssistantIsCGMenu &&
				(/^[0-4]$/.test(text) || text.toLowerCase() === "cancel")
			) {
				lastAssistantIsCGMenu = false;
				continue;
			}
			lastAssistantIsCGMenu = false;
			if (
				COMPACT_MARKER_RE.test(text) ||
				text.startsWith("# Context Checkpoint")
			)
				continue;
			if (
				text.length > 800 &&
				/^#{1,3} /.test(text) &&
				(text.match(/\n#{1,3} /g) || []).length >= 2
			)
				continue;
			messages.push({ role: "user", text });
		}
	}

	let result = messages
		.slice(-n)
		.map((m) => `**${m.role === "user" ? "User" : "Assistant"}:** ${m.text}`)
		.join("\n\n---\n\n");
	if (parseErrors > 0) {
		result += `\n\n> Warning: ${parseErrors} transcript line(s) could not be parsed and may be missing from this summary.`;
	}
	return result;
}

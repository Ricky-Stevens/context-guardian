import fs from "node:fs";
import { flattenContent } from "./content.mjs";

// Matches any compact/restore marker that signals a compaction boundary.
const COMPACT_MARKER_RE = /^\[(SMART COMPACT|KEEP RECENT|RESTORED CONTEXT)/;

// Maximum bytes to read from a transcript to prevent OOM on large sessions.
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10MB

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
	// Read the tail — compact markers and all post-marker content will be here.
	const buf = Buffer.alloc(MAX_READ_BYTES);
	const fd = fs.openSync(transcriptPath, "r");
	try {
		fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
	} finally {
		fs.closeSync(fd);
	}
	let text = buf.toString("utf8");
	// Drop the first partial line (we likely landed mid-JSON-line)
	const firstNewline = text.indexOf("\n");
	if (firstNewline > 0) text = text.slice(firstNewline + 1);
	return text.split("\n").filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// Smart Compact — extract full conversation history, strip tool noise.
//
// Keeps:  user messages, assistant text blocks
// Strips: tool_use, tool_result, thinking blocks, system messages,
//         skill injections (structured multi-heading docs), CG menu replies,
//         previous compact markers
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
			lastAssistantIsCGMenu =
				/Context Guardian\s.{0,5}\d/.test(text) &&
				text.includes("Reply with 1,");
			if (text) messages.push(`**Assistant:** ${text}`);
		}

		if (obj.type === "user" && obj.message?.role === "user") {
			const text = flattenContent(obj.message.content).trim();
			if (!text) continue;
			// Filter CG menu replies only when preceded by a CG menu prompt
			if (
				lastAssistantIsCGMenu &&
				(/^[0-4]$/.test(text) || text.toLowerCase() === "cancel")
			) {
				lastAssistantIsCGMenu = false;
				continue;
			}
			lastAssistantIsCGMenu = false;
			// Filter compact markers (already captured as preamble or from prior compactions)
			if (
				COMPACT_MARKER_RE.test(text) ||
				text.startsWith("# Context Checkpoint")
			)
				continue;
			// Filter skill injections: long, starts with heading, has 2+ sub-headings (structured doc)
			if (
				text.length > 800 &&
				/^#{1,3} /.test(text) &&
				(text.match(/\n#{1,3} /g) || []).length >= 2
			)
				continue;
			messages.push(`**User:** ${text}`);
		}
	}

	const extracted = messages.join("\n\n---\n\n");
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
			if (text) messages.push({ role: "assistant", text });
		}

		if (obj.type === "user" && obj.message?.role === "user") {
			const text = flattenContent(obj.message.content).trim();
			if (!text) continue;
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

/**
 * Post-processing optimisations for compacted checkpoint output.
 *
 * Applies information density improvements after extraction:
 * - Strips phatic assistant filler (R4)
 * - Strips operational noise like stats boxes (R3)
 * - Groups consecutive tool notes into single lines (R2)
 * - Detects and strips project root from paths (R1)
 * - Merges bare tool result lines into previous message
 *
 * @module compact-output
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Assistant messages that are ONLY collapsible tool notes. */
const COLLAPSIBLE_NOTE_RE =
	/^\*\*Assistant:\*\* → (?:Read |Grep |Glob |Ran |Write |Serena: (?:find |get |search |list ))/;

/** Phatic assistant filler — must be very specific to avoid stripping real content. */
const PHATIC_RE =
	/^\*\*Assistant:\*\* (?:Confirmed[. —!]|Ready[. —!]|Starting all |Memories checked|Looking at the |Moving on to )/;

// ---------------------------------------------------------------------------
// Noise detection
// ---------------------------------------------------------------------------

/**
 * Operational content that becomes meaningless after checkpoint restore.
 */
function isOperationalNoise(msg) {
	if (!msg.startsWith("**Assistant:**")) return false;
	const text = msg.replace("**Assistant:** ", "");
	if (text.includes("Context Guardian Stats") && text.includes("┌"))
		return true;
	if (text.includes('"success":true') && text.includes("statsBlock"))
		return true;
	if (text.includes("Checkpoint saved") && text.includes("NOT applied"))
		return true;
	if (/^→ Ran `date \+%s`/.test(text)) return true;
	if (/^→ Read .*state-.*\.json/.test(text)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Message compaction
// ---------------------------------------------------------------------------

/**
 * Post-process messages for maximum information density.
 *
 * @param {string[]} messages - The formatted message strings
 * @returns {string[]} Optimised messages
 */
export function compactMessages(messages) {
	if (messages.length === 0) return messages;

	// Strip phatic filler and operational noise
	const filtered = messages.filter((msg) => {
		if (PHATIC_RE.test(msg) && msg.length < 200) return false;
		if (isOperationalNoise(msg)) return false;
		return true;
	});

	// Group consecutive tool notes + merge bare tool lines
	const grouped = [];
	let readBatch = [];

	function flushReads() {
		if (readBatch.length === 0) return;
		if (readBatch.length === 1) {
			grouped.push(readBatch[0]);
		} else {
			const items = readBatch.map((m) =>
				m.replace("**Assistant:** → ", "").replace(/`/g, "").trim(),
			);
			grouped.push(`**Assistant:** → ${items.join("; ")}`);
		}
		readBatch = [];
	}

	for (const msg of filtered) {
		if (COLLAPSIBLE_NOTE_RE.test(msg) && msg.split("\n").length <= 4) {
			readBatch.push(msg);
			continue;
		}

		flushReads();

		const isToolOnly =
			!msg.startsWith("**User:**") &&
			!msg.startsWith("**Assistant:**") &&
			/^[→←]/.test(msg);

		if (isToolOnly && grouped.length > 0) {
			grouped[grouped.length - 1] += `\n${msg}`;
		} else {
			grouped.push(msg);
		}
	}
	flushReads();

	return grouped;
}

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

/**
 * Detect the project root directory from tool_use file paths in the transcript.
 * Scans for Read/Edit/Write/Grep tool inputs and finds the most common
 * directory prefix. Returns it with trailing slash, or empty string.
 */
export function detectProjectRoot(lines, startIdx) {
	const paths = [];
	for (let i = startIdx; i < lines.length; i++) {
		try {
			const obj = JSON.parse(lines[i]);
			if (obj.type !== "assistant" || !Array.isArray(obj.message?.content))
				continue;
			for (const b of obj.message.content) {
				if (b.type !== "tool_use") continue;
				const fp =
					b.input?.file_path || b.input?.path || b.input?.relative_path || "";
				if (fp.startsWith("/") && fp.split("/").filter(Boolean).length >= 3) {
					paths.push(fp);
				}
			}
		} catch {}
	}
	if (paths.length < 3) return "";

	const counts = new Map();
	for (const p of paths) {
		const parts = p.split("/");
		for (let len = 3; len < parts.length; len++) {
			const prefix = parts.slice(0, len).join("/") + "/";
			counts.set(prefix, (counts.get(prefix) || 0) + 1);
		}
	}

	// Longest prefix covering at least 70% of paths
	const maxCount = Math.max(...counts.values());
	const threshold = Math.floor(maxCount * 0.7);
	let best = "";
	for (const [prefix, count] of counts) {
		if (count >= threshold && prefix.length > best.length) {
			best = prefix;
		}
	}
	return best && counts.get(best) >= 3 ? best : "";
}

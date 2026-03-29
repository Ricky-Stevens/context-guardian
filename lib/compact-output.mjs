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
	/^(?:\*\*Assistant:\*\* )?→ (?:Read |Grep |Glob |Ran |Write |Serena: (?:find |get |search |list ))/;

/** Phatic assistant filler — trivial responses that add no recall value. */
const PHATIC_RE =
	/^\*\*Assistant:\*\* (?:Confirmed[. —!]|Ready[. —!]|Starting all |Memories checked|Looking at the |Moving on to |Done[.!]|Got it[.!]|File (?:created|edited)[.!])/;

/** Meta-tool invocations that are infrastructure, not session content. */
const META_TOOL_RE =
	/^→ (?:Tool: `?ToolSearch|Serena: list.memor|Serena: check.onboard)/;

// ---------------------------------------------------------------------------
// Noise detection
// ---------------------------------------------------------------------------

/**
 * Operational content that becomes meaningless after checkpoint restore.
 */
function isOperationalNoise(msg) {
	const isAsst = msg.startsWith("**Assistant:**");
	if (!isAsst && !msg.startsWith("→") && !msg.startsWith("←")) return false;

	const text = msg.replace("**Assistant:** ", "");

	// CG stats boxes
	if (text.includes("Context Guardian Stats") && text.includes("┌"))
		return true;
	if (text.includes('"success":true') && text.includes("statsBlock"))
		return true;
	if (text.includes("Checkpoint saved") && text.includes("NOT applied"))
		return true;
	// CG operational tool calls
	if (/^→ Ran `date \+%s`/.test(text)) return true;
	if (/^→ Read .*state-.*\.json/.test(text)) return true;
	// Meta-tool invocations (ToolSearch, memory checks)
	if (META_TOOL_RE.test(text)) return true;
	if (META_TOOL_RE.test(msg)) return true;
	// Diagnostics JSON output
	if (/^\{?"checks"/.test(text) || /diagnostics\.mjs/.test(text)) return true;
	if (/← \{"checks"/.test(msg)) return true;
	// Bare diagnostics run
	if (/^→ Ran.*diagnostics/.test(text)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Message compaction
// ---------------------------------------------------------------------------

/**
 * Post-process messages for maximum information density.
 * Groups messages into exchanges, strips noise, shortens prefixes,
 * and adds [N] anchors for cross-reference with the Conversation Index.
 *
 * @param {string[]} messages - The formatted message strings
 * @returns {string[]} Optimised exchange blocks (one entry per exchange)
 */
export function compactMessages(messages) {
	if (messages.length === 0) return messages;

	// Phase 1: Strip noise and meta-tool content
	const filtered = messages.filter((msg) => {
		if (PHATIC_RE.test(msg) && msg.length < 200) return false;
		if (isOperationalNoise(msg)) return false;
		return true;
	});

	// Phase 2: Group into exchanges
	// An exchange = one User message + all following Asst/tool messages until next User
	const exchanges = [];
	let current = null;

	for (const msg of filtered) {
		if (msg.startsWith("**User:**")) {
			if (current) exchanges.push(current);
			current = { lines: [msg] };
		} else if (current) {
			// Merge assistant lines: strip redundant prefix on consecutive messages
			if (msg.startsWith("**Assistant:**")) {
				const body = msg.slice(14).trim();
				// Skip empty/trivial assistant messages
				if (
					!body ||
					/^(?:Done\.?|Got it\.?|File (?:created|edited)\.?)$/i.test(body)
				) {
					continue;
				}
				// If previous line was also assistant content, merge without re-prefixing
				const lastLine = current.lines[current.lines.length - 1];
				if (
					lastLine.startsWith("**Assistant:**") ||
					/^[→←]/.test(lastLine) ||
					/^[→←]/.test(lastLine.trim())
				) {
					current.lines.push(body);
				} else {
					current.lines.push(`**Assistant:** ${body}`);
				}
			} else {
				// Tool lines (→, ←) or other content
				current.lines.push(msg);
			}
		} else {
			// Messages before first User (startup noise) — keep but don't anchor
			if (!current) {
				// Only keep if substantive
				if (msg.length > 50 && !isOperationalNoise(msg)) {
					if (!exchanges.length) exchanges.push({ lines: [] });
					exchanges[0].lines.push(msg);
				}
			}
		}
	}
	if (current) exchanges.push(current);

	// Phase 4: Build output with [N] anchors and collapse collapsible tool lines
	const result = [];
	let exchangeNum = 0;

	for (const ex of exchanges) {
		// Count user exchanges for anchoring
		const hasUser = ex.lines.some((l) => l.startsWith("**User:**"));
		if (hasUser) exchangeNum++;

		// Collapse consecutive read-like tool lines into one
		const collapsed = [];
		let toolBatch = [];

		function flushTools() {
			if (toolBatch.length === 0) return;
			if (toolBatch.length === 1) {
				collapsed.push(toolBatch[0]);
			} else {
				const items = toolBatch.map((t) =>
					t.replace(/^→ /, "").replace(/`/g, "").trim(),
				);
				collapsed.push(`→ ${items.join("; ")}`);
			}
			toolBatch = [];
		}

		for (const line of ex.lines) {
			if (
				COLLAPSIBLE_NOTE_RE.test(line) ||
				COLLAPSIBLE_NOTE_RE.test(`Asst: ${line}`)
			) {
				const toolLine = line.startsWith("Asst:") ? line.slice(5).trim() : line;
				if (toolLine.startsWith("→") && toolLine.split("\n").length <= 2) {
					toolBatch.push(toolLine);
					continue;
				}
			}
			flushTools();
			collapsed.push(line);
		}
		flushTools();

		// Skip exchanges that collapsed to nothing
		if (collapsed.length === 0) continue;

		// Build the exchange block with [N] anchor
		const anchor = hasUser ? `[${exchangeNum}] ` : "";
		const firstLine = collapsed[0];
		const rest = collapsed.slice(1);

		// Prepend anchor to first line
		const block = [`${anchor}${firstLine}`, ...rest].join("\n");
		result.push(block);
	}

	return result;
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
			const prefix = `${parts.slice(0, len).join("/")}/`;
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

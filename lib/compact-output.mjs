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
	if (text.startsWith("→ Ran `date +%s`")) return true;
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
// Phase helpers (extracted for cognitive complexity)
// ---------------------------------------------------------------------------

/**
 * Phase 1: Strip noise and meta-tool content.
 * @param {string[]} messages
 * @returns {string[]}
 */
function filterNoise(messages) {
	return messages.filter((msg) => {
		if (PHATIC_RE.test(msg) && msg.length < 200) return false;
		if (isOperationalNoise(msg)) return false;
		return true;
	});
}

/**
 * Classify an assistant message body as trivial (should be skipped).
 * @param {string} body - The text after "**Assistant:** "
 * @returns {boolean}
 */
function isTrivialAssistantBody(body) {
	return (
		!body || /^(?:Done\.?|Got it\.?|File (?:created|edited)\.?)$/i.test(body)
	);
}

/**
 * Decide whether an assistant line should merge without re-prefixing.
 * @param {string} lastLine - Previous line in the exchange
 * @returns {boolean}
 */
function shouldMergeAssistant(lastLine) {
	return (
		lastLine.startsWith("**Assistant:**") ||
		/^[→←]/.test(lastLine) ||
		/^[→←]/.test(lastLine.trim())
	);
}

/**
 * Handle a single assistant message within an exchange.
 * Merges or prefixes based on previous line context.
 * @param {string} msg - The raw message
 * @param {object} current - The current exchange { lines: string[] }
 * @returns {void}
 */
function handleAssistantLine(msg, current) {
	const body = msg.slice(14).trim();
	if (isTrivialAssistantBody(body)) return;

	const lastLine = current.lines.at(-1);
	if (shouldMergeAssistant(lastLine)) {
		current.lines.push(body);
	} else {
		current.lines.push(`**Assistant:** ${body}`);
	}
}

/**
 * Handle a pre-first-user message (startup noise).
 * @param {string} msg
 * @param {object[]} exchanges
 */
function handlePreUserMessage(msg, exchanges) {
	if (msg.length > 50 && !isOperationalNoise(msg)) {
		if (!exchanges.length) exchanges.push({ lines: [] });
		exchanges[0].lines.push(msg);
	}
}

/**
 * Phase 2: Group filtered messages into exchanges.
 * An exchange = one User message + all following Asst/tool messages until next User.
 * @param {string[]} filtered
 * @returns {object[]}
 */
function groupIntoExchanges(filtered) {
	const exchanges = [];
	let current = null;

	for (const msg of filtered) {
		if (msg.startsWith("**User:**")) {
			if (current) exchanges.push(current);
			current = { lines: [msg] };
		} else if (current) {
			if (msg.startsWith("**Assistant:**")) {
				handleAssistantLine(msg, current);
			} else {
				current.lines.push(msg);
			}
		} else {
			handlePreUserMessage(msg, exchanges);
		}
	}
	if (current) exchanges.push(current);
	return exchanges;
}

/**
 * Flush accumulated collapsible tool lines into the collapsed array.
 * @param {string[]} toolBatch - Accumulated tool lines
 * @param {string[]} collapsed - Output array
 */
function flushTools(toolBatch, collapsed) {
	if (toolBatch.length === 0) return;
	if (toolBatch.length === 1) {
		collapsed.push(toolBatch[0]);
	} else {
		const items = toolBatch.map((t) =>
			t.replace(/^→ /, "").replaceAll("`", "").trim(),
		);
		collapsed.push(`→ ${items.join("; ")}`);
	}
}

/**
 * Collapse consecutive collapsible tool lines in an exchange.
 * @param {string[]} lines - Exchange lines
 * @returns {string[]}
 */
function collapseToolLines(lines) {
	const collapsed = [];
	const toolBatch = [];

	for (const line of lines) {
		if (isCollapsibleToolLine(line)) {
			toolBatch.push(extractToolLine(line));
			continue;
		}
		flushTools(toolBatch, collapsed);
		toolBatch.length = 0;
		collapsed.push(line);
	}
	flushTools(toolBatch, collapsed);
	return collapsed;
}

/**
 * Check if a line is a collapsible single-line tool note.
 * @param {string} line
 * @returns {boolean}
 */
function isCollapsibleToolLine(line) {
	if (
		!COLLAPSIBLE_NOTE_RE.test(line) &&
		!COLLAPSIBLE_NOTE_RE.test(`Asst: ${line}`)
	) {
		return false;
	}
	const toolLine = extractToolLine(line);
	return toolLine.startsWith("→") && toolLine.split("\n").length <= 2;
}

/**
 * Extract the tool portion of a line, stripping "Asst:" prefix if present.
 * @param {string} line
 * @returns {string}
 */
function extractToolLine(line) {
	return line.startsWith("Asst:") ? line.slice(5).trim() : line;
}

/**
 * Phase 4: Build output with [N] anchors and collapsed tool lines.
 * @param {object[]} exchanges
 * @returns {string[]}
 */
function buildAnchoredOutput(exchanges) {
	const result = [];
	let exchangeNum = 0;

	for (const ex of exchanges) {
		const hasUser = ex.lines.some((l) => l.startsWith("**User:**"));
		if (hasUser) exchangeNum++;

		const collapsed = collapseToolLines(ex.lines);
		if (collapsed.length === 0) continue;

		const anchor = hasUser ? `[${exchangeNum}] ` : "";
		const firstLine = collapsed[0];
		const rest = collapsed.slice(1);

		const block = [`${anchor}${firstLine}`, ...rest].join("\n");
		result.push(block);
	}

	return result;
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

	const filtered = filterNoise(messages);
	const exchanges = groupIntoExchanges(filtered);
	return buildAnchoredOutput(exchanges);
}

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

/**
 * Collect file paths from tool_use blocks in assistant messages.
 * @param {string[]} lines - Raw JSONL lines
 * @param {number} startIdx - First line to scan
 * @returns {string[]}
 */
function collectToolPaths(lines, startIdx) {
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
	return paths;
}

/**
 * Build a map of directory prefix → occurrence count from a list of paths.
 * @param {string[]} paths
 * @returns {Map<string, number>}
 */
function buildPrefixCounts(paths) {
	const counts = new Map();
	for (const p of paths) {
		const parts = p.split("/");
		for (let len = 3; len < parts.length; len++) {
			const prefix = `${parts.slice(0, len).join("/")}/`;
			counts.set(prefix, (counts.get(prefix) || 0) + 1);
		}
	}
	return counts;
}

/**
 * Select the longest prefix covering at least 70% of paths.
 * @param {Map<string, number>} counts
 * @returns {string}
 */
function selectBestPrefix(counts) {
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

/**
 * Detect the project root directory from tool_use file paths in the transcript.
 * Scans for Read/Edit/Write/Grep tool inputs and finds the most common
 * directory prefix. Returns it with trailing slash, or empty string.
 */
export function detectProjectRoot(lines, startIdx) {
	const paths = collectToolPaths(lines, startIdx);
	if (paths.length < 3) return "";

	const counts = buildPrefixCounts(paths);
	return selectBestPrefix(counts);
}

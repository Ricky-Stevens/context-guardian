# Context Guardian

A Claude Code **plugin** — four hooks + five skills + a shared library. Monitors context window usage via a real-time statusline and provides on-demand compaction tools.

## Critical Rules

### Versioning — bump ALL THREE files or marketplace updates break:
1. `package.json` → `"version"`
2. `.claude-plugin/plugin.json` → `"version"`
3. `.claude-plugin/marketplace.json` → `plugins[0].version`

### Key Conventions
- Session flags (`.claude/cg-*`) live in the **project's** `.claude/` dir, not plugin data — they're project-scoped and cleaned by SessionStart.
- `.context-guardian/` at the project root holds user-visible artifacts (handoffs, checkpoint copies). Project-scoped, gitignored.
- `${CLAUDE_PLUGIN_DATA}` (fallback `~/.claude/cg/`) holds plugin-internal state (config, session state, checkpoints, synthetic session manifest).
- Skills invoke CLI entry points (`compact-cli.mjs`) via Bash because skills don't fire `UserPromptSubmit`.
- Compaction and handoff automatically create synthetic JSONL sessions so `/resume cg` or `/resume cg:{label}` loads checkpoints as real conversation messages.

## Statusline — Primary UX

The statusline is CG's main communication channel. It shows real-time context usage in the terminal status bar with threshold-relative color coding:
- **Green:** well below threshold (`pct < threshold * 0.7`)
- **Yellow:** approaching threshold (`pct < threshold`)
- **Bold red:** at/past threshold (`pct >= threshold`) — shows "compaction recommended — /cg:compact"

The session-start hook auto-configures the statusline and **reclaims it** if overwritten by another tool. The diagnostics check flags a missing CG statusline as a failure.

## How The Submit Hook Works

1. Every user message → submit hook reads real token counts from `message.usage` in the transcript JSONL. Falls back to byte estimation only on the very first message.
2. Writes token state to `state-{sessionId}.json` — consumed by `/cg:stats` and the statusline.
3. Handles manual compaction (`/cg:compact`, `/cg:prune`) via flag files or direct command detection.
4. `/` messages bypass the hook entirely.

No blocking, no menus, no cooldowns. The statusline handles all context pressure communication.

## Compaction Design

**Noise removal, not summarisation. Never lose context. No LLM involved — deterministic string processing.**

### What stays (decision-relevant)
- All user text (except affirmative confirmations like "yes", "ok")
- All assistant reasoning text
- Edit/Write diffs (start+end trim if >3K)
- Bash commands + output (start+end trim if >5K)
- AskUserQuestion answers, WebSearch results, Serena write tools, sequential thinking, agent results, all errors

### What's removed (re-obtainable / noise)
- File read results (Read/Grep/Glob) — dominant bloat, 30-50% of tokens
- Thinking/redacted_thinking blocks
- System/progress messages, Edit/Write success results
- Serena read/query results, context-mode results, Serena memory results

### Truncation
Never chop at a point. Start+end trim: keep first N chars (intent) + last N chars (outcome), mark middle with `[...N chars trimmed from middle...]`.

### Skip rules for user messages
- Slash commands, CG menu replies (0-4, cancel), compact markers, affirmative confirmations, system injections → skip
- "no", "n", bare numbers → KEEP (decisions)
- Long structured user messages → KEEP regardless of size

### Smart Compact vs Keep Recent
- Smart Compact: all messages after last compaction boundary, with tiered compression and edit coalescing
- Keep Recent: last 10 user exchanges (grouped with responses), same extraction engine

## Session Handoff & Resume

- `/cg:handoff [name]` → extracts conversation (same as Smart Compact), writes to `.context-guardian/cg-handoff-{slug}-{datetime}.md`
- Both `/cg:compact` and `/cg:handoff` automatically create synthetic JSONL sessions in Claude Code's session directory
- User restores via native `/resume cg` (for compaction) or `/resume cg:{label}` (for handoff)
- No custom resume skill — leverages Claude Code's built-in `/resume` which calls `setMessages()` to replace the conversation
- The synthetic session contains the checkpoint as a real user message (not `additionalContext`), giving higher attention fidelity
- A manifest (`synthetic-sessions.json` in plugin data dir) tracks one synthetic session per title, cleaning up the previous one on each write
- Compaction checkpoints are also copied to `.context-guardian/cg-checkpoint-*.md` for user visibility
- `rotateFiles` sorts by mtime (not filename) because label-prefixed filenames break alphabetical chronological ordering

## Token Counting

1. **Real counts (preferred):** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from `message.usage` in transcript JSONL. Written by both submit and stop hooks.
2. **Byte estimation (fallback):** First message only. Content bytes / 4.
3. **Baseline overhead:** Stop hook captures on first response — irreducible floor (system prompts, tools, CLAUDE.md). Used in all savings estimates.

## Transcript JSONL Format

Each line is JSON. Types: `user`, `assistant`, `system`, `progress`. User messages have `message.role === "user"` and `message.content` (string or array of text/tool_result/image/document blocks). Assistant messages have content arrays (text/tool_use/thinking blocks). Tool results link back via `tool_use_id`. The extraction engine uses a `Map<tool_use_id, {name, input}>` to classify results by originating tool.

## Testing

```bash
bun test                        # all tests
bun test test/handoff.test.mjs  # handoff/resume tests only
tail -f ~/.claude/logs/cg.log   # watch hook activity
```

## Testing
1. All tests must pass before recommending a push
2. Code must remain above 80% code coverage on lines, functions, statements and branches
3Biome linting must pass before recommending a push

## SonarQube Quality Gate

1. Before recommending a push, run `sonar-scanner` using `source .env.local`.
2. After scanning, use SonarQube MCP tools to check Quality Gate status. 
3. If issues are flagged, fix holistically (not one rule at a time) and re-scan. Max 3 fix-scan cycles.
4. If issues persist after 3 cycles, stop and report remaining issues with analysis.
5. Only recommend pushing when the Quality Gate PASSES.   
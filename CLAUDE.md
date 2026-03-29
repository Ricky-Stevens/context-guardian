# Context Guardian

A Claude Code **plugin** — four hooks + six skills + a shared library. Monitors context window usage and intervenes before quality degrades.

## Critical Rules

### Versioning — bump ALL THREE files or marketplace updates break:
1. `package.json` → `"version"`
2. `.claude-plugin/plugin.json` → `"version"`
3. `.claude-plugin/marketplace.json` → `plugins[0].version`

### Key Conventions
- Session flags (`.claude/cg-*`) live in the **project's** `.claude/` dir, not plugin data — they're project-scoped and cleaned by SessionStart.
- `.context-guardian/` at the project root holds user-visible artifacts (handoffs, checkpoint copies). Project-scoped, gitignored.
- `${CLAUDE_PLUGIN_DATA}` (fallback `~/.claude/cg/`) holds plugin-internal state (config, session state, reload/resume/cooldown pointers, checkpoints).
- The `{hash}` in filenames like `reload-{hash}.json` is a short SHA-256 of the project cwd for multi-project isolation.
- Skills invoke CLI entry points (`compact-cli.mjs`, `resume-cli.mjs`) via Bash because skills don't fire `UserPromptSubmit`.

## How The Warning Hook Works

1. Every user message → submit hook reads real token counts from `message.usage` in the transcript JSONL. Falls back to byte estimation only on the very first message.
2. Model auto-detected from transcript — Opus 4.6+ = 1M, all others = 200K.
3. If `pct >= threshold` AND `cg-warned` flag absent AND no cooldown active → block with menu (1-4).
4. If `pct < threshold` → clear warned flag (so it can re-fire later).
5. `/` messages bypass the hook entirely.
6. Menu: **1** Continue (replay original prompt, 2-min cooldown), **2** Smart Compact, **3** Keep Recent, **4** Clear.
7. After compaction (2/3): user types `/clear`, checkpoint auto-restores. `resume` replays original prompt.
8. Cooldown (2 min) prevents re-trigger. Cleared on `/clear` restore and new sessions.

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

### Checkpoint injection framing
After `/clear`, injected as `additionalContext` with framing: "preserved record, NOT a summary, re-obtainable noise stripped, all decisions preserved." Includes re-read guardrail.

## Session Handoff & Resume

- `/cg:handoff [name]` → extracts conversation (same as Smart Compact), writes to `.context-guardian/cg-handoff-{slug}-{datetime}.md`
- `/cg:resume` → scans `.context-guardian/` for handoffs, shows numbered menu. `/cg:resume all` includes checkpoints too.
- Opt-in restore — new sessions start fresh unless user runs `/cg:resume`
- Compaction checkpoints are also copied to `.context-guardian/cg-checkpoint-*.md` for visibility
- `rotateFiles` sorts by mtime (not filename) because label-prefixed filenames break alphabetical chronological ordering
- `resume-cli.mjs load` validates path is within `.context-guardian/` (path traversal guard)

## Token Counting

1. **Real counts (preferred):** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from `message.usage` in transcript JSONL. Written by both submit and stop hooks.
2. **Byte estimation (fallback):** First message only. Content bytes / 4.
3. **Baseline overhead:** Stop hook captures on first response — irreducible floor (system prompts, tools, CLAUDE.md). Used in all savings estimates.

## Transcript JSONL Format

Each line is JSON. Types: `user`, `assistant`, `system`, `progress`. User messages have `message.role === "user"` and `message.content` (string or array of text/tool_result/image/document blocks). Assistant messages have content arrays (text/tool_use/thinking blocks). Tool results link back via `tool_use_id`. The extraction engine uses a `Map<tool_use_id, {name, input}>` to classify results by originating tool.

## Testing

```bash
bun test                        # 493 tests across 16 files
bun test test/handoff.test.mjs  # handoff/resume tests only
tail -f ~/.claude/logs/cg.log   # watch hook activity
```

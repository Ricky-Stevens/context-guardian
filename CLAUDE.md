# Context Guardian

## What This Project Is

A Claude Code **plugin** that monitors context window usage and intervenes before quality degrades. Installed from GitHub with `/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian
/plugin install context-guardian`.

Three hooks + four skills + a shared library.

## Plugin Structure

```
context-guardian/
  .claude-plugin/plugin.json       # Plugin manifest (hooks + skills)
  package.json                     # npm distribution
  hooks/
    submit.mjs                     # UserPromptSubmit — main hook (dispatch only)
    session-start.mjs              # SessionStart — flag cleanup
    stop.mjs                       # Stop — writes fresh token state after each response
  lib/
    paths.mjs                      # Centralized path resolution (CLAUDE_PLUGIN_DATA)
    logger.mjs                     # Shared logging
    config.mjs                     # Config load/save, defaults
    content.mjs                    # flattenContent, contentBytesOf
    tokens.mjs                     # Token estimation + real state
    transcript.mjs                 # extractConversation, extractRecent (extraction flow)
    extract-helpers.mjs            # Content block processing, skip rules, state header
    tool-summary.mjs               # Built-in tool summarisation rules
    mcp-tools.mjs                  # MCP tool rules (Serena, Sequential Thinking, etc.)
    trim.mjs                       # startEndTrim, error/confirmation detection
    checkpoint.mjs                 # Shared compaction pipeline, checkpoint validation
    reload-handler.mjs             # Checkpoint reload + resume after /clear
    stats.mjs                      # Compaction stats formatting
  skills/
    status/SKILL.md                # /context-guardian:status
    config/SKILL.md                # /context-guardian:config
    compact/SKILL.md               # /context-guardian:compact
    prune/SKILL.md                 # /context-guardian:prune
```

## Key Paths

| Path | Purpose |
|------|---------|
| `${CLAUDE_PLUGIN_DATA}/config.json` | Config (threshold, max_tokens) |
| `${CLAUDE_PLUGIN_DATA}/state-{session_id}.json` | Real token counts (written by both submit and stop hooks) |
| `${CLAUDE_PLUGIN_DATA}/reload-{hash}.json` | Checkpoint injection trigger after /clear (project-scoped) |
| `${CLAUDE_PLUGIN_DATA}/resume-{hash}.json` | Original prompt for `resume` replay (project-scoped) |
| `${CLAUDE_PLUGIN_DATA}/checkpoints/` | Saved compaction checkpoints |
| `.claude/cg-warned-{session_id}` | Per-session "already warned" flag |
| `.claude/cg-menu-{session_id}` | Signals we're waiting for a menu reply |
| `.claude/cg-prompt-{session_id}` | Stores the user's original blocked prompt |
| `~/.claude/logs/context-guardian.log` | All hook activity |

Fallback when `CLAUDE_PLUGIN_DATA` is unset: `~/.claude/context-guardian/`.

Session flags live in the **project's** `.claude/` dir (not plugin data) so they are project-scoped and cleaned by SessionStart.

## Skills

| Command | Purpose |
|---------|---------|
| `/context-guardian:status` | Show current token usage, threshold, headroom, recommendation |
| `/context-guardian:config` | View/update threshold and max_tokens |
| `/context-guardian:config threshold 0.50` | Change threshold |
| `/context-guardian:config max_tokens 1000000` | Change max tokens |
| `/context-guardian:config reset` | Reset to defaults |
| `/context-guardian:compact` | Run Smart Compact on demand |
| `/context-guardian:prune` | Run Keep Recent (last 10 exchanges) on demand |

## How The Warning Hook Works

1. Every user message → submit hook reads real token counts from `message.usage` in the transcript JSONL (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`). Falls back to byte estimation only on the very first message before any assistant response.
2. Model auto-detected from transcript (`message.model`) — Opus 4.6+ = 1M, all others = 200K.
3. If `pct >= threshold` AND `cg-warned` flag absent AND no cooldown active:
   - Write flags (`cg-warned`, `cg-menu`, `cg-prompt`)
   - Return `decision: "block"` with the menu
4. If `pct < threshold` → clear warned flag (so it can re-fire later)
5. Messages starting with `/` bypass the hook (but if a reload checkpoint is pending, a state file preview is written so `/context-guardian:status` works)
6. Menu reply (1/2/3/4):
   - **1 Continue** — clear warned flag, set 2-min cooldown, replay original prompt via `additionalContext`
   - **2 Smart Compact** — extract full history with tool-aware processing, save checkpoint, show stats via `decision: "block"`, set cooldown
   - **3 Keep Recent** — take last 10 user exchanges (grouped with responses), save checkpoint, show stats via `decision: "block"`, set cooldown
   - **4 Clear** — tell user to `/clear`, set cooldown
7. After compaction (2/3): user types `/clear`, checkpoint auto-restores. Typing `resume` replays original prompt.
8. Cooldown (2 min) prevents re-trigger after compaction or continue. Cleared on `/clear` restore and new sessions.

## Manual Compact (skills)

The submit hook detects `/context-guardian:compact` and `/context-guardian:prune` directly from the prompt and runs compaction immediately — no intermediate flag file or extra user message needed. The skill SKILL.md files instruct Claude to display the stats from `additionalContext`. Same compaction engine as the warning menu options 2/3. Manual compactions use `additionalContext` (not `decision: "block"`) so Claude Code doesn't show "Original prompt:".

No original prompt stored (manual trigger, not blocking a message).

## Compaction Design — Core Principles

**Noise removal, not summarisation. Never lose context.**

Both Smart Compact and Keep Recent use the same tool-aware extraction engine. The approach removes re-obtainable and disposable data while keeping all decision-relevant content in full fidelity. No LLM is involved in extraction — it's deterministic string processing.

### What gets KEPT (decision-relevant content)

| Content | Treatment |
|---------|-----------|
| User text messages | Full — never dropped (except affirmative confirmations like "yes", "ok") |
| User rejections ("no") and numbered choices | Full — these are decisions |
| Assistant text reasoning | Full |
| Edit/Write diffs (old_string → new_string) | Full, or start+end trim if >3K chars |
| Bash commands + output | Full, or start+end trim if >5K chars |
| AskUserQuestion answers (tool_result) | Always full — user decision channel |
| WebSearch results | Full, or start+end trim if >5K (ephemeral, can't re-fetch) |
| Serena write tools (replace_symbol_body, insert) | Code body preserved like Edit diffs |
| Sequential thinking (thought chain) | Full, or start+end trim if >2K per thought |
| Agent results | Full, or start+end trim if >2K |
| Error responses from any tool | Always kept |

### What gets REMOVED (noise / re-obtainable)

| Content | Why |
|---------|-----|
| File read results (Read/Grep/Glob tool_results) | Re-obtainable from disk — the dominant bloat (30-50% of tokens) |
| Thinking / redacted_thinking blocks | Internal reasoning, redundant with assistant text |
| System / progress messages | Infrastructure noise |
| Edit/Write success results | Just "success" — assistant text covers it |
| Serena read/query results | Re-obtainable |
| Context-mode results | Sandbox-internal; assistant text has the summary |
| Serena memory results | Externally persisted |

### Universal truncation: start+end trim

When content exceeds its size limit, we NEVER chop at a point. We keep the first N chars (intent) and last N chars (outcome), trimming only the middle with a marker `[...N chars trimmed from middle...]`. This preserves the narrative thread because results/conclusions appear at the end.

### Smart Compact specifics

- Processes ALL messages after the last compaction boundary
- Preserves one level of prior compacted history as a preamble (start+end trimmed at 30K)
- Generates a `## Session State` header at the top with goal, files modified, last action
- Output format: `**User:**`/`**Assistant:**` prefixes with `→` tool summaries and `←` results interleaved

### Keep Recent specifics

- Counts by **user exchanges**, not flat messages. N=10 means last 10 user messages, each grouped with all assistant responses, tool summaries, and tool results that follow
- State header computed from windowed content only (not full session)
- Same tool-aware processing as Smart Compact within each exchange

### Checkpoint injection framing

After `/clear`, the checkpoint is injected as `additionalContext` with this framing (NOT "summary"):
> "The following is a preserved record of the prior conversation with noise removed. Tool outputs that can be re-obtained (file reads, search results) were stripped. All user messages, assistant reasoning, code changes, and command outputs are preserved verbatim."

Includes a re-read guardrail: "You have NOT read any files in this session — re-read any file before referencing its contents or making further edits."

### Skip rules for user messages

- Slash commands → skip (meta-operations)
- CG menu replies (0-4, cancel) → skip
- Compact markers → skip
- Affirmative confirmations (yes, ok, sure, continue, etc.) → skip
- Known system injections (checkpoint restores, skill injections) → skip
- "no", "n", bare numbers → KEEP (decisions, not confirmations)
- Long structured user messages → KEEP regardless of size (never drop user content for size)

### Content block placeholders

- `type: "image"` → `[User shared an image]`
- `type: "document"` → `[User shared a document: {filename}]`
- Unknown block types → `[Unknown content block: {type}]`

## Config

`${CLAUDE_PLUGIN_DATA}/config.json`:
```json
{ "threshold": 0.35, "max_tokens": 200000 }
```

`max_tokens` auto-updates from the API via the Stop hook. Config value is the initial fallback only.

## Token Counting

1. **Real counts (preferred):** Both the submit and stop hooks read `message.usage` from the most recent assistant message in the transcript JSONL (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`) and write the result to `state-{session_id}.json`. The stop hook runs after each response, so state is always up-to-date.
2. **Byte estimation (fallback):** Content bytes after the last compact marker, divided by 4.
3. **Post-compaction estimates:** After compaction or reload injection, a state file is written with estimated token counts so `/context-guardian:status` works immediately.

## Testing

```bash
# Local plugin testing
claude --plugin-dir /path/to/context-guardian

# Low threshold for testing
/context-guardian:config threshold 0.01

# Reset to production
/context-guardian:config reset

# Clear session flags
rm -f <project-dir>/.claude/cg-*

# Watch logs
tail -f ~/.claude/logs/context-guardian.log
```

## Transcript JSONL Format

Each line is a JSON object. Relevant `type` values: `user`, `assistant`, `system`, `progress`.

- User message: `message.content` is string or array of content blocks
- Assistant message: `message.content` is array — extractConversation keeps only `type: "text"` blocks

## Versioning

Version must be bumped in **three files** for marketplace updates to work:

1. `package.json` → `"version"`
2. `.claude-plugin/plugin.json` → `"version"`
3. `.claude-plugin/marketplace.json` → `plugins[0].version`

If any of these are out of sync, the marketplace will think the installed version is current and refuse to update.

## Distribution

```bash
# Install from GitHub
/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian
/plugin install context-guardian

# Update (uninstall + reinstall, then start new session)
/plugin uninstall context-guardian
/plugin install context-guardian
```

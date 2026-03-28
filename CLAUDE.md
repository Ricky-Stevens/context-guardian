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
    submit.mjs                     # UserPromptSubmit — main logic
    session-start.mjs              # SessionStart — flag cleanup
    stop.mjs                       # Stop — writes fresh token state after each response
  lib/
    paths.mjs                      # Centralized path resolution (CLAUDE_PLUGIN_DATA)
    logger.mjs                     # Shared logging
    config.mjs                     # Config load/save, defaults
    content.mjs                    # flattenContent, contentBytesOf
    tokens.mjs                     # Token estimation + real state
    transcript.mjs                 # extractConversation, extractRecent
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

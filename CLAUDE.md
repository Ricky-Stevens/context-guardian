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
    stop.mjs                       # Stop — session logging
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
| `${CLAUDE_PLUGIN_DATA}/state.json` | Real token counts from submit hook |
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
| `/context-guardian:prune` | Run Keep Recent 20 on demand |

## How The Warning Hook Works

1. Every user message → submit hook reads real token counts from `message.usage` in the transcript JSONL (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`). Falls back to byte estimation only on the very first message before any assistant response.
2. Model auto-detected from transcript (`message.model`) — Opus 4.6+ = 1M, all others = 200K.
3. If `pct >= threshold` AND `cg-warned` flag absent AND no cooldown active:
   - Write flags (`cg-warned`, `cg-menu`, `cg-prompt`)
   - Return `decision: "block"` with the menu
4. If `pct < threshold` → clear warned flag (so it can re-fire later)
5. Messages starting with `/` always bypass the hook (slash commands never blocked)
6. Menu reply (1/2/3/4):
   - **1 Continue** — clear warned flag, set 2-min cooldown, replay original prompt via `additionalContext`
   - **2 Smart Compact** — extract full history, save checkpoint, show stats via `decision: "block"`, set cooldown
   - **3 Keep Recent** — take last 20 messages, save checkpoint, show stats via `decision: "block"`, set cooldown
   - **4 Clear** — tell user to `/clear`, set cooldown
7. After compaction (2/3): user types `/clear`, checkpoint auto-restores. Typing `resume` replays original prompt.
8. Cooldown (2 min) prevents re-trigger after compaction or continue. Cleared on `/clear` restore and new sessions.

## Manual Compact (skills)

`/context-guardian:compact` writes `smart` to the `cg-compact-{session_id}` flag. `/context-guardian:prune` writes `recent`. On the next user message, submit hook reads the mode from the flag and runs the compaction immediately — same engine as the warning menu options 2/3.

No original prompt stored (manual trigger, not blocking a message).

## Config

`${CLAUDE_PLUGIN_DATA}/config.json`:
```json
{ "threshold": 0.35, "max_tokens": 200000 }
```

`max_tokens` auto-updates from the API via the Stop hook. Config value is the initial fallback only.

## Token Counting

1. **Real counts (preferred):** Submit hook reads `message.usage` from the most recent assistant message in the transcript JSONL (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`) and writes the result to `state.json`.
2. **Byte estimation (fallback):** Content bytes after the last compact marker, divided by 4.

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

## Distribution

```bash
# Install from GitHub
/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian
/plugin install context-guardian

# Update (re-run install, then start new session)
/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian
/plugin install context-guardian
```

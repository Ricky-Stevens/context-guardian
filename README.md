# Context Guardian

[![CI](https://github.com/Ricky-Stevens/context-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/context-guardian/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-2.1.0-blue)](https://github.com/Ricky-Stevens/context-guardian/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_context-guardian&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_context-guardian)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_context-guardian&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_context-guardian)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**Automatic context window monitoring and smart compaction for Claude Code. Zero dependencies.**

Context Guardian watches your context window usage in real time via a statusline and provides on-demand compaction tools. When usage crosses a configurable threshold, the statusline turns red and recommends compaction - preserving your work and keeping Claude sharp.

Distributed as a **Claude Code plugin** - it's called "cg" due to how Claude Code namespaces skills. `/cg:stats` is easier to type than `/context-guardian:stats`.

---

## Install

```bash
/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian
/plugin install cg
```

**Note:** Claude's `/reload-plugins` can be a bit sketchy - try opening a new session if you hit issues.

### Update

To pull the latest version:

1. Open `/plugins`
2. Go to **Marketplaces** tab → select the context-guardian marketplace → **Update marketplace**
3. Inside the marketplace, go to **Browse Plugins** → select cg → **Update**
4. Run `/reload-plugins` or restart your session

### Uninstall

```bash
/plugin uninstall cg
```

### Local development

```bash
claude --plugin-dir /path/to/cg
```

---

## Commands

Context Guardian adds five slash commands:

### `/cg:stats`

Shows current token usage, session size, compaction estimates, and recommendations.

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  Current usage:   372,000 / 1,000,000 tokens (37.2%)
│  Session size:    8.4MB / 20MB
│  Threshold:       30% (0% remaining to warning)
│  Data source:     real counts
│
│  Model:           claude-opus-4-6 / 1,000,000 tokens
│  Last updated:    12 seconds ago
│
│  /cg:compact         ~37.2% → ~5%
│  /cg:prune           ~37.2% → ~3%
│
│  /cg:handoff [name]  save session for later
│
└─────────────────────────────────────────────────
```

### `/cg:config`

```bash
/cg:config                     # show current config + detected model/limit
/cg:config threshold 0.50      # override adaptive threshold with fixed 50%
/cg:config max_tokens 1000000  # override detected token limit
/cg:config reset               # restore adaptive defaults
```

### `/cg:compact`

Runs Smart Compact - a deterministic extraction engine that removes re-obtainable noise (file reads, grep results, thinking blocks, system messages) while preserving everything that matters: user messages, assistant reasoning, edit diffs, bash commands and output, user decisions, and errors. Typically achieves 70-90% reduction.

After compaction, use `/resume cg:[4-char hash]` to restore the checkpoint.

### `/cg:prune`

Keeps the last 10 user exchanges (each grouped with their assistant responses and tool summaries). Uses the same extraction engine as Smart Compact. Good when only recent work matters.

After pruning, use `/resume cg:[4-char hash]` to restore.

### `/cg:handoff`

Save your current session context for cross-session continuity. Uses the same extraction engine as Smart Compact.

```bash
/cg:handoff                    # save without a label
/cg:handoff my auth refactor   # save with a custom name
```

Handoff files are saved to `.context-guardian/` in your project root. Add this directory to your `.gitignore`.

To restore a handoff in a future session:

```bash
/resume cg:my-auth-refactor   # restore a specific handoff by label
/resume                       # browse all sessions including CG handoffs
```

---

## The Problem: Context Rot

LLMs have a fixed context window - the total amount of text they can "see" at once. Claude Code sessions accumulate context rapidly: every message you send, every file Claude reads, every tool call and its output, every thinking block - it all stacks up.

When the context window fills:

- **The U-Shape.** Models perform best with information at the beginning or end of context. As the prompt grows, the middle gets less attention.
- **Claude starts forgetting.** Earlier instructions, architectural decisions, and code context silently drop out of the effective attention window. Claude doesn't tell you it's forgotten - it just stops using that information.
- **Quality degrades gradually.** You won't get an error. Responses become less coherent, less grounded in your codebase, and more likely to hallucinate.
- **Native `/compact` is destructive.** When Claude Code hits ~95% usage, it summarizes everything into a brief paragraph, destroying the accumulated context.
- **The 20MB wall.** Separately from the token limit, the API has a ~20MB request payload size limit. When your session's raw data exceeds this, the API rejects the request entirely — you can't send messages, can't compact, can't do anything except `/clear` and lose everything. Context Guardian tracks session size alongside token usage to warn you before you hit this hard wall.

Context rot is insidious because **it's invisible**. You don't know Claude has forgotten something until the output is wrong.

### Why This Matters More on Opus 4.6

Opus 4.6 has a **1,000,000 token context window** - 5x larger than the previous 200K. This sounds like a pure advantage, but it creates a unique problem:

- **Sessions last longer.** With 1M tokens, you can work for hours without hitting the limit. This means more accumulated context, more tool outputs, more file reads - and more opportunity for subtle quality degradation.
- **The degradation is slower but deeper.** On Sonnet, you hit the wall at 200K and are forced to compact relatively quickly. On Opus, you can drift into the 40-60% range where quality is noticeably degraded but you haven't hit any hard limit.
- **Cost scales with context.** Every API call sends the full context window. At 500K tokens, each message costs significantly more than at 50K. Compacting early saves money.
- **Compaction quality depends on what's in context.** At 35%, Claude's full conversation is in sharp focus - it can produce a high-fidelity extraction. At 70%, earlier context is already fuzzy.

The 1M window is powerful, but it requires active management. Context Guardian provides that management.

---

## Adaptive Threshold

Context Guardian's compaction threshold **scales automatically with the context window size**. Different window sizes need different thresholds — 35% of 200K is very different from 35% of 1M.

| Window | Default Threshold | Alert At | Rationale |
|--------|------------------|----------|-----------|
| **200K** | 55% | ~110K tokens | System overhead is 25-45K tokens, so a higher threshold maximises usable conversation space |
| **500K** | 46% | ~230K tokens | Balanced — quality is still strong, plenty of room before auto-compact |
| **1M** | 30% | ~300K tokens | Context rot research shows measurable quality degradation at 80-150K tokens regardless of window size. A lower threshold catches this earlier. |

Override with `/cg:config threshold <value>` if the adaptive default doesn't suit your workflow.

### Why These Numbers?

Research on LLM attention patterns shows a **U-shaped attention curve** — models attend strongly to the beginning and end of context, with weaker attention in the middle. Quality degrades gradually, not at a cliff:

| Usage Range | Model Behavior |
|-------------|---------------|
| **0-25%** | Full attention across all content. Maximum recall and coherence. |
| **25-40%** | Still strong. The "middle" is small enough that attention covers it well. |
| **40-60%** | Noticeable degradation. Middle content gets less attention. Early instructions may be partially forgotten. |
| **60-80%** | Significant degradation. Claude may contradict earlier decisions, forget constraints, or hallucinate details about code it read earlier. |
| **80-95%** | Critical zone. Effective context is much smaller than the raw number suggests. |
| **95%+** | Emergency auto-compact fires. Everything reduced to a brief summary. |

The adaptive threshold places the alert at the boundary between "strong recall" and "beginning to degrade" for each window size.

### What Actually Fills the Context

In a typical Claude Code session, your actual conversation - what you typed and what Claude replied - is only **30-40% of total context**. The rest is:

- **Tool outputs (40-50%):** File reads, grep results, command output. A single large file read can consume 10-20K tokens.
- **System prompts (~5%):** CLAUDE.md, plugin instructions, skill descriptions, MCP server configs.
- **Tool calls and thinking (10-15%):** The structured blocks that Claude generates internally.

Smart Compact strips the re-obtainable noise and keeps the decision-relevant content. That's why it typically achieves **70-90% reduction** - most of the context is tool infrastructure, not your actual work.

## How It Works

### Compaction Engine

Context Guardian uses a **deterministic string-processing engine** - no LLM is involved in extraction. It removes re-obtainable and disposable data while keeping all decision-relevant content at full fidelity.

**What stays (decision-relevant):**
- All user text messages (except affirmative confirmations like "yes", "ok")
- All assistant reasoning text
- Edit/Write diffs (start+end trimmed if >3K chars)
- Bash commands and output (start+end trimmed if >5K chars)
- User answers to questions (AskUserQuestion results)
- Web search results, Serena write operations, sequential thinking chains
- Agent results, all error responses

**What's removed (re-obtainable / noise):**
- File read results (Read, Grep, Glob) - the dominant bloat at 30-50% of tokens
- Thinking and redacted_thinking blocks
- System and progress messages
- Edit/Write success confirmations (just "success")
- Serena read/query results, context-mode results

**Truncation:** When content exceeds its size limit, it's never chopped at a point. Start+end trim keeps the first N chars (intent) and last N chars (outcome), replacing only the middle with `[...N chars trimmed from middle...]`. This preserves the narrative thread because conclusions appear at the end.

### Token Counting

Context Guardian reads **actual token counts** from Claude Code's transcript. Every assistant message includes a `usage` object:

```json
{
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 920,
    "cache_read_input_tokens": 133868,
    "output_tokens": 85
  }
}
```

**Context used = `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`**

These are the real values from the Anthropic API - the same numbers that determine your bill. On the first message of a session (before any assistant response exists), the plugin falls back to a byte-based estimate until real data is available.

### How Restore Works

After compaction or handoff, Context Guardian writes a **synthetic JSONL session** to Claude Code's session directory. This session contains the checkpoint as a real user message with a custom title (e.g., `cg` or `cg:my-feature`).

When you type `/resume cg:{hash}`, Claude Code's native resume mechanism finds and loads this synthetic sessions, replacing the current conversation with the checkpoint content. Because it's a real user message (not injected context), the model gives it full attention.

The flow:
1. Run `/cg:compact`, `/cg:prune`, or `/cg:handoff [name]` - checkpoint saved + synthetic session created
2. Type `/resume cg:{hash}` (or `/resume cg:{label}` for handoffs) - context restored

---

## Architecture

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| `submit.mjs` | `UserPromptSubmit` | Writes token usage + payload size state for statusline and `/cg:stats` on every user message |
| `session-start.mjs` | `SessionStart` | Cleans stale session flags, auto-configures statusline, self-healing marketplace clone |
| `stop.mjs` | `Stop` | Writes fresh token state after each assistant response. Captures baseline overhead on first response. |
| `precompact.mjs` | `PreCompact` | Injects CG's extraction as additional context into Claude Code's native `/compact` |

### Skills

Skills invoke `compact-cli.mjs` via Bash (since skills don't fire `UserPromptSubmit`). The CLI sets `CLAUDE_PLUGIN_DATA`, runs the extraction pipeline, and outputs JSON for the skill to display.

| Skill | Entry Point |
|-------|-------------|
| `/cg:stats` | `lib/diagnostics.mjs` (health checks) + state file read |
| `/cg:config` | Direct config file read/write |
| `/cg:compact` | `lib/compact-cli.mjs smart` → `checkpoint.mjs:performCompaction()` |
| `/cg:prune` | `lib/compact-cli.mjs recent` → `checkpoint.mjs:performCompaction()` |
| `/cg:handoff` | `lib/compact-cli.mjs handoff` → `handoff.mjs:performHandoff()` |

### Token Counting

Two methods, preferring the more accurate. State is written by **both** the submit hook (before the response) and the stop hook (after the response), so `/cg:stats` always reflects the latest counts.

1. **Real counts (preferred):** Reads `message.usage` from the most recent assistant message in the transcript JSONL. Calculates `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.

2. **Byte estimation (fallback):** Only used on the very first message of a session (before any assistant response). Counts content bytes after the most recent compact marker and divides by 4.

3. **Post-compaction estimates:** After compaction or checkpoint restore, a state file is written with estimated post-compaction token counts so `/cg:stats` works immediately.

### Baseline Overhead

On the first assistant response of each session, the stop hook captures the current token count as `baseline_overhead` - at that point, context is almost entirely system prompts, CLAUDE.md, and tool definitions. This measured value serves as an irreducible floor in all compaction savings estimates.

### Statusline

Context Guardian auto-configures a terminal statusline on first session start. It shows real-time context usage and session size:

```
Context usage: 3% | Session size: 0.4/20MB | /cg:stats for more
```

Two independent metrics with independent color schemes:

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Context usage | Well below threshold | Approaching threshold | At/past threshold |
| Session size | < 10MB | 10–15MB | ≥ 15MB |

In green/yellow states, labels are dim/grey with only the numbers colored. At red, the entire label+number goes bold red for maximum visibility.

**Session size** tracks the estimated API request payload — transcript file size plus system overhead (prompts, tools, CLAUDE.md). The ~20MB API payload limit is separate from the token context window and can lock you out of a session entirely.

The session-start hook **reclaims the statusline** if another tool overwrites it, logging a warning and notifying the user via `additionalContext`.

### Model & Token Limit Detection

Context Guardian automatically detects the actual context window size and model for the current session. The detected values update immediately when you switch models via `/model`. You can override with `/cg:config max_tokens <value>` if needed.

### Data Storage

All persistent data lives in the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`, typically `~/.claude/plugins/data/cg/`):

| File | Purpose |
|------|---------|
| `config.json` | Threshold and max_tokens override |
| `state-{session_id}.json` | Latest token counts, payload bytes, model, transcript path (session-scoped) |
| `checkpoints/` | Saved compaction checkpoints (markdown) |
| `synthetic-sessions.json` | Manifest tracking synthetic JSONL sessions for `/resume` |

Each project also has a `.context-guardian/` directory at its root:

| File | Purpose |
|------|---------|
| `cg-handoff-[name]-{datetime}.md` | Session handoff files (from `/cg:handoff`) |
| `cg-checkpoint-{datetime}.md` | Copies of compaction checkpoints for visibility |

These files are project-scoped - each project gets its own isolated set. Add `.context-guardian/` to your `.gitignore`.

---

## Logging

All hook activity logs to `~/.claude/logs/cg.log`:

```bash
tail -f ~/.claude/logs/cg.log
```

Log entries include token counts, threshold checks, checkpoint creation with compression stats, synthetic session writes, and handoff activity.

---

## Troubleshooting

**Token counts show "estimated":**
- Only happens on the first message of a session. After one exchange, counts become real.

**`/resume cg` doesn't find the session:**
- Ensure you ran `/cg:compact`, `/cg:prune`, or `/cg:handoff` first - these create the synthetic session.
- Check logs: `tail -20 ~/.claude/logs/cg.log`

**Plugin not loading:**
- Check logs: `tail -20 ~/.claude/logs/cg.log`
- Verify plugin is loaded: `/plugins`
- Try: `/plugin uninstall cg` then `/plugin install cg`

---

## Contributing

```bash
bun test              # run all tests (604 across 24 files)
npx biome check       # lint
```

The e2e test (`test/compaction-e2e.test.mjs`) creates a 26-turn coding session with 19 trackable facts and 5 noise items, verifying every fact survives extraction and all noise is removed. If any change drops a fact, the test names exactly which one was lost.

---

## License

MIT

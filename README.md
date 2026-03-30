# Context Guardian

**Automatic context window monitoring and smart compaction for Claude Code. Zero dependencies required.**

Context Guardian (cg) watches your context window usage in real time and intervenes before your conversation degrades. When usage crosses a configurable threshold, it presents a menu with options to compact, trim, or continue - preserving your work and keeping Claude sharp.

Distributed as a **Claude Code plugin** - it's called "cg" due to a quirk of how Claude Code does skills. `/cg:stats` is easier to type than `/context-guardian:stats`.

---

## Install

```bash
/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian # Add the marketplace (one-time)
/plugin install cg #install the plugin
```

**Note:** Claudes `/reload-plugins` can be a bit sketchy - try opening a new session if you hit issues.

### Update

To pull the latest version:

1. Open `/plugins`
2. Go to **Marketplaces** tab → select the context-guardian marketplace → **Update marketplace**
3. Inside the market place, go to **Browse Plugins** → select cg → **Update**
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

Context Guardian adds six slash commands:

### `/cg:stats`

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  Current usage:   372,000 / 1,000,000 tokens (37.2%)
│  Threshold:       35% (0% remaining to warning)
│  Data source:     real counts
│
│  Model:           claude-opus-4-6 / 1,000,000 tokens
│  Last updated:    12 seconds ago
│
│  /cg:compact         ~37.2% → ~5%
│  /cg:prune           ~37.2% → ~3%
│
│  /cg:handoff [name]  save session for later
│  /cg:resume          restore a previous session
│
└─────────────────────────────────────────────────
```

### `/cg:config`

```bash
/cg:config                     # show current config
/cg:config threshold 0.50      # trigger at 50%
/cg:config max_tokens 1000000  # override token limit
/cg:config reset               # restore defaults
```

The config also shows the **auto-detected model and token limit** from your active session, so you can see what Context Guardian is actually using versus the config fallback.

### `/cg:compact`

Extracts full conversation history, strips tool calls, tool results, thinking blocks, and system messages. Same compaction engine as the automatic warning.

### `/cg:prune`

Drops oldest messages, keeps the last 10 user exchanges (each grouped with their assistant responses). Good when only recent work matters.

### `/cg:handoff`

Save your current session context for later. Uses the same deterministic extraction engine as Smart Compact — strips tool noise, keeps all decisions and code changes.

```bash
/cg:handoff                    # save without a description
/cg:handoff my auth refactor   # save with a custom name
```

Handoff files are saved to `.context-guardian/` in your project root. It is recommended to .gitignore this folder.

### `/cg:resume`

Restore context from a previous session. Shows a menu of available handoffs:

```
┌──────────────────────────────────────────────────────────────────────────
│  Previous Sessions
├──────────────────────────────────────────────────────────────────────────
│  [1]  my auth refactor (3 hours ago · 42KB)
│  [2]  implement fibonacci (yesterday · 18KB)
│
│  Reply with a number to restore, or continue to start a new session.
└──────────────────────────────────────────────────────────────────────────
```

Pick a number to restore that session's context, or just keep working for a fresh start.

```bash
/cg:resume       # show handoffs only
/cg:resume all   # also show compaction checkpoints
```

---

## The Problem: Context Rot

LLMs have a fixed context window - the total amount of text they can "see" at once. Claude Code sessions accumulate context rapidly: every message you send, every file Claude reads, every tool call and its output, every thinking block - it all stacks up.

When the context window fills:

- **The U-Shape** Models perform best with information at the beginning or end of prompts. As the prompt gets bigger, the bigger the middle gets.
- **Claude starts forgetting.** Earlier instructions, architectural decisions, and code context silently drop out of the effective attention window. Claude doesn't tell you it's forgotten - it just stops using that information.
- **Quality degrades gradually.** You won't get an error. Responses become less coherent, less grounded in your codebase, and more likely to hallucinate. The degradation is continuous, not sudden.
- **/Compact is destructive.** When Claude Code hits ~95% usage, it summarizes everything into a brief paragraph. This destroys the accumulated context.

Context rot is insidious because **it's invisible**. You don't know Claude has forgotten something until the output is wrong.

### Why This Matters More on Opus 4.6

Opus 4.6 has a **1,000,000 token context window** - 5x larger than the previous 200K. This sounds like a pure advantage, but it creates a unique problem:

- **Sessions last longer.** With 1M tokens, you can work for hours without hitting the limit. This means more accumulated context, more tool outputs, more file reads - and more opportunity for subtle quality degradation.
- **The degradation is slower but deeper.** On Sonnet, you hit the wall at 200K and are forced to compact relatively quickly. On Opus, you can drift into the 40-60% range where quality is noticeably degraded but you haven't hit any hard limit. The model is still "working" - just worse.
- **Cost scales with context.** Every API call sends the full context window. At 500K tokens of context, each message costs significantly more than at 50K. Compacting early saves money on every subsequent interaction.
- **Compaction quality depends on what's in context.** At 35%, Claude's full conversation is in sharp focus - it can produce a high-fidelity summary. At 70%, earlier context is already fuzzy, and any summary Claude generates will be lower quality.

The 1M window is powerful, but it requires active management. Context Guardian provides that management.

---

## Why 35%?

Context Guardian triggers at **35% usage** by default. This is deliberately conservative, and here's the reasoning:

### The Sweet Spot for Model Recall

Research on LLM attention patterns shows that models have a **U-shaped attention curve** - they attend strongly to the beginning and end of the context, with weaker attention in the middle. As context grows:

| Usage Range | Model Behavior |
|-------------|---------------|
| **0-25%** | Full attention across all content. Maximum recall and coherence. |
| **25-40%** | Still strong. The "middle" of context is small enough that attention covers it well. |
| **40-60%** | Noticeable degradation. Middle content starts getting less attention. Instructions from early in the conversation may be partially forgotten. |
| **60-80%** | Significant degradation. Claude may contradict earlier decisions, forget architectural constraints, or hallucinate details about code it read earlier. |
| **80-95%** | Critical zone. Claude Code's internal trimming begins. Effective context is much smaller than the raw number suggests. |
| **95%+** | Emergency auto-compact fires. Everything reduced to a brief summary. |

**35% sits at the boundary between "full recall" and "beginning to degrade."** It's the last point where you can compact with full confidence that the summary will be accurate, because Claude still has strong attention over the entire conversation.

### What Actually Fills the Context

In a typical Claude Code session, your actual conversation - what you typed and what Claude replied - is only **30-40% of the total context**. The rest is:

- **Tool outputs (40-50%):** File reads, grep results, command output. A single large file read can consume 10-20K tokens.
- **System prompts (5-10%):** CLAUDE.md, plugin instructions, skill descriptions, MCP server configs.
- **Tool calls and thinking (10-15%):** The structured blocks that Claude generates internally.

Smart Compact strips all of this noise and keeps only the conversation substance. That's why it typically achieves **70-90% reduction** - most of the context is tool infrastructure, not your actual work.

### Adjusting the Threshold

```bash
/cg:config threshold 0.50    # less conservative, fewer interruptions
/cg:config threshold 0.25    # more conservative, maximum quality
```

**When to raise it (0.40-0.60):**
- Short, focused sessions where context pressure is low
- Tasks that don't depend on early conversation context
- You prefer fewer interruptions

**When to lower it (0.20-0.30):**
- Long architectural sessions where early decisions matter throughout
- Multi-step refactoring where forgetting a constraint is costly
- You're on Opus 4.6 and want maximum quality preservation

---

## How It Works

### Token Counting - Real Numbers, Not Estimates

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


### Why /clear? (Technical Explanation)

After compaction, you type `/clear` to apply it. Here's why the plugin can't do this automatically:

**Claude Code hooks run in isolated subprocesses.** They receive input via stdin and return output via stdout. A hook can:
- Block a message (`decision: "block"`)
- Inject context (`additionalContext`)
- Exit silently (pass-through)

A hook **cannot**:
- Execute slash commands (`/clear`, `/compact`)
- Directly modify Claude's conversation state
- Invoke skills or other plugin components
- Interact with Claude Code's UI

This is a security boundary - hooks are sandboxed. They can influence the conversation through the defined interface, but they can't take arbitrary actions inside Claude Code.

### The Resume Flow

After compaction, the full flow is:

1. **Pick option 2 or 3** → stats shown, checkpoint saved
2. **Type `/clear`** → conversation wiped, checkpoint auto-restores on next message
3. **Type `resume`** → your original prompt (the one that triggered the warning) replays automatically

If you type `resume` immediately after `/clear`, the plugin handles both the checkpoint restore and prompt replay in a single step - no double-prompting.

### Cooldown

After any compaction or "Continue" choice, Context Guardian enters a **2-minute cooldown** where the warning won't re-trigger. This prevents loops where the injected checkpoint itself exceeds the threshold (common with very low thresholds during testing).

The cooldown is cleared by:
- `/clear` + checkpoint restore (fresh start)
- New session (SessionStart hook)
- Expiry (2 minutes)

---

## Architecture

### Hook Events

| Hook | Event | Purpose |
|------|-------|---------|
| `submit.mjs` | `UserPromptSubmit` | Main logic - monitors usage, shows menu, handles compaction, resume, cooldown |
| `session-start.mjs` | `SessionStart` | Cleans up session flags, auto-configures statusline, self-healing marketplace clone |
| `stop.mjs` | `Stop` | Writes fresh token state after each assistant response. Captures baseline overhead on first response. |
| `precompact.mjs` | `PreCompact` | Injects CG's extraction as additional context into Claude Code's native `/compact` |

### Token Counting

Two methods, preferring the more accurate. State is written by **both** the submit hook (before the response) and the stop hook (after the response), so `/cg:stats` always reflects the latest counts.

1. **Real counts (preferred):** Reads `message.usage` from the most recent assistant message in the transcript JSONL. Calculates `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Also detects the model name for auto-detecting max_tokens.

2. **Byte estimation (fallback):** Only used on the very first message of a session (before any assistant response). Counts content bytes after the most recent compact marker and divides by 4.

3. **Post-compaction estimates:** After compaction or checkpoint restore, a state file is written with estimated post-compaction token counts so `/cg:stats` works immediately - no need to send a message first.

### Baseline Overhead

On the first assistant response of each session, the stop hook captures the current token count as `baseline_overhead` — at that point, context is almost entirely system prompts, CLAUDE.md, and tool definitions. This measured value serves as an irreducible floor in all compaction savings estimates, replacing the previous heuristic.

### Statusline

Context Guardian auto-configures a terminal statusline on first session start. It shows real-time context usage:

```
Context usage: 3% | 32% remaining until alert | /cg:stats for more
```

Color-coded green/yellow/red based on usage level. If another statusline is already configured, CG won't overwrite it.

### Model & Tokens Auto-Detection

Every assistant message in the transcript includes a `model` field (e.g., `"claude-opus-4-6"`). I have used this basic rule for now - it's imperfect (as token counts can be manually reset, and Sonnet now also supports 1M), but it's the best I have right now. Suggestions welcome.

- **Opus 4.6+** (major >= 4, minor >= 6): **1,000,000 tokens**
- **Everything else** (Sonnet, Haiku, older Opus): **200,000 tokens**

### Data Storage

All persistent data lives in the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`, typically `~/.claude/plugins/data/cg/`):

| File | Purpose |
|------|---------|
| `config.json` | Threshold and max_tokens override |
| `state-{session_id}.json` | Latest token counts, model, transcript path (session-scoped) |
| `reload-{hash}.json` | Triggers checkpoint injection after `/clear` (project-scoped) |
| `resume-{hash}.json` | Stores original prompt for `resume` replay (project-scoped) |
| `cooldown-{hash}.json` | Prevents warning re-trigger for 2 minutes (project-scoped) |
| `checkpoints/` | Saved compaction checkpoints (markdown) |

Additionally, each project has a `.context-guardian/` directory at its root containing:

| File | Purpose |
|------|---------|
| `cg-handoff-[name]-{datetime}.md` | Session handoff files (from `/cg:handoff`) |
| `cg-checkpoint-{datetime}.md` | Copies of compaction checkpoints (for `/cg:resume all`) |

These files are project-scoped — each project gets its own isolated set. Add `.context-guardian/` to your `.gitignore`.

The `{hash}` suffix is a short SHA-256 of the project directory, ensuring multiple simultaneous sessions in different projects don't interfere.

---

## Logging

All hook activity logs to `~/.claude/logs/cg.log`:

```bash
tail -f ~/.claude/logs/cg.log
```

Log entries include token counts, threshold checks, menu interactions, checkpoint creation with compression stats, resume/reload events, and cooldown activity.

---

## Troubleshooting

**Menu doesn't appear:**
- Check your threshold: `/cg:config`
- Check logs: `tail -20 ~/.claude/logs/cg.log`
- Verify plugin is loaded: `/plugins`

**"resume" doesn't work:**
- Expires after 10 minutes. If too much time passed, retype your message.
- If you start a new session without `/clear`, the resume state is cleared.

**Token counts show "estimated":**
- Only happens on the first message of a session. After one exchange, counts become real.

**Warning fires immediately after compaction:**
- This shouldn't happen (2-minute cooldown). If it does, check if cooldown.json exists in the plugin data directory.

**Slash commands get blocked by the warning:**
- This shouldn't happen. All messages starting with `/` bypass the hook entirely.

**Plugin not loading:**
- Ensure Claude Code v1.0.33+ (plugin system requirement)
- Try: `/plugin uninstall cg` then `/plugin install cg`

---

## License

MIT

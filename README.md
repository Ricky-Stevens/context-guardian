# Context Guardian

**Automatic context window monitoring and smart compaction for Claude Code.**

Context Guardian watches your context window usage in real time and intervenes before your conversation degrades. When usage crosses a configurable threshold, it presents a menu with options to compact, trim, or continue — preserving your work and keeping Claude sharp.

Distributed as a **Claude Code plugin** — one command to install, zero configuration required.

---

## Install

```bash
# Add the marketplace (one-time)
/plugin marketplace add https://github.com/Ricky-Stevens/context-guardian

# Install the plugin
/plugin install cg
```

That's it. Works immediately after `/reload-plugins` or on your next Claude Code session.

### Update

To pull the latest version:

1. Open `/plugins`
2. Go to **Marketplaces** tab → select the context-guardian marketplace → **Update marketplace**
3. Go to **Installed** tab → select cg → **Update**
4. Run `/reload-plugins` or start a new session

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

Context Guardian adds four slash commands:

### `/cg:stats`

Check your current context window usage at any time:

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
│  /cg:compact      ~37.2% → ~5%
│  /cg:prune        ~37.2% → ~3%
│
└─────────────────────────────────────────────────
```

Token counts are **real values** read from `message.usage` in Claude Code's transcript — not estimates.

### `/cg:config`

View or update configuration without editing files:

```bash
/cg:config                     # show current config
/cg:config threshold 0.50      # trigger at 50%
/cg:config max_tokens 1000000  # override token limit
/cg:config reset               # restore defaults
```

The config also shows the **auto-detected model and token limit** from your active session, so you can see what Context Guardian is actually using versus the config fallback.

### `/cg:compact`

Run Smart Compact on demand — extracts full conversation history, strips tool calls, tool results, thinking blocks, and system messages. Typically achieves 70-90% reduction. Same compaction engine as the automatic warning.

After running, type `/clear` to apply the compaction.

### `/cg:prune`

Run Keep Recent on demand — drops oldest messages, keeps the last 20 meaningful text messages (tool-only assistant turns don't count). Good when only recent work matters.

After running, type `/clear` to apply the compaction.

---

## The Problem: Context Rot

Large language models have a fixed context window — the total amount of text they can "see" at once. Claude Code sessions accumulate context rapidly: every message you send, every file Claude reads, every tool call and its output, every thinking block — it all stacks up.

When the context window fills:

- **Claude starts forgetting.** Earlier instructions, architectural decisions, and code context silently drop out of the effective attention window. Claude doesn't tell you it's forgotten — it just stops using that information.
- **Quality degrades gradually.** You won't get an error. Responses become less coherent, less grounded in your codebase, and more likely to hallucinate. The degradation is continuous, not sudden.
- **Claude Code's built-in compaction is destructive.** When Claude Code hits ~95% usage, it auto-compacts by summarizing everything into a brief paragraph. This destroys conversation nuance, multi-step reasoning chains, and the accumulated context that makes Claude effective on your specific project.

Context rot is insidious because **it's invisible**. You don't know Claude has forgotten something until the output is wrong. By then, the context that would have produced the right answer is already gone.

### Why This Matters More on Opus 4.6

Opus 4.6 has a **1,000,000 token context window** — 5x larger than Sonnet's 200K. This sounds like a pure advantage, but it creates a unique problem:

- **Sessions last longer.** With 1M tokens, you can work for hours without hitting the limit. This means more accumulated context, more tool outputs, more file reads — and more opportunity for subtle quality degradation.
- **The degradation is slower but deeper.** On Sonnet, you hit the wall at 200K and are forced to compact relatively quickly. On Opus, you can drift into the 40-60% range where quality is noticeably degraded but you haven't hit any hard limit. The model is still "working" — just worse.
- **Cost scales with context.** Every API call sends the full context window. At 500K tokens of context, each message costs significantly more than at 50K. Compacting early saves money on every subsequent interaction.
- **Compaction quality depends on what's in context.** At 35%, Claude's full conversation is in sharp focus — it can produce a high-fidelity summary. At 70%, earlier context is already fuzzy, and any summary Claude generates will be lower quality.

The 1M window is powerful, but it requires active management. Context Guardian provides that management.

---

## Why 35%?

Context Guardian triggers at **35% usage** by default. This is deliberately conservative, and here's the reasoning:

### The Sweet Spot for Model Recall

Research on LLM attention patterns shows that models have a **U-shaped attention curve** — they attend strongly to the beginning and end of the context, with weaker attention in the middle. As context grows:

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

In a typical Claude Code session, your actual conversation — what you typed and what Claude replied — is only **30-40% of the total context**. The rest is:

- **Tool outputs (40-50%):** File reads, grep results, command output. A single large file read can consume 10-20K tokens.
- **System prompts (5-10%):** CLAUDE.md, plugin instructions, skill descriptions, MCP server configs.
- **Tool calls and thinking (10-15%):** The structured blocks that Claude generates internally.

Smart Compact strips all of this noise and keeps only the conversation substance. That's why it typically achieves **70-90% reduction** — most of the context is tool infrastructure, not your actual work.

### Controlling Costs

Every API call to Claude sends the entire context window as input tokens. The cost formula is:

```
cost_per_message = (context_tokens × input_price) + (response_tokens × output_price)
```

On Opus 4.6, input tokens cost $15 per million. At 500K context:

- **Before compaction:** Each message costs ~$7.50 in input tokens alone
- **After compaction to 50K:** Each message costs ~$0.75 in input tokens

Compacting at 35% (350K tokens on Opus) and reducing to ~5% saves approximately **$5 per message** for every subsequent interaction in the session. Over a 2-hour session with dozens of exchanges, this adds up significantly.

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

## Context Windows by Model

| Model | Context Window | 35% Trigger |
|-------|---------------|-------------|
| **Claude Opus 4.6** | 1,000,000 tokens | ~350,000 tokens |
| **Claude Sonnet 4.6** | 200,000 tokens | ~70,000 tokens |
| **Claude Haiku 4.5** | 200,000 tokens | ~70,000 tokens |
| **Older Opus (< 4.6)** | 200,000 tokens | ~70,000 tokens |

Context Guardian **auto-detects your model** from the transcript. Every assistant message in Claude Code's JSONL transcript includes a `model` field (e.g., `"claude-opus-4-6"`). The plugin reads this and applies the correct token limit — Opus 4.6+ gets 1M, everything else gets 200K. No manual configuration needed.

---

## How It Works

### Token Counting — Real Numbers, Not Estimates

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

These are the real values from the Anthropic API — the same numbers that determine your bill. On the first message of a session (before any assistant response exists), the plugin falls back to a byte-based estimate until real data is available.

### The Warning Menu

When context usage crosses your threshold, your message is paused and you see:

```
Context Guardian — ~37.2% used (~372,000 / 1,000,000 tokens)

  1  Continue          proceed with your request (it's saved, don't retype it)
  2  Smart Compact     keep full history, strip tool calls & internal noise
  3  Keep Recent       drop oldest, keep last 20 messages
  4  Clear             wipe everything
  0  Cancel            dismiss this warning and continue

Reply with 1, 2, 3, 4, or 0.
```

Your original message is saved. You don't need to retype it.

### Menu Options

**Option 1 — Continue:** Your original message replays and Claude responds normally. The warning will re-trigger after a 2-minute cooldown if context continues to grow.

**Option 2 — Smart Compact:** Extracts your full conversation history, strips internal noise (tool calls, tool results, thinking blocks, system messages), and creates a clean markdown checkpoint. Keeps only the substance — your messages and Claude's text responses. Typically achieves 70-90% reduction.

**Option 3 — Keep Recent:** Takes the last 20 meaningful text messages (tool-only assistant turns don't count) and discards everything older. Good when only recent work matters.

**Option 4 — Clear:** Wipes everything. Start completely fresh. No checkpoint saved.

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

This is a security boundary — hooks are sandboxed. They can influence the conversation through the defined interface, but they can't take arbitrary actions inside Claude Code.

The `/clear` command wipes the conversation and starts a fresh session. The plugin's SessionStart hook fires, and on the next message, the checkpoint is automatically injected via `additionalContext`. This two-step approach (`/clear` → auto-restore) is the only reliable way to replace the conversation context from within a hook.

### The Resume Flow

After compaction (options 2, 3), the full flow is:

1. **Pick option 2 or 3** → stats shown, checkpoint saved
2. **Type `/clear`** → conversation wiped, checkpoint auto-restores on next message
3. **Type `resume`** → your original prompt (the one that triggered the warning) replays automatically

If you type `resume` immediately after `/clear`, the plugin handles both the checkpoint restore and prompt replay in a single step — no double-prompting.

### Cooldown

After any compaction or "Continue" choice, Context Guardian enters a **2-minute cooldown** where the warning won't re-trigger. This prevents loops where the injected checkpoint itself exceeds the threshold (common with very low thresholds during testing).

The cooldown is cleared by:
- `/clear` + checkpoint restore (fresh start)
- New session (SessionStart hook)
- Expiry (2 minutes)

---

## Architecture

### Plugin Structure

```
cg/
  .claude-plugin/
    plugin.json           # Plugin manifest — hooks + skills
  hooks/
    submit.mjs            # UserPromptSubmit — main logic
    session-start.mjs     # SessionStart — flag cleanup
    stop.mjs              # Stop — writes fresh token state after each response
  lib/
    paths.mjs             # Centralized path resolution (CLAUDE_PLUGIN_DATA)
    logger.mjs            # Shared logging
    config.mjs            # Config load/save, defaults
    content.mjs           # Content parsing utilities
    tokens.mjs            # Token counting from transcript usage data
    transcript.mjs        # Conversation extraction
    stats.mjs             # Compaction stats formatting
  skills/
    stats/SKILL.md        # /cg:stats
    config/SKILL.md       # /cg:config
    compact/SKILL.md      # /cg:compact
    prune/SKILL.md        # /cg:prune
  package.json
  README.md
```

### Hook Events

| Hook | Event | Purpose |
|------|-------|---------|
| `submit.mjs` | `UserPromptSubmit` | Main logic — monitors usage, shows menu, handles compaction, resume, cooldown |
| `session-start.mjs` | `SessionStart` | Cleans up session flags, stale resume/cooldown files |
| `stop.mjs` | `Stop` | Writes fresh token state after each assistant response. Also written by submit hook before each turn. |

### Why Skills Can't Replace Hooks

You might wonder: why not implement the warning as a skill instead of a hook? The reason is **timing and control**:

- **Skills are reactive.** They only run when the user explicitly invokes them. A skill can't intercept a message before Claude processes it.
- **Hooks are proactive.** `UserPromptSubmit` fires on every message, before Claude sees it. This is the only way to pause a message and show the warning menu.
- **Hooks can block.** The `decision: "block"` mechanism prevents Claude from processing the message entirely. Skills have no equivalent — they run inside Claude's turn.
- **Skills are Claude-dependent.** A skill is a prompt that Claude interprets. Claude can choose to ignore or rephrase instructions. Hooks produce direct UI output that the user sees exactly as written.

Context Guardian uses **both**: hooks for the automatic monitoring and blocking, skills for on-demand status/config/compact commands. Each does what it's best at.

### Token Counting

Two methods, preferring the more accurate. State is written by **both** the submit hook (before the response) and the stop hook (after the response), so `/cg:stats` always reflects the latest counts.

1. **Real counts (preferred):** Reads `message.usage` from the most recent assistant message in the transcript JSONL. Calculates `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Also detects the model name for auto-detecting max_tokens.

2. **Byte estimation (fallback):** Only used on the very first message of a session (before any assistant response). Counts content bytes after the most recent compact marker and divides by 4.

3. **Post-compaction estimates:** After compaction or checkpoint restore, a state file is written with estimated post-compaction token counts so `/cg:stats` works immediately — no need to send a message first.

### Model Auto-Detection

Every assistant message in the transcript includes a `model` field (e.g., `"claude-opus-4-6"`). The plugin parses this to determine max_tokens:

- **Opus 4.6+** (major >= 4, minor >= 6): **1,000,000 tokens**
- **Everything else** (Sonnet, Haiku, older Opus): **200,000 tokens**

This runs on every token check, so switching models mid-session is handled automatically.

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

The `{hash}` suffix is a short SHA-256 of the project directory, ensuring multiple simultaneous sessions in different projects don't interfere.

Session-scoped flags (`cg-warned`, `cg-menu`, `cg-prompt`, `cg-compact`) live in the project's `.claude/` directory. The `cg-compact` flag contains the compaction mode (`smart` or `recent`). These are cleaned up by the SessionStart hook on every new session and `/clear`.

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

## Clean Uninstall

To remove the plugin and all saved data:

```bash
/plugin uninstall cg
rm -rf ~/.claude/plugins/data/cg
rm ~/.claude/logs/cg.log
```

---

## License

MIT

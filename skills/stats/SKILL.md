---
name: stats
description: Show current context window usage, threshold, and compaction recommendation
context: inline
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Context Guardian Stats

Read the session-scoped state file and display the status box. Follow these steps exactly.

## Step 1 — Read the state file

Read the file at `${CLAUDE_PLUGIN_DATA}/state-${CLAUDE_SESSION_ID}.json`.

If `${CLAUDE_PLUGIN_DATA}` is empty, use `~/.claude/cg/` instead.

If the file does not exist, display this and stop:

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  No data for this session.
│  Send a non-slash-command message first so the
│  submit hook can capture token counts.
│
└─────────────────────────────────────────────────
```

## Step 2 — Compute "Last updated"

Run: `date +%s`

Subtract `ts / 1000` (ts is in milliseconds) from the result. Show as:
- Under 60 seconds: "X seconds ago"
- 60-3599 seconds: "X minutes ago"
- 3600+ seconds: "X hours ago"

If the difference is greater than 300 seconds (5 minutes), append "(stale)" to the value.

## Step 3 — Display the status box

All values come directly from the JSON — use them as-is. Pre-computed fields: `pct_display` (already a percentage string like "2.5"), `threshold_display` (already a whole number like "35"), `headroom`, `recommendation`.

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  Current usage:   {current_tokens with commas} / {max_tokens with commas} tokens ({pct_display}%)
│  Threshold:       {threshold_display}% (triggers warning)
│  Headroom:        ~{headroom with commas} tokens before warning
│  Data source:     {source: "real" → "real counts", "estimated" → "estimated"}
│
│  Model:           {model}
│  Last updated:    {computed relative time}
│
│  Recommendation:  {recommendation}
│
└─────────────────────────────────────────────────
```

Output ONLY this box, plus the tip line below. No extra text, explanation, or commentary.

**Tip:** `/cg:compact` (smart compact) · `/cg:prune` (keep recent) · `/cg:config` (settings)

$ARGUMENTS

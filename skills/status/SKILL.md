---
name: status
description: Show current context window usage, threshold, and compaction recommendation
context: inline
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Context Guardian Status

Read the session-scoped state file and display the status box. Follow these steps exactly.

## Step 1 — Read the state file

Read the file at `${CLAUDE_PLUGIN_DATA}/state-${CLAUDE_SESSION_ID}.json`.

If `${CLAUDE_PLUGIN_DATA}` is empty, use `~/.claude/context-guardian/` instead.

If the file does not exist, display this and stop:

```
┌─────────────────────────────────────────────────
│  Context Guardian Status
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

If the difference is greater than 300 seconds (5 minutes), treat the data as stale and append "(stale)" to the Last updated line.

## Step 3 — Display the status box

All values come directly from the JSON file — do NOT recompute them. Use this exact format:

```
┌─────────────────────────────────────────────────
│  Context Guardian Status
│
│  Current usage:   {current_tokens formatted with commas} / {max_tokens formatted with commas} tokens ({pct as percentage with 1 decimal}%)
│  Threshold:       {threshold as percentage with 0 decimals}% (triggers warning)
│  Headroom:        ~{headroom formatted with commas} tokens before warning
│  Data source:     {source: "real" → "real counts", "estimated" → "estimated"}
│
│  Model:           {model}
│  Last updated:    {computed relative time}
│
│  Recommendation:  {recommendation}
│
└─────────────────────────────────────────────────
```

Output ONLY this box. No extra text, explanation, or commentary before or after.

$ARGUMENTS

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

Compute the difference: `(result of date +%s) - (ts / 1000)`. Do NOT show this calculation in the output. Only show the final relative time:
- Under 60 seconds: "X seconds ago"
- 60-3599 seconds: "X minutes ago"
- 3600+ seconds: "X hours ago"

If the difference is greater than 300 seconds (5 minutes), append "(stale)" to the value.

## Step 3 — Display the status box

All values come directly from the JSON — use them as-is. Pre-computed fields: `pct_display` (already a percentage string like "2.5"), `threshold_display` (already a whole number like "35"), `smart_estimate_pct`, `recent_estimate_pct`. Compute `threshold_display - pct_display` (rounded to nearest integer) for the "remaining to warning" value.

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  Current usage:   {current_tokens with commas} / {max_tokens with commas} tokens ({pct_display}%)
│  Threshold:       {threshold_display}% ({threshold_display - pct_display, rounded}% remaining to warning)
│  Data source:     {source: "real" → "real counts", "estimated" → "estimated"}
│
│  Model:           {model} / {max_tokens with commas} tokens
│  Last updated:    {computed relative time}
│
│  /cg:compact      ~{pct_display}% → ~{smart_estimate_pct}%
│  /cg:prune        ~{pct_display}% → ~{recent_estimate_pct}%
│
└─────────────────────────────────────────────────
```

## Step 4 — Run diagnostics

Run: `node ${CLAUDE_PLUGIN_ROOT}/lib/diagnostics.mjs ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA}`

Parse the JSON output. If **all** checks have `ok: true`, append this line inside the box before the closing `└`:

```
│
│  Health:          All checks passed
```

If **any** check has `ok: false`, append this instead:

```
│
│  Health:          {count} issue(s) detected
│    ✗ {check.name}: {check.detail}
│    ✗ {check.name}: {check.detail}
```

List only the failed checks. Each on its own `│    ✗` line.

## Output

Output ONLY the box. No extra text, explanation, or commentary.

$ARGUMENTS

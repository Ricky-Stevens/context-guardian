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

## Step 2 — Display the status box

All values come directly from the JSON — use them as-is. Do NOT compute any values yourself.

- `pct_display` — already a string like "2.5"
- `threshold_display` — already a number like 35
- `remaining_to_alert` — already computed (threshold minus current, rounded)

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  Current usage:   {current_tokens with commas} / {max_tokens with commas} tokens ({pct_display}%)
│  Session size:    {(payload_bytes + baseline_overhead × 4) ÷ 1048576, to 1 decimal, minimum 0.1}MB / 20MB
│  Threshold:       {threshold_display}% ({remaining_to_alert}% remaining to alert)
│  Model:           {model} / {max_tokens with commas} tokens
│
│  /cg:compact        smart compact — strips file reads, system noise
│  /cg:prune          keep last 10 exchanges only
│  /cg:handoff [name] save session for later
│
└─────────────────────────────────────────────────
```

## Step 3 — Run diagnostics

Run: `node ${CLAUDE_PLUGIN_ROOT}/lib/diagnostics.mjs ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA}`

If the command fails or returns invalid JSON, omit the Health section entirely.

Parse the JSON output. If **all** checks have `ok: true`, do NOT add a Health section.

If **any** check has `ok: false`, append this inside the box before the closing `└`:

```
│
│  Health:          {count} issue(s) detected
│    ✗ {check.name}: {check.detail}
│    ✗ {check.name}: {check.detail}
```

List only the failed checks. Each on its own `│    ✗` line.

## Output

Output the box and nothing else. No extra text, explanation, or commentary beyond what the steps above specify.

$ARGUMENTS

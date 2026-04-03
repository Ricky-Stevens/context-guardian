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

Run: `echo $(( $(date +%s) - JSON_TS_VALUE / 1000 ))`

Replace `JSON_TS_VALUE` with the `ts` field from the JSON. The command outputs the age in seconds. Display it as:
- Under 60: "Xs ago"
- 60–3599: "Xm ago"
- 3600+: "Xh ago"

If the result is greater than 300, append " (stale)".

## Step 3 — Display the status box

All values come directly from the JSON — use them as-is. Do NOT compute any values yourself.

- `pct_display` — already a string like "2.5"
- `threshold_display` — already a number like 35
- `remaining_to_alert` — already computed (threshold minus current, rounded)
- `smart_estimate_pct` and `recent_estimate_pct` — already computed

```
┌─────────────────────────────────────────────────
│  Context Guardian Stats
│
│  Current usage:   {current_tokens with commas} / {max_tokens with commas} tokens ({pct_display}%)
│  Threshold:       {threshold_display}% ({remaining_to_alert}% remaining to alert)
│  Data source:     {source: "real" → "real counts", "estimated" → "estimated"}
│
│  Model:           {model} / {max_tokens with commas} tokens
│  Last updated:    {computed from Step 2}
│
│  /cg:compact         ~{pct_display}% → ~{smart_estimate_pct}%
│  /cg:prune           ~{pct_display}% → ~{recent_estimate_pct}%
│
│  /cg:handoff [name]  save session for later
│
└─────────────────────────────────────────────────
```

## Step 4 — Run diagnostics (optional)

Run: `node ${CLAUDE_PLUGIN_ROOT}/lib/diagnostics.mjs ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA}`

If the command fails or returns invalid JSON, omit the Health section entirely.

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

Output the box and nothing else. No extra text, explanation, or commentary beyond what the steps above specify.

$ARGUMENTS

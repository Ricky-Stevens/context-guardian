---
name: status
description: Show current context window usage, threshold, and compaction recommendation
context: inline
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Context Guardian Status

Show the user their current context window status. Gather data from these two files:

1. **Token state** — `${CLAUDE_PLUGIN_DATA}/state.json`
   Contains: `current_tokens`, `max_tokens`, `pct`, `source`, `model`, `session_id`, `transcript_path`, `ts`
   If missing or stale (ts older than 5 minutes), note that counts are unavailable.

2. **Config** — `${CLAUDE_PLUGIN_DATA}/config.json`
   Contains: `threshold`, `max_tokens`
   If missing, defaults are: threshold 0.35, max_tokens 200000.

Use Bash to get the current unix timestamp in seconds: `date +%s`

Display a status report in this exact format (fill in real values):

```
┌─────────────────────────────────────────────────
│  Context Guardian Status
│
│  Current usage:   X,XXX / X,XXX,XXX tokens (XX.X%)
│  Threshold:       XX% (triggers warning)
│  Headroom:        ~X,XXX tokens before warning
│  Data source:     real counts / estimated
│
│  Model:           <model name from state.json, or "unknown">
│  Max tokens:      X,XXX,XXX
│  Last updated:    <relative time, e.g. "12 seconds ago">
│
│  Recommendation:  <one of the below>
│
└─────────────────────────────────────────────────
```

For "Data source": use the `source` field from state.json ("real" → "real counts", "estimated" → "estimated").

For "Last updated": compute the difference between the current unix timestamp and the `ts` field (which is in milliseconds). Show as seconds/minutes ago.

Recommendations based on usage vs threshold:
- Below 50% of threshold: "All clear. Plenty of context remaining."
- 50-99% of threshold: "Approaching threshold. Consider wrapping up complex tasks."
- At or above threshold: "At threshold. Compaction recommended — the warning menu will trigger on your next message."
- If state.json is missing/stale: "No recent data. Send a message first so the submit hook can capture token counts."

If `${CLAUDE_PLUGIN_DATA}` directory doesn't exist, check `~/.claude/context-guardian/` as fallback.

Do NOT add extra commentary beyond the status box. Just show the data.

$ARGUMENTS

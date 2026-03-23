---
name: compact
description: Manually trigger context compaction (smart compact or keep recent 20)
context: inline
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Context Guardian — Manual Compact

Trigger a context compaction on demand, without waiting for the threshold warning.

## Determine mode from arguments

Check `$ARGUMENTS`:
- If `$ARGUMENTS` is `smart` or `1`: set `CHOICE=1`
- If `$ARGUMENTS` is `recent` or `2`: set `CHOICE=2`
- If `$ARGUMENTS` is empty or anything else: set `CHOICE=menu`

## If CHOICE is `menu` — show the menu

Run the following bash command to write the compact menu flag and show the user their options:

```bash
FLAGS_DIR="${CLAUDE_CWD:-.}/.claude"
SESSION_ID="${CLAUDE_SESSION_ID}"
FLAG_FILE="$FLAGS_DIR/cg-compact-$SESSION_ID"

mkdir -p "$FLAGS_DIR"
echo "1" > "$FLAG_FILE"
echo "FLAG_WRITTEN"
```

If `FLAG_WRITTEN` is output, tell the user:

```
┌─────────────────────────────────────────────────
│  Context Guardian — Manual Compact
│
│  1  Smart Compact     full history, strip tool noise
│  2  Keep Recent       last 20 messages only
│  0  Cancel
│
│  Reply with 1, 2, or 0.
│
└─────────────────────────────────────────────────
```

Show ONLY this box. Do not add any other text or explanation.

## If CHOICE is `1` or `2` — write the flag with the choice pre-selected

Run the following bash command, replacing `$CHOICE` with the determined value:

```bash
FLAGS_DIR="${CLAUDE_CWD:-.}/.claude"
SESSION_ID="${CLAUDE_SESSION_ID}"
FLAG_FILE="$FLAGS_DIR/cg-compact-$SESSION_ID"

mkdir -p "$FLAGS_DIR"
echo "1" > "$FLAG_FILE"
echo "FLAG_WRITTEN"
```

If `FLAG_WRITTEN` is output, tell the user:

- If CHOICE was `1`: "Running Smart Compact... Reply with **1** to confirm."
- If CHOICE was `2`: "Running Keep Recent 20... Reply with **2** to confirm."

$ARGUMENTS

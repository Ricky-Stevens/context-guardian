---
name: compact
description: Manually trigger context compaction (smart compact or keep recent 20)
context: inline
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Context Guardian — Manual Compact

Trigger a context compaction on demand, without waiting for the threshold warning.

## What to do

Run the following bash command to write the compact menu flag and show the user their options:

```bash
# Determine the flags directory
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
│
│  Reply with 1 or 2.
│
└─────────────────────────────────────────────────
```

Show ONLY this box. Do not add any other text or explanation.

$ARGUMENTS

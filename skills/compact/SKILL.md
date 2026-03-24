---
name: compact
description: Manually trigger context compaction (smart compact or keep recent 20)
context: inline
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Context Guardian — Manual Compact

Trigger a context compaction on demand.

## Determine mode from arguments

Check `$ARGUMENTS`:
- `smart` or `1` → set MODE=`direct-smart`
- `recent` or `2` → set MODE=`direct-recent`
- anything else or empty → set MODE=`menu`

## If MODE is `menu`

Run this bash command exactly:

```bash
mkdir -p "${CLAUDE_CWD:-.}/.claude" && echo "1" > "${CLAUDE_CWD:-.}/.claude/cg-compact-${CLAUDE_SESSION_ID}" && echo "OK"
```

If output contains "OK", display this box exactly and nothing else:

```
┌─────────────────────────────────────────────────
│  Context Guardian — Manual Compact
│
│  1  Smart Compact     text conversation, strip tool calls & code output
│  2  Keep Recent       last 20 messages only
│  0  Cancel
│
│  Reply with 1, 2, or 0.
│
└─────────────────────────────────────────────────
```

## If MODE is `direct-smart`

Run this bash command exactly:

```bash
mkdir -p "${CLAUDE_CWD:-.}/.claude" && echo "1" > "${CLAUDE_CWD:-.}/.claude/cg-compact-${CLAUDE_SESSION_ID}" && echo "OK"
```

If output contains "OK", tell the user exactly: "Smart Compact ready. Reply with **1** to confirm."

## If MODE is `direct-recent`

Run this bash command exactly:

```bash
mkdir -p "${CLAUDE_CWD:-.}/.claude" && echo "1" > "${CLAUDE_CWD:-.}/.claude/cg-compact-${CLAUDE_SESSION_ID}" && echo "OK"
```

If output contains "OK", tell the user exactly: "Keep Recent ready. Reply with **2** to confirm."

$ARGUMENTS

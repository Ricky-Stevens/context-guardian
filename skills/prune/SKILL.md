---
name: prune
description: Run Keep Recent — drop oldest messages, keep last 20 only
context: inline
disable-model-invocation: true
allowed-tools: Bash
---

# Context Guardian — Prune (Keep Recent)

Prunes the conversation to the last 20 messages, discarding everything older. Good when only recent work matters.

## Action

Run this bash command exactly:

```bash
mkdir -p "${CLAUDE_CWD:-.}/.claude" && echo "recent" > "${CLAUDE_CWD:-.}/.claude/cg-compact-${CLAUDE_SESSION_ID}" && echo "OK"
```

If output contains "OK", tell the user exactly:

"Keep Recent ready. Type anything to run it (your message will be discarded)."

If the command fails, tell the user: "Failed to prepare compaction. Check plugin logs."

$ARGUMENTS

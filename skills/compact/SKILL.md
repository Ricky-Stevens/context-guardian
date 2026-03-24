---
name: compact
description: Run Smart Compact — extract full conversation history, strip tool calls and noise
context: inline
disable-model-invocation: true
allowed-tools: Bash
---

# Context Guardian — Smart Compact

Compacts the conversation by extracting the full text history and stripping tool calls, tool results, thinking blocks, and system messages. Typically achieves 70-90% reduction.

## Action

Run this bash command exactly:

```bash
mkdir -p "${CLAUDE_CWD:-.}/.claude" && echo "smart" > "${CLAUDE_CWD:-.}/.claude/cg-compact-${CLAUDE_SESSION_ID}" && echo "OK"
```

If output contains "OK", tell the user exactly:

"Smart Compact ready. Type anything to run it (your message will be discarded)."

If the command fails, tell the user: "Failed to prepare compaction. Check plugin logs."

$ARGUMENTS

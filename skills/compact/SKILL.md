---
name: compact
description: Run Smart Compact — extract full conversation history, strip tool calls and noise
context: inline
allowed-tools: Bash
---

# Context Guardian — Smart Compact

Run this command:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/compact-cli.mjs smart ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_DATA}
```

The output is JSON. If `success` is `true`, display the `statsBlock` value verbatim — it is a pre-formatted box. Then tell the user to type `/clear` to apply the compaction.

If `success` is `false`, display the `error` value.

$ARGUMENTS

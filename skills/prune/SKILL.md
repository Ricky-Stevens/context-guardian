---
name: prune
description: Run Keep Recent — drop oldest messages, keep last 10 exchanges
context: inline
allowed-tools: Bash
---

# Context Guardian — Prune (Keep Recent)

Run this command:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/compact-cli.mjs recent ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_DATA}
```

The output is JSON. If `success` is `true`, display the `statsBlock` value verbatim — it is a pre-formatted box. Then on the next line, display exactly:

**Type `/clear` then `/cg:resume` to apply the compaction.**

If `success` is `false`, display the `error` value.

$ARGUMENTS

---
name: handoff
description: Save session context to a handoff file for cross-session continuity
context: inline
allowed-tools: Bash
---

# Context Guardian — Session Handoff

If `$ARGUMENTS` is not empty, pass it as a quoted label argument at the end of the command. If empty, omit it.

With label:
```
node ${CLAUDE_PLUGIN_ROOT}/lib/compact-cli.mjs handoff ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_DATA} "the label text"
```

Without label:
```
node ${CLAUDE_PLUGIN_ROOT}/lib/compact-cli.mjs handoff ${CLAUDE_SESSION_ID} ${CLAUDE_PLUGIN_DATA}
```

The output is JSON. If `success` is `true`, display the `statsBlock` value verbatim — it is a pre-formatted box. Then on the next line, display exactly:

**To restore in a future session, type `/resume cg:{label}` (using the name you gave), or `/resume` to browse all sessions.**

If `success` is `false`, display the `error` value.

$ARGUMENTS

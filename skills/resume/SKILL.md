---
name: resume
description: Restore context from a previous session handoff or checkpoint
context: inline
allowed-tools: Bash
---

# Context Guardian — Resume Session

The CLI commands below return JSON with a `content` field containing the full session history. The content is already in the JSON output — do NOT re-read the checkpoint or handoff file with the Read tool.

## Step 1: Auto-load check

**Skip this step if `$ARGUMENTS` is non-empty** (e.g. "all", a number, any text). Go directly to Step 2.

If `$ARGUMENTS` is empty, run:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs auto
```

If `autoLoaded` is `true`, skip to **Step 4**.
If `autoLoaded` is `false`, continue to Step 2.

## Step 2: List available files

If `$ARGUMENTS` contains the word "all", append `all` to the command to include checkpoints:

Without "all":
```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs list
```

With "all":
```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs list all
```

If the `files` array is empty, display the `menu` message and stop.
If files exist, display the `menu` text verbatim. Wait for the user's reply.

## Step 3: Load the selected file

Map the user's number to the `files` array (1-indexed). If invalid, say "No context restored." and stop.

```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs load <filepath>
```

## Step 4: Apply the context

Tell the user: **Context restored.**

Internalize the `content` as a preserved record of the prior conversation. All user decisions, reasoning, code changes, and command outputs are present. File read results were stripped as re-obtainable — you MUST re-read any project file before referencing its contents or making edits.

Do NOT summarise the restored context unless asked.

$ARGUMENTS

---
name: resume
description: Restore context from a previous session handoff or checkpoint
context: inline
allowed-tools: Bash
---

# Context Guardian — Resume Session

## Step 1: List available files

If `$ARGUMENTS` contains the word "all", append `all` to the command to include checkpoints:

Without "all":
```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs list
```

With "all":
```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs list all
```

The output is JSON with `files` (array) and `menu` (formatted text).

If the `files` array is empty, display the `menu` message (which explains no files are available) and stop.

If files exist, display the `menu` text verbatim. Do NOT add any extra text after the box — the box already contains instructions. Wait for the user's reply.

## Step 2: Load the selected file

When the user replies with a number, map it to the corresponding file in the `files` array (1-indexed). If they say anything that isn't a valid number (e.g. "nevermind", "skip"), say "No context restored." and stop.

Run:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/resume-cli.mjs load <filepath>
```

Where `<filepath>` is the `path` field from the selected file object.

The output is JSON with `content` and `type`.

## Step 3: Apply the context

After loading, tell the user:

> Context restored from [type] ([date]). I have NOT read any files in this session — I'll re-read anything I need before making changes.

Then treat the loaded `content` as prior session context. Use it to understand what was previously worked on, but re-read any files before editing them.

$ARGUMENTS

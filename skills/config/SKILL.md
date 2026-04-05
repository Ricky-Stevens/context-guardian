---
name: config
description: View or update Context Guardian configuration (threshold, max_tokens)
context: inline
disable-model-invocation: true
allowed-tools: Read, Edit, Bash
---

# Context Guardian Config

Manage the configuration file at `${CLAUDE_PLUGIN_DATA}/config.json`.
If `${CLAUDE_PLUGIN_DATA}` is empty, use `~/.claude/cg/config.json`.

## No arguments — show current config

If `$ARGUMENTS` is empty, read these files:

1. `${CLAUDE_PLUGIN_DATA}/config.json` (may not exist — threshold is adaptive based on context window size, max_tokens defaults to 200000)
2. `${CLAUDE_PLUGIN_DATA}/state-${CLAUDE_SESSION_ID}.json` (may not exist)

If the state file exists and has a `model` field, display:

```
┌─────────────────────────────────────────────────
│  Context Guardian Config
│
│  threshold:        {threshold}  (trigger warning at {threshold_display}% usage, or threshold × 100 if threshold_display is missing)
│  max_tokens:       {max_tokens formatted with commas}  (config default)
│  detected model:   {model from state file}
│  detected limit:   {max_tokens from state file, formatted with commas} tokens
│
│  Config file:  {path to config.json}
│
│  Usage:
│    /cg:config threshold 0.50
│    /cg:config max_tokens 1000000
│    /cg:config reset
│
└─────────────────────────────────────────────────
```

If the state file doesn't exist or has no model field, omit the "detected" lines and show:

```
│  max_tokens:       {max_tokens formatted with commas}  (will auto-detect after first response)
```

Output ONLY the box. No extra commentary.

## With arguments — update config

Parse `$ARGUMENTS` as `<key> <value>`.

**threshold**: Must be 0.01–0.99 after normalization. Normalize the user's input:
- Whole number like "50" → divide by 100 → 0.50
- Percentage like "50%" → strip the %, divide by 100 → 0.50
- Decimal like "0.50" or ".5" → use as-is → 0.50
- If the result is < 0.01 or > 0.99, show an error: "Threshold must be between 1% and 99%."

**max_tokens**: Must be a positive integer.

**reset**: No value needed. Write `{"threshold": 0.35, "max_tokens": 200000}` to the config file.

For threshold/max_tokens: Read the existing config (or use defaults if missing), update the key, write back with `JSON.stringify(cfg, null, 2)`.

After updating, read back the file and display the config box with a confirmation line: "Config updated. Changes take effect on the next message."

If the key is unrecognized, show the Usage section from the box above.

$ARGUMENTS

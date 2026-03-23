---
name: config
description: View or update Context Guardian configuration (threshold, max_tokens)
context: inline
disable-model-invocation: true
allowed-tools: Read, Edit, Bash
---

# Context Guardian Config

Manage the Context Guardian configuration file at `${CLAUDE_PLUGIN_DATA}/config.json`.
If that directory doesn't exist, check `~/.claude/context-guardian/config.json` as fallback.

## No arguments — show current config

If `$ARGUMENTS` is empty, read TWO files:

1. **Config** — `${CLAUDE_PLUGIN_DATA}/config.json` (or fallback path)
2. **State** — `${CLAUDE_PLUGIN_DATA}/state.json` (may not exist yet)

The state file contains `max_tokens` and `model` auto-detected from the current session's transcript. If it exists, show the detected value alongside the config fallback.

Display:

```
┌─────────────────────────────────────────────────
│  Context Guardian Config
│
│  threshold:        0.35  (trigger warning at 35% usage)
│  max_tokens:       200,000  (config default)
│  detected model:   claude-opus-4-6
│  detected limit:   1,000,000 tokens
│
│  The config max_tokens is only used before the first
│  assistant response. After that, the model is detected
│  from the transcript and the correct limit is applied
│  automatically (Opus 4.6+ = 1M, all others = 200K).
│
│  Config file:  <path to config.json>
│
│  Usage:
│    /context-guardian:config threshold 0.50
│    /context-guardian:config max_tokens 1000000
│    /context-guardian:config reset
│
└─────────────────────────────────────────────────
```

If state.json doesn't exist or has no model field, omit the "detected model" and "detected limit" lines and instead show:

```
│  max_tokens:       200,000  (config default — will auto-detect after first response)
```

## With arguments — update config

Parse `$ARGUMENTS` as `<key> <value>` and update the config file.

Supported keys and validation:
- **threshold**: Must be a number between 0.01 and 0.99. This is a ratio, not a percentage. If the user passes a whole number like "50", interpret it as 0.50.
- **max_tokens**: Must be a positive integer. Common values: 200000 (Sonnet/Haiku), 1000000 (Opus 4.6+). Note: this is overridden by auto-detection once a session is active.
- **reset**: No value needed. Reset config to defaults (threshold: 0.35, max_tokens: 200000).

After updating, read back the file and show the updated config in the same box format above with a confirmation: "Config updated. Changes take effect on the next message."

If the key is unrecognized, show the usage help.

If the config file doesn't exist yet, create it with defaults first, then apply the change.

$ARGUMENTS

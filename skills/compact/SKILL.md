---
name: compact
description: Run Smart Compact — extract full conversation history, strip tool calls and noise
context: inline
disable-model-invocation: true
---

# Context Guardian — Smart Compact

Compacts the conversation by extracting the full text history and stripping tool calls, tool results, thinking blocks, and system messages. Typically achieves 70-90% reduction.

The submit hook handles this command directly — no action needed here.

$ARGUMENTS

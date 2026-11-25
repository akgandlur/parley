---
description: The secrets this machine keeps for its sessions, what may use each, and whom it may be sent to
argument-hint: "| log | allow <label> run <program> | allow <label> http <host> | share <label> <id or name> | remove <label>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/parley.mjs" secret $ARGUMENTS 2>&1 || true`

That is the answer of parley's vault to what the user typed. Tell the user exactly that, and nothing else. Do not call any tool.

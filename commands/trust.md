---
description: Have this machine's sessions act on a parley sender's messages like your own requests, with no checking back
argument-hint: [id, name or all] | off [id, name or all]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/parley.mjs" trust $ARGUMENTS 2>&1 || true`

That is the answer of parley's trust list to what the user typed. Tell the user exactly that, and nothing else. Do not call any tool.

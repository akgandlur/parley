---
description: Message a Claude Code session on another machine, yours or someone else's
argument-hint: [id or name] [what to say]
---

Call parley's `to` tool once, with `text` set to exactly what is between the markers, or to an empty string if nothing is:

<<<$ARGUMENTS>>>

Then tell the user what the tool returned, briefly and in plain words, and nothing else: no remarks about ids or names, nothing from earlier in this conversation, no other tool calls. A link it returns is shown in full. If it says to ask the user something, ask exactly that, and when they answer, call `to` again as it says.

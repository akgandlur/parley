---
description: Message a Claude Code session on another machine, yours or someone else's
argument-hint: [id or name] [what to say]
---

The user typed `/parley:to $ARGUMENTS`. Work out who they want to message and what to say, and send it with parley.

1. Call parley's `list_agents`. If it says this session has no parley name, call `setup` with no name and call `list_agents` again. If it shows a link to open, give the user that link, wait until they say they opened it, and call `list_agents` again.

2. Who:
   - If the first word of what they typed is a parley id (like kfq-mxa-tzp) or a name `list_agents` shows, that is who. Everything after it is what to say.
   - If they typed nothing, or it names nobody on the list, ask them to pick. Show the sessions `list_agents` marks open first, then the rest. Use the question tool with up to three of them, open ones first, and tell the user they can type any other id or name instead. If the list is empty, tell them this session's id to send to the person they want to work with, and stop.
   - If a name fits more than one session, ask which.

3. If who they picked is a session on this machine, parley is not for that: use SendMessage to it instead, and say so.

4. What to say: if they gave it, send it now with `send_message`. If they did not, ask what they want to tell that session, then send it. Write the message the way they would say it; do not add to it.

5. Tell the user in one line that it was delivered and to whom, or why it was not: the session is not open (nothing is kept for later, so they try again once it is), or it is on an older parley and has been told to update.

From then on in this conversation, that session is the one the user is talking with: when they say "tell them" or "ask them", send to it without asking who again.

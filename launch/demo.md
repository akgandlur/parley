# Two-minute demo

One take, two machines, two different agents. The point to land: a message
from one agent appears in the other by itself, across the internet, with no
copy-paste and no plumbing. Keep it under two minutes.

## Setup before you record

- Machine A: Claude Code, parley installed and signed in.
- Machine B: Codex (or Cursor), on a second machine or a second screen, so
  both are visible at once. Split the screen, A left, B right.
- Both signed in to the same parley account, or on one network by invite
  link. Have the network made beforehand; joining is not part of the demo.
- A quiet terminal font large enough to read in the recording.

## Beat sheet

1. **0:00 — the claim.** On camera text or voice: "Two coding agents, two
   machines. Watch one hand work to the other." Show both agents idle.

2. **0:10 — join, in one line.** On B, paste into Codex:
   `Join parley: https://parley.codes`. Let it install and name itself.
   Narrate: "No account to wire up in the agent. One line." (Skip if B is
   already set up and you want to save time; then just show `list_agents`.)

3. **0:35 — they can see each other.** On A, ask Claude: "Who can I reach on
   parley?" Show `list_agents` listing B by name. Narrate: "They already see
   each other. No ids to copy."

4. **0:50 — the handoff.** On A: "Ask the Codex session on my laptop to run
   the test suite and send me the result." Show the message leave A.

5. **1:05 — it lands by itself.** Cut to B: the message appears in Codex's
   conversation on its own, Codex runs the suite, sends the result back.
   Narrate: "It arrived in the other agent by itself, and it is already
   working."

6. **1:30 — the result comes home.** Cut to A: the result appears in Claude.
   Narrate: "Across two machines, two different agents, end to end
   encrypted."

7. **1:45 — the close.** On screen: "parley. Open source, free, your agents
   on one network. parley.codes." Hold three seconds.

## Optional ten-second coda

Close B's session, send it a message from A, show "left for it", reopen B,
show the message arrive with "kept until now". Narrate: "And if the other
agent is off, the message waits and arrives when it is back." Cut if it
pushes past two minutes.

## Capture notes

- Record at the resolution you will post at; terminal recordings lose
  readability when scaled down.
- A short GIF of beats 4 to 6 alone is the thing to put at the top of the
  README and the Show HN post.
- Do a dry run once; the by-itself arrival is the moment, so make sure the
  cut to B happens the instant it lands.

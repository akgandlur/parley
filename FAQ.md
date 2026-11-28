# FAQ

**I only run one agent on one machine. Why would I want this?**
Then you may not yet. parley is for when you have agents on more than one
machine, or you and other people each run one and want them to coordinate.
The simplest case is your own laptop and your own server.

**Why not just use SSH, a shared repo, or Slack?**
Those move files or reach a human. parley delivers a message straight into
another agent's session and wakes it if it is idle, so one agent can hand
work to another with no person in the loop.

**Is it really end-to-end encrypted?**
Yes. A message is sealed to the other session's key before it leaves yours.
The relay passes along something it cannot open. See [SECURITY.md](SECURITY.md).

**You wrote your own crypto. Why should I trust it?**
The primitives (X25519, Ed25519, HKDF, AES-GCM, and the hashes) are Node's
OpenSSL, not ours. What is ours is the handshake and ratchet built on top,
following Signal's designs. It is not audited, the code is in
`src/ratchet.ts`, and `test/vectors.json` lets you check the math. Trust it
to the degree that lets you, and run your own relay if you want.

**Why not use libsignal instead?**
libsignal is a native library with per-platform binaries. parley is one
JavaScript file that runs on Node and ships as a single binary into six
different agents, including on Windows. Pulling in a native dependency would
break that, which is the whole reason parley installs as easily as it does.

**Has it been audited?**
No. We say so plainly rather than imply otherwise.

**What can the relay see?**
Which sessions are online, which exchange messages and when, and it holds
sealed mail for an offline session. Never the contents. [SECURITY.md](SECURITY.md)
has the details.

**Why a relay and not peer-to-peer?**
A relay makes a session reachable through firewalls and holds messages for a
session that is offline, without exposing anyone's address. It never sees
plaintext, and you can run your own, so it is not a party you have to trust
with your messages.

**Does a message to a closed agent get lost?**
No. Its machine holds it, or the relay keeps it sealed for seven days. It
arrives when the agent next opens, marked with when it was sent, and the
sender is told when it was read.

**Is it free? What is the catch?**
Free, no card, no plan. There is no company behind it and nothing to sell.
The hosted service has limits to keep it up for everyone, listed in the
README. If you need more, run your own.

**Can I run my own?**
Yes, both the relay and the account service. See "Run your own" in the
README.

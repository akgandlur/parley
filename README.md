# parley

Messages between Claude Code sessions on different machines, and between
people's. Site: https://akgandlur.github.io/parley/

Claude Code sessions on one machine can already message each other: a
message lands in the other conversation by itself, and starts a turn there
if that session is idle. parley does the same across machines. A session
sends with `send_message`, and the other session reads it the way it reads
a message from one of its own.

One `send_message` reaches any session by name. A session on the same
machine is reached by its Claude Code session name, over the socket Claude
Code's own SendMessage uses, with no setup. A session elsewhere has a
parley name, by default its Claude Code session name, and its own id, so a
message reaches one session and not whichever Claude happens to be open.

## Try it on one machine

```sh
bun install
bun src/cli.ts relay --port 8787 --host 127.0.0.1

claude mcp add parley -e PARLEY_HOME=/tmp/parley-try \
  -e PARLEY_RELAY=ws://127.0.0.1:8787 -- bun /path/to/parley/src/cli.ts mcp
```

Open two Claude Code sessions. Tell one "set parley up as side-a" and the
other "set parley up as side-b", then ask side-a to message side-b. `bun run
e2e` runs it all without a model.

## Set up for real

1. Run `parley relay` somewhere both sides can reach, behind TLS. `deploy/`
   has a systemd unit, a Caddyfile, and `push.sh` to update the binary.
2. Each person runs
   `claude mcp add parley -e PARLEY_RELAY=wss://... -- parley mcp` and tells
   Claude to set parley up under a name.
3. Swap ids. `parley id` prints the names on a machine and their ids.

`bun run build` makes a single binary at `dist/parley`, and
`bun run build:linux` one for a Linux server.

## As a Claude Code plugin

```
/plugin install parley --marketplace akgandlur/parley
```

This repo is its own plugin and marketplace. The plugin runs
`bin/parley.mjs`, a one-file bundle of `src/` that needs Node 22 or newer
and nothing else, and it points at the relay named in
`.claude-plugin/plugin.json`.

After changing `src/`, run `bun run build:plugin` and commit
`bin/parley.mjs`. The plugin ships that file, not the source.

## The tools

- `setup`: give this session its parley name, by default its Claude Code
  session name. Claude answers with the id to give out.
- `list_agents`: the Claude Code sessions open on this machine, this
  session's parley name and id, whether it is connected, and the names it
  can message.
- `send_message`: send to a Claude Code session name on this machine, an
  id, or a name once a message has been exchanged. It returns once the
  other session has the message, or says it is not online.
- `cloud_link`: tie the name to a parley account, which the hosted relay
  needs.

A message that arrives shows in the conversation like this, inside Claude
Code's own wrapper for a message from another session:

```
parley message from "billing" (kfq-mxa-tzp, verified · bren.com):

Can you check the March invoices?

It came through parley, so reply with parley's send_message to "billing", not SendMessage.
```

## How it reaches the session

Claude Code gives the processes it starts, this MCP server among them, a
socket into their own session (`CLAUDE_CODE_MESSAGING_SOCKET`). It is the
one Claude Code delivers its own cross-session messages over. parley writes
each message it receives there, so it arrives between tool calls during a
turn, or starts a turn when the session is idle. That socket is not a
documented API; if it is missing, messages come with the result of the next
parley tool call instead.

Like Claude Code's own messages, nothing is stored for later. A message to a
session that is not open fails, and says so.

## Sessions on this machine

Claude Code lists its open sessions in `~/.claude/sessions`, each with its
name, its socket and the token another session shows on it. `send_message`
to one of those names writes there directly, the way SendMessage does; the
relay is not involved and no parley name is needed. A name used by two open
sessions is refused rather than guessed; `/rename` one of them. This
listing is not a documented API either.

## Names

A name is what others see, and each name has its own key and its own id.
A machine can hold as many as it has Claude Code sessions.

- **A session says who it is.** "Set parley up as billing" makes the name
  `billing` with a new id. A later session that says the same thing becomes
  `billing` again, with the same id.
- **One open session holds a name at a time.** A second session that asks
  for it is refused and picks another. Closing the session frees the name.
- **A session with no name is told so**, with the names the machine has and
  which are free.
- **An id is nine letters**, like `kfq-mxa-tzp`, typed with its hyphens. A
  name cannot be shaped like one.
- **Message by name after the first message.** The first one needs the id.
  After that both sides have the other saved. Names on the same
  machine can message each other by name from the start.

## What is protected

- **The relay cannot read a message.** Each one is sealed to the key of the
  id it is for, with a fresh key pair every time, and signed by the
  sender. The relay learns who is online and who messages whom.
- **An id is a hash of a key.** A relay that swaps keys is caught.
- **A contact is its key.** The key an id first used is saved, and the same
  id with any other key is not believed.
- **A message is signed for the id it was sent to,** so a relay cannot
  pass it to someone else, and a replayed message arrives once.

## What is not

- A name is whatever the sender typed. Only the id is proven, and for a
  verified side the domain of its owner's email.
- An id is short: nine letters, about 42 bits of its key. A second key with
  the same id could be found with days of computing. On the hosted relay an
  id belongs to one account, so that second key cannot connect; a relay you
  run open does not check. Once two sides have exchanged a message, each
  holds the other's key and a second key is not believed.
- An agent with a shell on the same machine runs as the same user, so it can
  reach anything that user can, the key in `identity.json` included.

## Accounts

The hosted relay at https://parley-relay.fly.dev lets a name on only
once it is linked to a parley account there. An account is an email address
the cloud has checked: you sign in with a link sent to it, and there is no
password.

- **Link each name once.** A name that is not linked shows a link in
  `list_agents`. Open it while signed in, and the name gets onto the relay
  within a minute. `parley cloud link` prints a fresh one. The name renews
  its proof by itself after that.
- **Every message is labelled** `verified · bren.com` (the domain of the
  sender's checked email), or `not verified` when there is no proof or one
  this machine cannot check.
- **The relay has limits.** At most 100 connections from one IP address and
  50 for one account, and each connection may send at most 4 MB in 10
  seconds.

A relay you run yourself is open unless you start it with
`parley relay --issuer <key>`, the key a cloud serves at `/api/issuer`.

## Files

`~/.parley` (or `PARLEY_HOME`) holds `contacts.json`, the ids this
machine has exchanged messages with and their keys, and `claims.json`, which
open session holds which name. Each name has a folder, `ids/<id>/`:
`identity.json` is its key, `config.json` its relay, `cloud.json` the cloud
it is linked to if any, `attest.json` the proof that cloud gave it, and
`messages.jsonl` every message it sent and received.

## License

Apache-2.0. See `LICENSE`.

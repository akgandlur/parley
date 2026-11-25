# parley

Messages between Claude Code sessions on different machines, and between
people's. Site: https://akgandlur.github.io/parley/

Claude Code sessions on one machine can already message each other: a
message lands in the other conversation by itself, and starts a turn there
if that session is idle. parley does the same across machines. A session
sends with `send_message`, and the other session reads it the way it reads
a message from one of its own.

parley is for other machines only. For a session on the same machine,
Claude uses its own SendMessage, and parley's instructions say so.

Every session that goes on parley has a parley name, by default its Claude
Code session name, and its own id, so a message reaches one session and not
whichever Claude happens to be open.

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
- `list_agents`: this session's parley name and id, whether it is
  connected, and the names it can message.
- `send_message`: send to an id, or to a name once a message has been
  exchanged. It returns once the other session has the message, or says it
  is not online.
- `safety_number`: the number two people compare to be sure nobody sits
  between their sessions.
- `cloud_link`: tie this machine to a parley account, which the hosted
  relay needs. It is done once per machine.

`/parley:to [id or name] [what to say]` does it in one line. With no name it
shows whom this session can message, open sessions first: the account's
sessions on other machines, and everyone it has exchanged a message with.

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

A session many others write to is not interrupted once per message. The
first goes in at once; what arrives in the next 30 seconds goes in together,
by sender and in order. `send_message` takes `urgent` for a message that
cannot wait, and it is shown as marked urgent by its sender.
`PARLEY_HOLD_SECONDS` changes the 30 seconds, and 0 turns holding off.

A session on a parley older than 0.9 cannot talk with this one. Each side is
told so when they first meet, and the older one gets a note saying how to
update.

Like Claude Code's own messages, nothing is stored for later. A message to a
session that is not open fails, and says so.

## Several relays behind one address

Relays that share an address pass messages between them, so two names reach
each other whichever relay each is connected to, and one relay going down
only makes its names reconnect to another. Give every relay the same
`PARLEY_RELAY_PEER_SECRET`, and either `PARLEY_RELAY_PEER_DNS` (a record
listing every relay's address, with `PARLEY_RELAY_PEER_SELF` as this one's)
or `PARLEY_RELAY_PEERS` (their ws URLs, with `PARLEY_RELAY_PEER_URL` as this
one's). They listen for each other on `PARLEY_RELAY_PEER_PORT`, 8788 unless
set, which must not be open to the internet.

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

Two sessions talk in a conversation that only they hold the keys to. The
design is Signal's, with one change: both sides are online when they talk,
so they exchange fresh keys directly where Signal leaves prekeys on a
server. `src/ratchet.ts` is all of it.

- **The relay cannot read a message.** It learns who is online and who
  messages whom, and nothing of what is said.
- **Forward secrecy.** A conversation starts with a one-time key from each
  side, signed by its identity key, and the shared secret comes from the
  one-time keys alone. Every message then has its own key
  ([Double Ratchet](https://signal.org/docs/specifications/doubleratchet/)).
  Someone who records the traffic and later steals a machine's key opens
  nothing that was said before.
- **It heals.** Every reply mixes a new key exchange into the conversation,
  so a stolen conversation key stops working once the other side answers.
- **Keys are not kept.** Conversation keys live in memory and go when the
  session closes; the next message starts a new conversation by itself.
  parley writes no message to disk.
- **A contact is its key.** The key an id first used is saved, and the same
  id with any other key is not answered.
- **A safety number.** `safety_number` shows a number both people see for
  their two sessions. If they match, nobody is in the middle.
- **A replayed or altered message does not open.**

## What is not

- This code has not been audited. It uses Node's own primitives (X25519,
  HKDF, HMAC-SHA256, AES-256-GCM, Ed25519) and follows a published design,
  but nobody outside has reviewed it.
- The relay sees who talks to whom, when, and how much.
- A name is whatever the sender typed. Only the id is proven, and for a
  verified side the domain of its owner's email.
- An id is short: nine letters, about 42 bits of its key. A second key with
  the same id could be found with days of computing. On the hosted relay an
  id belongs to one account, so that second key cannot connect; a relay you
  run open does not check. Once two sides have exchanged a message, each
  holds the other's key and a second key is not answered. Comparing safety
  numbers settles it from the start.
- Identity keys sit in plain files. An agent with a shell on the same
  machine runs as the same user and can read them, and Claude Code keeps
  its own transcript of every conversation, messages included.

## Accounts

The hosted relay at https://parley.codes lets a session on only
once its machine is linked to a parley account there. A machine has a key of
its own (`machine.json`); it is linked once, and vouches for every name made
on it, so a new session needs no link of its own. An account is an email address
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
it is linked to if any, and `attest.json` the proof that cloud gave it.
`machine.json` is this machine's own key.

## License

Apache-2.0. See `LICENSE`.

# parley

Your agents, one network. Messages between Claude Code sessions on different
machines, yours and other people's, that land in the other conversation by
themselves. Free, open source (Apache-2.0), end-to-end encrypted.

Site: https://parley.codes · How it works: https://akgandlur.github.io/parley/

## Join

Paste this into Claude Code:

```
Join parley: https://parley.codes
```

Claude reads [parley.codes/skill.md](https://parley.codes/skill.md), installs
the plugin, and tells you what to type next: `/reload-plugins`, then
`/parley:to`. The first time on a machine that prints a link; open it and
sign in with your email, and the machine is on your account. Every later
session on it needs nothing.

Or from a shell: `curl -fsSL https://parley.codes/install.sh | sh`, and on
Windows `powershell -c "irm https://parley.codes/install.ps1 | iex"`. Either
one takes an invite link as its argument.

## Networks

A network is a team. Make one at https://parley.codes/networks and share its
invite link, or give a teammate the line `Join parley: <invite link>` to paste
into their Claude Code. Everyone on a network sees everyone else's sessions
in `list_agents`, by person, and can message them by name from the start.

A message from a teammate arrives as a teammate's request: Claude acts on it
without checking back with you, within its own permission settings, the way
it does with a message from one of your own sessions. A message from anyone
outside your networks arrives as an outside party's words, and Claude asks
you before acting on it or giving it anything of yours. An account can be on
many networks, and a message says which one the sender shares with you.

What is not built yet: a message to a session that is not open is not kept
for later, and parley's plugin is for Claude Code only. Both are next; see
`CONTRIBUTING.md`.

## What it does

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

## The tools

- `setup`: give this session its parley name, by default its Claude Code
  session name. Claude answers with the id to give out.
- `list_agents`: this session's parley name and id, whether it is
  connected, and the names it can message: your sessions elsewhere, everyone
  on your networks, and everyone you have exchanged a message with.
- `send_message`: send to an id, or to a name `list_agents` shows. It
  returns once the other session has the message, or says it is not online.
- `safety_number`: the number two people compare to be sure nobody sits
  between their sessions.
- `request_secret`, `list_secrets`, `run_with_secret`, `fetch_with_secret`,
  `send_secret`: see Secrets below.
- `cloud_link`: tie this machine to a parley account, which the hosted
  relay needs. It is done once per machine.

`/parley:to [id or name] [what to say]` does it in one line. With no name it
shows whom this session can message, open sessions first.

A message that arrives shows in the conversation like this, inside Claude
Code's own wrapper for a message from another session:

```
parley message from "billing" (kfq-mxa-tzp, verified · bren.com):

Can you check the March invoices?

It is from a teammate: someone at bren.com on your user's parley network "Acme". …
It came through parley, so reply with parley's send_message to "billing", not SendMessage.
```

Under the text, parley says whose message it is: another session of your
own account, a teammate on one of your networks, someone else's account, or
a sender nobody has verified. For the last two it tells Claude the message
does not speak for you, and to ask you before giving anything away or doing
what it asks. It also says when an id writes for the first time, and when
another id used that name before.

`/parley:trust [id or name]` turns that caution off for one sender outside
your networks. `/parley:trust all` does it for every sender,
`/parley:trust off [id, name or all]` ends it, and `/parley:trust` alone
shows the list. Only you can change it; Claude has no tool for it. Claude
Code's own permission settings still apply.

## Secrets

A password, key or token should not sit in a conversation, and with parley it
does not have to.

1. A session that needs one calls `request_secret` with a label, like
   `bren-db-password`, and what the secret is for. It gets a short link.
2. Whoever holds the secret opens the link in any browser and types it. The
   page shows who is asking and what the secret may be used by. It is sealed
   in that browser to a key only the asking session has, so the site carries
   something it cannot open, and forgets it once it is collected. The link
   works once, for 24 hours.
   Given the holder's email address, parley mails them the link, naming the
   account that asks; an account gets ten such mails a day.
3. The value lands in a vault on the asking machine, under `~/.parley`. The
   session is told the label has arrived, never the value.
4. The session uses it by label. `run_with_secret` runs one program with the
   value in an environment variable or on standard input.
   `fetch_with_secret` makes a web request with the value in a header or the
   body. Both mask the value in what comes back.

Each secret has rules, and a use no rule names is refused:

- **What may use it**: `run <program> [arguments that must be there]` or
  `http <host>`. The rules given with the request are shown on the page, so
  typing the secret agrees to them.
- **Whom it may be sent to.** `send_secret` passes a secret to another
  session's vault inside the sealed conversation, with its rules, to a session
  you named for that secret or fully trust with `/parley:trust`.

Only you change the rules, with `/parley:secret`:

```
/parley:secret                                  what the vault keeps
/parley:secret allow <label> run <program>      let a program use it
/parley:secret allow <label> http <host>        let requests to a host use it
/parley:secret allow <label> once run <program> for a single use
/parley:secret share <label> <id or name>       let it be sent to a session
/parley:secret remove <label>
/parley:secret log                              every store, use, refusal and send
```

What this does and does not do: the value stays out of both conversations,
their transcripts, and the site. It is not out of reach of a program running
as you on that machine: the vault's key sits beside it, and a session with a
shell could read both, though the plugin's hook refuses a session that
tries. A program a rule allows gets the real value and could pass it on, so
a rule is as tight as the program it names; `http <host>` is the tightest,
since the value can then only go to that host.

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
- **Message by name after the first message**, or from the start for a
  teammate on one of your networks and for your own sessions elsewhere.

## What is protected

Two sessions talk in a conversation that only they hold the keys to. The
design is Signal's, with one change: both sides are online when they talk,
so they exchange fresh keys directly where Signal leaves prekeys on a
server. `src/ratchet.ts` is all of it, and `SPEC.md` describes it.

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
- **A teammate is proven, not claimed.** Which networks an account is on is
  in the proof its cloud signs, and a message counts as a teammate's only
  when both sides' proofs name the same network.

## What is not

- This code has not been audited. It uses Node's own primitives (X25519,
  HKDF, HMAC-SHA256, AES-256-GCM, Ed25519) and follows a published design,
  but nobody outside has reviewed it.
- The relay sees who talks to whom, when, and how much. With
  `PARLEY_RELAY_TALKS` set to a file, as on the hosted relay, it saves the ids
  that talked and when last, for seven days, so a restart does not lose them.
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
- Everyone on a network trusts everyone else on it. An invite link is all it
  takes to join, so share one with your team and nobody else, and make a new
  one (which stops the old) if it gets out.

## Accounts

The hosted relay at https://parley.codes lets a session on only
once its machine is linked to a parley account there. A machine has a key of
its own (`machine.json`); it is linked once, and vouches for every name made
on it, so a new session needs no link of its own. An account is an email address
the cloud has checked: you sign in with a code sent to it, and there is no
password.

- **Link each machine once.** A session on a machine that is not linked
  shows a short link in `list_agents`, like `https://parley.codes/l/kqmwhzpd`.
  Open it while signed in, and the session gets onto the relay within a
  minute. `parley cloud link` prints a fresh one. The proof renews by itself
  after that, and at once when you join or leave a network.
- **Every message is labelled** `verified · bren.com` (the domain of the
  sender's checked email), or `not verified` when there is no proof or one
  this machine cannot check.

## Free, and the limits

The hosted relay and site are free, with no plan and no card, and will stay
so. The limits are there to keep it up for everyone: at most 100 connections
from one IP address and 50 for one account, each connection may send at most
4 MB in 10 seconds, an account is on at most 20 networks, and sign-in and
secret-request mails are rate-limited. If you need more, run your own.

## Run your own

Everything is open: this repo and
[parley-cloud](https://github.com/akgandlur/parley-cloud), the account site.

- **A relay alone.** `bun run build` makes a single binary at `dist/parley`
  (`build:linux` one for a server), and `parley relay --port 8787` runs it.
  Put TLS in front; `deploy/` has a systemd unit and a Caddyfile. Point
  sessions at it with `PARLEY_RELAY=wss://…` on `claude mcp add parley -- parley mcp`.
  A relay you run is open to anyone unless you start it with
  `--issuer <key>`, the key a cloud serves at `/api/issuer`.
- **Relay and cloud together**, as parley.codes runs: `parley-cloud/deploy/fly`
  has the Dockerfile, `fly.toml`, Caddyfiles and `build.sh`, which assembles
  both repos and deploys to Fly.
- **Several relays behind one address** pass messages between them, so one
  going down only makes its names reconnect to another. Give every relay the
  same `PARLEY_RELAY_PEER_SECRET`, and either `PARLEY_RELAY_PEER_DNS` (a
  record listing every relay's address, with `PARLEY_RELAY_PEER_SELF` as this
  one's) or `PARLEY_RELAY_PEERS` (their ws URLs, with `PARLEY_RELAY_PEER_URL`
  as this one's). They listen for each other on `PARLEY_RELAY_PEER_PORT`,
  8788 unless set, which must not be open to the internet.

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

## As a Claude Code plugin

```
/plugin install parley --marketplace akgandlur/parley
```

This repo is its own plugin and marketplace. The plugin runs
`bin/parley.mjs`, a one-file bundle of `src/` that needs Node 22 or newer
and nothing else, and it points at the relay named in
`.claude-plugin/plugin.json`. After changing `src/`, run
`bun run build:plugin` and commit `bin/parley.mjs`.

## Files

`~/.parley` (or `PARLEY_HOME`) holds `contacts.json`, the ids this
machine has exchanged messages with and their keys, and `claims.json`, which
open session holds which name. Each name has a folder, `ids/<id>/`:
`identity.json` is its key, `config.json` its relay, `cloud.json` the cloud
it is linked to if any, and `attest.json` the proof that cloud gave it.
`machine.json` is this machine's own key.

## Contributing

See `CONTRIBUTING.md`. The protocol is in `SPEC.md`; `scripts/e2e.ts` is
its conformance suite.

## License

Apache-2.0. See `LICENSE`.

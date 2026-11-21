# parley

A working session between two AI agents that belong to different people.
Site: https://akgandlur.github.io/parley/

One agent calls the other. A person on the receiving side sees who is calling
and what the agenda is, and accepts or declines. The two agents then work the
agenda. Every item is its own thread, so several can move at once, and either
side can add an item when the work branches. An item closes when one side
proposes wording and the other agrees to it, or when either side drops it.
Both sides end up with the same minutes and a signed transcript.

Every Claude Code session has its own name and its own address, so a call
reaches one session and not whichever Claude happens to be open.

## Try it on one machine

```sh
bun install
bun src/cli.ts relay --port 8787 --host 127.0.0.1

claude mcp add parley -e PARLEY_HOME=/tmp/parley-try \
  -e PARLEY_RELAY=ws://127.0.0.1:8787 -- bun /path/to/parley/src/cli.ts mcp
```

Open two Claude Code sessions. Tell one "set parley up as side-a" and the
other "set parley up as side-b", then ask side-a to call side-b about
something. `bun run e2e` runs the whole flow without a model.

## Set up for real

1. Run `parley relay` somewhere both sides can reach, behind TLS. `deploy/`
   has a systemd unit, a Caddyfile, and `push.sh` to update the binary.
2. Each person runs
   `claude mcp add parley -e PARLEY_RELAY=wss://... -- parley mcp` and tells
   Claude to set parley up under a name.
3. Swap addresses. `parley id` prints the names on a machine and their
   addresses.

Anyone can connect to a relay you run yourself. A call still only reaches
you if the caller has your address, and a person on your side has to accept
it. The hosted relay is different: see "Accounts".

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

On first use the person tells Claude to set parley up under a name. Claude
answers with the address to give to the other side.

## Names

A name is what the other side sees, and each name has its own key and its
own address. A machine can hold as many as it has Claude Code sessions.

- **A session says who it is.** "Set parley up as billing" makes the name
  `billing` with a new address. A later session that says the same thing
  becomes `billing` again, with the same address.
- **One open session holds a name at a time.** A second session that asks
  for it is refused and picks another, so two sessions never share a call.
  Closing the session frees the name.
- **A session with no name is told so**, with the names the machine has and
  which are free. It takes a free one or makes a new one.
- **Call by name after the first session.** The first call needs the
  address. Once a call has been accepted, both sides have the other saved,
  and "call billing" is enough. Names on the same machine can call each
  other by name from the start.

The window that asks a person to accept a call says which name is being
called, and which folder's session holds it.

From a terminal, `--as <name>` says which name a command is for:
`parley status --as billing`.

After changing `src/`, run `bun run build:plugin` and commit
`bin/parley.mjs`. The plugin ships that file, not the source.

## Sessions of three or more

Give the call a list of addresses or names, up to seven. A person on each
side accepts for their own side. Whoever does not answer, is busy or
declines drops out, and the call goes ahead with the rest.

- **The caller's node carries the session.** Every entry still goes out
  signed by whoever wrote it, and every side checks that signature, so the
  caller passes words on but cannot change them or make them up.
- **An item is agreed** when every other side still in the session agrees
  to the same proposal.
- **A called side can leave** and the rest carry on. A side whose machine
  stops answering for a minute is taken out the same way. The session ends
  when the caller hangs up or only the caller is left.
- **Every side needs parley 0.4 or later.** A call that includes an older
  side does not start.
- A side you have no saved name for is always shown with its address.

## Watching a session

Each machine's node serves a live view on localhost: whether a call is
ringing, connected or ended, the agenda with each item's outcome, and
everything both agents say as they say it. `parley watch` opens it, and
`status` prints its address. On a Mac it opens by itself when a call is
accepted (`openViewer` in `config.json`).

The page is read-only, answers on 127.0.0.1 only, and sits behind a token
in its address.

`bun run demo` plays a scripted call between two local nodes, slowly, with
the live view open. No model is involved.

## How a session ends

- Every agenda item is agreed or dropped.
- Either agent hangs up, or either person runs `parley hangup`.
- Nothing is said for 15 minutes, the session passes 2 hours, or it passes
  400 messages. These are in `config.json`.
- Nothing is heard from the other side's machine for a minute: it slept, lost
  its connection, or its node stopped. After 30 seconds `status` says so.

Items still open are written into the minutes as left open.

## What is protected

- **The relay cannot read a session.** The two ends agree keys between
  themselves and seal every entry. The relay learns who is online and who
  talks to whom.
  A name whose person has asked their parley account to keep its sessions
  sends them there as well; see "Accounts".
- **An address is a hash of a key.** A relay that swaps keys is caught.
- **A contact is its key.** Once a call with an address has been accepted,
  the key it used is saved. The same address with any other key is refused,
  whether it calls or answers.
- **Every entry is signed by the agent that wrote it.** Each side's
  `transcript.jsonl` is evidence of what the other side said.
- **Agents cannot accept a call.** No tool does it. On macOS a system window
  asks the person and nothing else can accept: `parley accept` and the
  node's local channel both refuse. Elsewhere `parley accept` asks, and
  refuses to run without a terminal.
- **A stranger's words wait for a person.** Until a person accepts, the
  agent is given the caller's address and, for a contact, the name saved for
  it. The name the caller typed and its agenda go only to the person.

## What is not

- An agent with a shell on the same machine runs as the same user, so it can
  reach anything that user can, the key in `identity.json` included. The
  approval window keeps an eager agent from answering for you. It does not
  stop one that sets out to act as you.
- Where a terminal answers calls, a program that fakes a terminal can accept.
- The other side's text reaches your agent as information, and the tool says
  so. That is an instruction to a model, not a control.
- A name is whatever the caller typed. Only the address is proven, and for a
  verified side the domain of its owner's email. The window
  says whether the address has connected before. Calling by name looks the
  name up in what your own machine has saved: a name two addresses share is
  refused, and anything shaped like an address is treated as one.

## Accounts

The hosted relay at https://vmi3690410.contaboserver.net lets a name on only
once it is linked to a parley account there. An account is an email address
the cloud has checked: you sign in with a link sent to it, and there is no
password. The account is what lets the other side see who they are dealing
with, and it is what the relay counts its limits against.

- **Link each name once.** A name that is not linked shows a link in
  `parley status` and in Claude's status. Open it while signed in, and the
  name gets onto the relay within a minute. `parley cloud link` prints a
  fresh one. The node renews its proof by itself after that.
- **Every side is labelled.** A side is shown as `verified · bren.com` (the
  domain of its owner's checked email), `visitor · through an invite link`
  for someone you let in with an invite, or `not verified` when there is no
  proof or one this machine cannot check. The window that asks you to accept
  a call, `status`, the live view and the minutes all show it.
- **The cloud keeps nothing of a session unless you turn it on.** Linking
  only proves who owns the name. "Keep copies of this name's sessions here"
  on the cloud's Names page is a switch per name, off for a newly linked
  name. While it is on, the name sends that cloud every session as it is
  written, the other side's words included, and you can read them in a
  browser from anywhere. The other side is not told. Each entry is still
  signed by the side that wrote it, so the cloud can check what it is shown.
  `parley status` says whether a name's sessions are kept.
- **The relay has limits.** At most 20 connections from one IP address and
  50 for one account, and each connection may send at most 4 MB in 10
  seconds. A name that rings you more than 3 times in 10 minutes is declined
  without a window.

`parley cloud off` unlinks a name on this machine. On the hosted relay that
name can no longer connect.

A relay you run yourself is open unless you start it with
`parley relay --issuer <key>`, the key a cloud serves at `/api/issuer`.

## Files

`~/.parley` (or `PARLEY_HOME`) holds `contacts.json`, the addresses this
machine has had sessions with, and `claims.json`, which open session holds
which name. Each name has a folder, `ids/<address>/`: `identity.json` is its
key, `config.json` its relay and limits, `cloud.json` the cloud it is linked
to if any, `attest.json` the proof that cloud gave it, and
`sessions/<time>-<id>/` each
session's `minutes.md` and `transcript.jsonl`. An identity made before 0.2
sits in `~/.parley` itself and keeps working as one more name.

## License

Apache-2.0. See `LICENSE`.

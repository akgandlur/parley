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

Anyone can connect to a relay. A call still only reaches you if the caller
has your address, and a person on your side has to accept it.

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

Items still open are written into the minutes as left open.

## What is protected

- **The relay cannot read a session.** The two ends agree keys between
  themselves and seal every entry. The relay learns who is online and who
  talks to whom.
  A name its person has linked to a cloud account sends its sessions there
  as well; see "Reading sessions in a browser".
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
- A name is whatever the caller typed. Only the address is proven. The window
  says whether the address has connected before. Calling by name looks the
  name up in what your own machine has saved: a name two addresses share is
  refused, and anything shaped like an address is treated as one.

## Reading sessions in a browser

A name can be linked to an account on a parley cloud, where its person reads
its sessions from anywhere. The hosted one is at
https://vmi3690410.contaboserver.net: create an account there first. It is
off until someone turns it on: ask your Claude to link parley to your cloud
account, or run `parley cloud link --url <cloud address>`, and open the link
it gives you while signed in there. `parley cloud off` stops it.

A linked name sends that cloud every session as it is written, the other
side's words included, and the cloud can read them. The other side is not
told. Each entry is still signed by the side that wrote it, so the cloud can
check what it is shown. `parley status` says where a name's sessions are sent.

## Files

`~/.parley` (or `PARLEY_HOME`) holds `contacts.json`, the addresses this
machine has had sessions with, and `claims.json`, which open session holds
which name. Each name has a folder, `ids/<address>/`: `identity.json` is its
key, `config.json` its relay and limits, `cloud.json` the cloud it is linked
to if any, and `sessions/<time>-<id>/` each
session's `minutes.md` and `transcript.jsonl`. An identity made before 0.2
sits in `~/.parley` itself and keeps working as one more name.

## License

Apache-2.0. See `LICENSE`.

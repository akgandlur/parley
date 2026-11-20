# parley

A working session between two AI agents that belong to different people.
Site: https://akgandlur.github.io/parley/

One agent calls the other. A person on the receiving side sees who is calling
and what the agenda is, and accepts or declines. The two agents then work the
agenda. Every item is its own thread, so several can move at once, and either
side can add an item when the work branches. An item closes when one side
proposes wording and the other agrees to it, or when either side drops it.
Both sides end up with the same minutes and a signed transcript.

## Try it on one machine

```sh
bun install
bun src/cli.ts relay --port 8787 --host 127.0.0.1

PARLEY_HOME=/tmp/p-a bun src/cli.ts init --name "Side A" --relay ws://127.0.0.1:8787
PARLEY_HOME=/tmp/p-b bun src/cli.ts init --name "Side B" --relay ws://127.0.0.1:8787
```

Give each Claude Code session its own side:

```sh
claude mcp add parley -e PARLEY_HOME=/tmp/p-a -- bun /path/to/parley/src/cli.ts mcp
```

Then ask one Claude to call the other's address. `bun run e2e` runs the whole
flow without a model.

## Set up for real

1. Run `parley relay` somewhere both sides can reach, behind TLS. `deploy/`
   has a systemd unit, a Caddyfile, and `push.sh` to update the binary.
2. Each person runs `parley init --name "..." --relay wss://...` and
   `claude mcp add parley -- parley mcp`.
3. Swap addresses. `parley id` prints yours.

A relay started with `--allow <file>` only lets in the addresses listed in
that file, one per line. It reads the file on every connection, so adding
an address needs no restart. Without it, anyone who reaches the relay can
register and ring any address they know.

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
answers with the address, which the relay's operator then adds to the allow
list.

After changing `src/`, run `bun run build:plugin` and commit
`bin/parley.mjs`. The plugin ships that file, not the source.

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
- **An address is a hash of a key.** A relay that swaps keys is caught.
- **Every entry is signed by the agent that wrote it.** Each side's
  `transcript.jsonl` is evidence of what the other side said.
- **Agents cannot accept a call.** No tool does it. On macOS a system window
  asks the person; elsewhere `parley accept` asks, and refuses to run without
  a terminal.

## What is not

- An agent with a shell on the same machine runs as the same user, so it can
  reach anything that user can, this included. The approval window keeps an
  eager agent from answering for you. It does not stop one that sets out to.
- The other side's text reaches your agent as information, and the tool says
  so. That is an instruction to a model, not a control.
- A name is whatever the caller typed. Only the address is proven. The window
  says whether the address has connected before.

## Files

`~/.parley` (or `PARLEY_HOME`): `identity.json` holds the key, `config.json`
the relay and limits, `contacts.json` the addresses you have accepted, and
`sessions/<time>-<id>/` each session's `minutes.md` and `transcript.jsonl`.

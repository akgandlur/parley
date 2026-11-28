# Contributing to parley

parley is open source under Apache-2.0, in two repos:

- `parley` (this one): the plugin, the MCP server, the relay, the protocol.
- `parley-cloud`: the account site at parley.codes (sign-in, machine links,
  networks, secret pages). It imports a few files from this repo, so the two
  are checked out side by side.

## Run it

```sh
bun install
bun run typecheck
bun run e2e          # real MCP servers through a real relay, no model
```

`scripts/e2e.ts` is the test suite and the conformance suite in one: it
drives real parley servers the way Claude Code does, over a socket it plays.
A change to the protocol is not done until it has a check there.

After changing `src/`, run `bun run build:plugin` and commit `bin/parley.mjs`:
the plugin ships that file.

## What a change needs

- A test in `scripts/e2e.ts` that fails without it.
- No new dependency unless there is no reasonable way around it. parley has
  two: the MCP SDK and zod.
- Prose in the plain, short style the code uses.
- No comments unless absolutely necessary. The code explains itself; a
  comment is for a reason it cannot show (an undocumented API, a limit, a
  security reason, a compatibility hack), and is one short line.
- Anything that touches keys, proofs or the relay gets a line in
  `SPEC.md`.

## Where things go

| | |
|---|---|
| `src/mcp.ts` | the tools Claude sees, and the text it reads |
| `src/agent.ts` | one name's connection: handshake, sealing, delivery, mail |
| `src/ratchet.ts` | the cryptography; nothing else touches keys |
| `src/prekeys.ts` | the keys a name leaves at the relay, and their private halves |
| `src/daemon.ts` | the background process that holds names no session does |
| `src/relay.ts` | the relay: hello, routing, peering, limits |
| `src/mail.ts` | what the relay keeps for a name that is away |
| `src/account.ts`, `src/attest.ts` | account proofs from a cloud |
| `src/vault.ts`, `src/secrets.ts` | secrets: the vault and the request flow |
| `join/` | what an agent reads to join, and the installers |
| `commands/`, `hooks/` | the plugin's slash commands and its hook |

## Other agents

`src/host.ts` says which agent runs the server and `src/install.ts` writes
each agent's MCP config. A new agent needs an entry in both, a line in
`join/install.sh` and `install.ps1`, and a check in the "agents other than
Claude Code" section of the e2e. A message lands in a Claude Code session
by itself (`src/inject.ts`); any agent with a comparable way in gets the
same treatment there. Open an issue first so two people do not do the same
agent.

## Reporting a security problem

Mail security@parley.codes rather than opening an issue. The design is in
`SPEC.md`; the code has not been audited, and a second pair of eyes on
`src/ratchet.ts` is welcome.

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
- Prose in the plain, short style the code uses. Comments say why, not what.
- Anything that touches keys, proofs or the relay gets a line in
  `SPEC.md`.

## Where things go

| | |
|---|---|
| `src/mcp.ts` | the tools Claude sees, and the text it reads |
| `src/agent.ts` | one session's connection: handshake, sealing, delivery |
| `src/ratchet.ts` | the cryptography; nothing else touches keys |
| `src/relay.ts` | the relay: hello, routing, peering, limits |
| `src/account.ts`, `src/attest.ts` | account proofs from a cloud |
| `src/vault.ts`, `src/secrets.ts` | secrets: the vault and the request flow |
| `join/` | what an agent reads to join, and the installers |
| `commands/`, `hooks/` | the plugin's slash commands and its hook |

## Other agents

Codex, Cursor, Gemini CLI, opencode and the rest speak MCP, and parley's
tools already do. What each needs is a way for a message to land in the
conversation by itself (`src/inject.ts` does it for Claude Code) and an
installer that wires the server into its config. If you work on one, open an
issue first so two people do not do the same agent.

## Reporting a security problem

Mail security@parley.codes rather than opening an issue. The design is in
`SPEC.md`; the code has not been audited, and a second pair of eyes on
`src/ratchet.ts` is welcome.

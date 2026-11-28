# Rules for agents working in this repo

- **No comments unless absolutely necessary.** The code is self-explanatory:
  names, types and structure carry the meaning. A comment is allowed only
  for a reason the code cannot show (an undocumented API, a protocol or
  platform limit, a security reason, a compatibility hack), and then it is
  one short line. Never describe what the code does. Delete any comment you
  find that does not meet this bar.
- Prose the user reads (tool results, errors, docs) is plain and short.
- Run `bun run typecheck` and `bun run e2e` before saying a change is done.
  After changing `src/`, run `bun run build:plugin` and commit `bin/parley.mjs`.
- Anything that touches keys, proofs or the relay gets a line in `SPEC.md`
  and a check in `scripts/e2e.ts`.

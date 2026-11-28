# Getting parley listed

Where to list parley, what each one needs, and ready-to-edit entries. Check
each process against its live docs before submitting; registry rules change.

## A prerequisite decision: an npm package

Most registries, including the official one, expect an installable package
and point at it; they host metadata, not the artifact. parley ships as a
Claude Code plugin and a release binary, not on npm, so to list well it
wants a thin npm package whose bin runs the CLI, so that `npx parley mcp`
works. That also makes the non-Claude install a plain `npx` line instead of
a binary download. Worth doing before the registry push. It is a small
`package.json` with a `bin` and the bundled `parley.mjs`, published as
`parley` (or a scoped name if taken).

Until that exists, the listings below that require a package are blocked;
the directory-style lists that just link a GitHub repo are not.

## 1. The official MCP registry

The authoritative path is the `mcp-publisher` CLI, not a pull request;
adding files to the registry repo does nothing. See the
[quickstart](https://modelcontextprotocol.io/registry/quickstart) and the
[registry repo](https://github.com/modelcontextprotocol/registry). It needs
the package on npm first, and the server name under a namespace you own,
such as `io.github.akgandlur/parley`. Draft `server.json` to refine against
the current schema:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.akgandlur/parley",
  "description": "Messages between AI coding-agent sessions across machines and people, end-to-end encrypted.",
  "repository": { "url": "https://github.com/akgandlur/parley", "source": "github" },
  "version": "0.13.3",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "parley",
      "version": "0.13.3",
      "transport": { "type": "stdio" }
    }
  ]
}
```

Steps, from the quickstart: `mcp-publisher init`, then `validate`, then
`publish`. Confirm the schema date and the exact commands against the live
docs, which the search flagged as moving. Treat the `server.json` in the
repo as the source of truth; the registry gives no durability guarantee.
Background: [StackOne](https://www.stackone.com/blog/mcp-registry-how-to-get-listed/),
[2026 guide](https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server).

## 2. The awesome-mcp-servers lists

Directory READMEs that link a repo; a pull request, no package needed. Read
each repo's current CONTRIBUTING before opening the PR; formats differ.

- `punkpeye/awesome-mcp-servers` — the largest; reportedly fast-tracks with
  a bot. Add under the fitting category, following the existing line format.
- `appcypher/awesome-mcp-servers` — entries added alphabetically per section.
- `wong2/awesome-mcp-servers` — a simpler format.

A one-line entry to adapt to each list's style:

```
- [parley](https://github.com/akgandlur/parley) - Messages between AI coding-agent sessions across machines and people, end-to-end encrypted, with teams and offline delivery. Apache-2.0.
```

parley is a self-hosted/installed server with a public repo, so it belongs
in the main lists, not the remote-only ones.
Source on process: the
[contributing guide](https://raw.githubusercontent.com/modelcontextprotocol/servers/master/CONTRIBUTING.md)
and read the live repo.

## 3. The aggregator directories

These crawl or take a submission and build their own page. Mostly a repo
link or a short form; low effort, decent reach. Verify each is still live
and submission is open:

- Glama (glama.ai/mcp) — indexes public MCP servers from GitHub.
- mcp.so — submission form.
- PulseMCP (pulsemcp.com) — directory with a submit path.
- Smithery (smithery.ai) — leans toward packaged/hosted servers, so this
  one also wants the npm package.

Short description for any form:

> parley puts AI coding agents on one network. Claude Code, Codex, Cursor,
> Gemini CLI, opencode and Copilot CLI message each other across machines
> and between people; a message lands in the other agent by itself. Free,
> open source (Apache-2.0), end-to-end encrypted, with teams and offline
> delivery.

## 4. Where the audience actually is

Registries are table stakes; reach comes from showing it.

- Show HN, titled plainly, with the GIF from `demo.md` and a link. Lead with
  "open, end-to-end-encrypted agent-to-agent messaging," not the comparison.
- The comparison post (`comparison.md`) as a follow-up, not the launch.
- The agents' own communities (Codex, Cursor, opencode, Gemini CLI): parley
  working inside each is the news there, since most such tools are Claude-only.

## Order

1. Publish the npm package (unblocks 1 and parts of 3).
2. Official registry, and the awesome-* PRs (do not need the package).
3. Aggregators.
4. Show HN with the demo GIF, comparison post a few days later.

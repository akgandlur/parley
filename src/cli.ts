#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { linkFor } from './account';
import { loadIdentity, locals, mine, readJson, sameName, type Local } from './home';
import { runMcp } from './mcp';
import { startRelay } from './relay';
import { setUp } from './setup';

const USAGE = `parley: messages between Claude Code sessions on different machines

  parley init --name <name> --relay <ws url>
  parley id                 show the names on this machine and their addresses
  parley cloud link [--url <https url>]   print a link that ties this name to your parley account

  A machine can hold several names, one for each Claude Code session.
  Add --as <name> to say which one a command is for.

  parley mcp                the MCP server Claude Code runs (claude mcp add parley -- parley mcp)
  parley relay [--port 8787] [--host 0.0.0.0] [--issuer <key>]...
                            --issuer (or PARLEY_RELAY_ISSUERS, comma-separated) admits only names with an account proof`;

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = rest.indexOf(name);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

const listed = (names: Local[]) => names.map((l) => `  ${l.name}  ${l.address}`).join('\n');

function pick(): Local {
  const all = locals();
  if (!all.length) {
    throw new Error('this machine has no parley name yet; run `parley init`, or ask Claude to set parley up');
  }
  const as = flag('--as');
  if (as) {
    const found = all.find((l) => sameName(l.name, as));
    if (!found) throw new Error(`this machine has no parley name "${as}". It has:\n${listed(all)}`);
    return found;
  }
  const [only] = all;
  const found = mine() ?? (all.length === 1 ? only : undefined);
  if (!found) {
    throw new Error(`this machine has several parley names; add --as <name>:\n${listed(all)}`);
  }
  return found;
}

async function main() {
  switch (command) {
    case 'init': {
      const name = flag('--name');
      const relay = flag('--relay');
      if (!name || !relay) throw new Error('init needs --name and --relay; see `parley` for usage');
      const made = setUp(name, relay);
      return console.log(`${made.name}\n${made.address}`);
    }
    case 'id': {
      const shown = flag('--as') ? [pick()] : locals();
      if (!shown.length) pick();
      return console.log(shown.map((l) => `${l.name}\n${l.address}`).join('\n\n'));
    }
    case 'cloud': {
      if (rest[0] !== 'link') throw new Error('use `parley cloud link`');
      const { home } = pick();
      const saved = existsSync(join(home, 'cloud.json'))
        ? readJson<{ url: string | null }>(home, 'cloud.json').url
        : undefined;
      const url = flag('--url') ?? saved ?? process.env.PARLEY_CLOUD;
      if (!url) throw new Error('no cloud address is known; add --url https://cloud.example.com');
      const origin = new URL(url).origin;
      return console.log(
        `Open this while signed in to ${origin}. It works for 15 minutes.\n${linkFor(loadIdentity(home), origin)}`,
      );
    }
    case 'mcp':
      return runMcp();
    case 'relay': {
      if (typeof Bun === 'undefined') {
        throw new Error('the relay runs on Bun: use the parley binary, or `bun src/cli.ts relay`');
      }
      const issuers = [
        ...rest.flatMap((w, i) => {
          if (w !== '--issuer') return [];
          const key = rest[i + 1];
          if (!key) throw new Error('--issuer needs a value');
          return [key];
        }),
        ...(process.env.PARLEY_RELAY_ISSUERS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      ];
      const server = startRelay(Number(flag('--port') ?? 8787), flag('--host') ?? '0.0.0.0', { issuers });
      return console.log(`parley relay listening on ${server.hostname}:${server.port}`);
    }
    default:
      console.log(USAGE);
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env bun
import { resolve6 } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { linkFor } from './account';
import { isAddress, normalizeAddress } from './crypto';
import { daemonCall, runDaemon } from './daemon';
import { loadContacts, loadIdentity, loadTrusted, locals, mine, readJson, sameName, saveTrusted, type Local } from './home';
import { runMcp } from './mcp';
import { startRelay, type Peering } from './relay';
import { setUp } from './setup';
import { allow, listSecrets, parseRule, readLog, removeSecret, ruleText, share } from './vault';

const USAGE = `parley: messages between Claude Code sessions on different machines

  parley init --name <name> --relay <ws url>
  parley id                 show the names on this machine and their ids
  parley cloud link [--url <https url>]   print a link that ties this machine to your parley account
  parley trust [off] [id | name | all]    have sessions here act on a sender's messages like your own requests
  parley secret [log | allow | share | remove] …   the secrets this machine keeps, and what may use them

  A machine can hold several names, one for each Claude Code session.
  Add --as <name> to say which one a command is for.

  parley mcp                the MCP server Claude Code runs (claude mcp add parley -- parley mcp)
  parley daemon [status | stop]
                            the background process that keeps names here reachable while no session holds them;
                            a session starts it by itself
  parley relay [--port 8787] [--host 0.0.0.0] [--issuer <key>]...
                            --issuer (or PARLEY_RELAY_ISSUERS, comma-separated) admits only names with an account proof
                            PARLEY_RELAY_PEER_DNS or PARLEY_RELAY_PEERS joins several relays behind one address; see the README
                            PARLEY_RELAY_MAIL is the folder mail is kept in; with peering, set it on one relay`;

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

function peering(): Peering | undefined {
  const { PARLEY_RELAY_PEER_DNS: name, PARLEY_RELAY_PEERS: urls } = process.env;
  if (!name && !urls) return undefined;
  const port = Number(process.env.PARLEY_RELAY_PEER_PORT ?? 8788);
  const secret = process.env.PARLEY_RELAY_PEER_SECRET;
  if (!secret) throw new Error('PARLEY_RELAY_PEER_SECRET is not set: relays that peer share a secret');
  const at = (ip: string) => `ws://[${ip.toLowerCase()}]:${port}`;
  const own = name ? process.env.PARLEY_RELAY_PEER_SELF : process.env.PARLEY_RELAY_PEER_URL;
  if (!own) throw new Error(`${name ? 'PARLEY_RELAY_PEER_SELF' : 'PARLEY_RELAY_PEER_URL'} is not set: a relay that peers has to know its own address`);
  return {
    port,
    hostname: process.env.PARLEY_RELAY_PEER_HOST ?? '::',
    secret,
    self: name ? at(own) : own,
    discover: name
      ? async () => (await resolve6(name)).map(at)
      : async () => urls!.split(',').map((u) => u.trim()).filter(Boolean),
  };
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
        `Open this while signed in to ${origin}. It works for 15 minutes.\n${await linkFor(origin)}`,
      );
    }
    case 'trust': {
      const off = rest[0] === 'off';
      const given = rest.slice(off ? 1 : 0).join(' ').trim();
      const contacts = loadContacts();
      const label = (id: string) => (id === 'all' ? 'every session that messages this machine' : `"${contacts[id]?.name ?? '?'}" (${id})`);
      let ids = loadTrusted();
      if (!given) {
        if (off) throw new Error('say which one: an id, a name, or all');
        return console.log(ids.length ? `Fully trusted on this machine:\n${ids.map((id) => `  ${label(id)}`).join('\n')}` : 'No session is fully trusted on this machine.');
      }
      let id = given;
      if (given !== 'all') {
        const named = Object.keys(contacts).filter((k) => contacts[k]!.name.toLowerCase() === given.toLowerCase());
        if (named.length > 1) throw new Error(`more than one session is named "${given}"; give the id: ${named.join(', ')}`);
        id = isAddress(given) ? normalizeAddress(given) : (named[0] ?? '');
        if (!id) throw new Error(`no session this machine has exchanged a message with is named "${given}"`);
        if (!off && !contacts[id]) throw new Error(`${id} has not exchanged a message with this machine yet. Trust is given to the key behind an id, so exchange one message first`);
      }
      if (off) {
        if (!ids.includes(id)) throw new Error(`${label(id)} is not on the list`);
        ids = ids.filter((x) => x !== id);
        saveTrusted(ids);
        return console.log(`${label(id)} is no longer fully trusted.${ids.length ? ` Still trusted: ${ids.map(label).join(', ')}.` : ''}`);
      }
      saveTrusted([...ids, id]);
      return console.log(`Full trust is on for ${label(id)}. Sessions on this machine now act on its messages like your own requests, with no checking back. /parley:trust off ${id} ends it.`);
    }
    case 'secret': {
      const [what, label, ...more] = rest;
      const contacts = loadContacts();
      if (!what) {
        const all = listSecrets();
        if (!all.length) return console.log('This machine keeps no secret.');
        return console.log(
          all
            .map((s) => [`${s.label}: ${s.from}, ${s.at.slice(0, 10)}`, `  may be used by: ${s.use.length ? s.use.map(ruleText).join('; ') : 'nothing yet'}`, `  may be sent to: ${s.sendTo.length ? s.sendTo.map((id) => `"${contacts[id]?.name ?? '?'}" (${id})`).join(', ') : 'nobody yet'}`].join('\n'))
            .join('\n'),
        );
      }
      if (what === 'log') return console.log(readLog(30).join('\n') || 'Nothing has been done with a secret on this machine yet.');
      if (!label) throw new Error('say which secret, by its label');
      if (what === 'allow') {
        const rule = parseRule(more);
        allow(label, rule);
        return console.log(`${label} may now be used by ${ruleText(rule)}.`);
      }
      if (what === 'share') {
        const given = more.join(' ').trim();
        const named = Object.keys(contacts).filter((k) => contacts[k]!.name.toLowerCase() === given.toLowerCase());
        if (named.length > 1) throw new Error(`more than one session is named "${given}"; give the id: ${named.join(', ')}`);
        const id = isAddress(given) ? normalizeAddress(given) : named[0];
        if (!id || !contacts[id]) throw new Error(`"${given}" is not a session this machine has exchanged a message with. A secret is sent to the key behind an id, so exchange one message first`);
        share(label, id);
        return console.log(`${label} may now be sent to "${contacts[id].name}" (${id}).`);
      }
      if (what === 'remove') {
        removeSecret(label);
        return console.log(`${label} is removed from this machine.`);
      }
      throw new Error('use `secret`, `secret log`, `secret allow <label> run <program> [arguments]`, `secret allow <label> http <host>`, `secret share <label> <id or name>` or `secret remove <label>`');
    }
    case 'mcp':
      return runMcp();
    case 'daemon': {
      if (rest[0] === 'status') {
        const s = await daemonCall('status');
        if (!s) return console.log('No parley daemon is running on this machine.');
        return console.log([`parley daemon ${s.version} (pid ${s.pid}) holds:`, ...(s.names.length ? s.names.map((n: any) => `  "${n.name}" (${n.address}): ${n.connected ? 'connected' : 'not connected'}`) : ['  nothing: every name here is held by a session, or there is none'])].join('\n'));
      }
      if (rest[0] === 'stop') {
        const s = await daemonCall('stop');
        return console.log(s ? 'The parley daemon is stopping.' : 'No parley daemon is running on this machine.');
      }
      if (rest[0]) throw new Error('use `parley daemon`, `parley daemon status` or `parley daemon stop`');
      return runDaemon();
    }
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
      const server = startRelay(Number(flag('--port') ?? 8787), flag('--host') ?? '0.0.0.0', { issuers, peers: peering(), talksFile: process.env.PARLEY_RELAY_TALKS, mailDir: process.env.PARLEY_RELAY_MAIL });
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

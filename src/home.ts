import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { addressOf, isAddress, newIdentity, normalizeAddress, type Identity } from './crypto';

export const ROOT = process.env.PARLEY_HOME ?? join(homedir(), '.parley');

export type Config = { relay: string };

export type Contact = { name: string; firstSeen: string; key?: string };

export type Local = { home: string; name: string; address: string };

export type Claim = { pid: number; session?: string; dir: string };

export function readJson<T>(home: string, name: string): T {
  const path = join(home, name);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. Run \`parley init\` first.`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(
  home: string,
  name: string,
  value: unknown,
  secret = false,
) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, name);
  // The rename keeps a concurrent reader from seeing half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  if (secret) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const loadIdentity = (home: string) =>
  readJson<Identity>(home, 'identity.json');

export const loadConfig = (home: string) => readJson<Config>(home, 'config.json');

export function machineIdentity(): Identity {
  if (!existsSync(join(ROOT, 'machine.json'))) {
    writeJson(ROOT, 'machine.json', newIdentity(hostname().replace(/\.local$/, '').slice(0, 60) || 'this machine'), true);
  }
  return readJson<Identity>(ROOT, 'machine.json');
}

export function locals(): Local[] {
  const ids = join(ROOT, 'ids');
  const under = existsSync(ids) ? readdirSync(ids).map((d) => join(ids, d)) : [];
  // ROOT itself holds an identity made before sessions had names.
  return [ROOT, ...under]
    .filter((home) => existsSync(join(home, 'identity.json')))
    .map((home) => {
      const identity = loadIdentity(home);
      return { home, name: identity.name, address: addressOf(identity.publicKey) };
    });
}

export const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function loadContacts(): Record<string, Contact> {
  if (!existsSync(join(ROOT, 'contacts.json'))) return {};
  const saved = readJson<Record<string, Contact>>(ROOT, 'contacts.json');
  return Object.fromEntries(
    Object.entries(saved).flatMap(([id, c]) =>
      isAddress(id) ? [[id, c]] : c.key ? [[addressOf(c.key), c]] : [],
    ),
  );
}

export function loadTrusted(): string[] {
  return existsSync(join(ROOT, 'trusted.json')) ? readJson<{ ids: string[] }>(ROOT, 'trusted.json').ids : [];
}

export function saveTrusted(ids: string[]) {
  writeJson(ROOT, 'trusted.json', { ids: [...new Set(ids)].sort() });
}

export function saveContact(address: string, name: string, key: string) {
  const contacts = loadContacts();
  const known = contacts[address];
  if (known?.name === name && known.key === key) return;
  contacts[address] = {
    name,
    firstSeen: known?.firstSeen ?? new Date().toISOString(),
    key,
  };
  writeJson(ROOT, 'contacts.json', contacts);
}

// An id is 42 bits of its key: a contact is the key first heard from, never the id alone.
export function isSavedKey(address: string, key: string): boolean {
  const saved = loadContacts()[address]?.key;
  return saved === undefined || saved === key;
}

type Named = { name: string; address: string };

export function callable(self: string, also: Named[] = []): Named[] {
  const here = locals().map(({ name, address }) => ({ name, address }));
  const known = Object.entries(loadContacts()).map(([address, c]) => ({ name: c.name, address }));
  const all: Named[] = [];
  for (const n of [...here, ...known, ...also]) if (n.address !== self && !all.some((a) => a.address === n.address)) all.push(n);
  return all;
}

// A name must never stand in for someone else's id.
export function addressFor(to: string, self: string, also: Named[] = []): string {
  if (isAddress(to)) return normalizeAddress(to);
  const names = callable(self, also);
  const hits = names.filter((n) => sameName(n.name, to));
  const [only] = hits;
  if (only && hits.length === 1) return only.address;
  const list = (from: typeof names) =>
    from.map((n) => `"${n.name}" (${n.address})`).join(', ');
  if (hits.length) {
    throw new Error(`more than one id is named "${to}": ${list(hits)}. Use the id.`);
  }
  throw new Error(
    `no name you can message is "${to}". ${names.length ? `The names are ${list(names)}.` : 'No names are saved yet.'} A name is saved once you have exchanged a message; before that, use the id, like kfq-mxa-tzp.`,
  );
}

const SESSION = process.env.CLAUDE_CODE_SESSION_ID;

const isMine = (c: Claim) =>
  SESSION ? c.session === SESSION : c.pid === process.pid;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function loadClaims(): Record<string, Claim> {
  if (!existsSync(join(ROOT, 'claims.json'))) return {};
  return readJson<Record<string, Claim>>(ROOT, 'claims.json');
}

export function mine(): Local | undefined {
  const claims = loadClaims();
  return locals().find((l) => {
    const claim = claims[l.address];
    return claim !== undefined && isMine(claim);
  });
}

export function holder(address: string): Claim | undefined {
  const claim = loadClaims()[address];
  return claim && alive(claim.pid) ? claim : undefined;
}

export function take(address: string) {
  const claims = loadClaims();
  for (const [held, claim] of Object.entries(claims)) {
    if (isMine(claim)) delete claims[held];
  }
  claims[address] = { pid: process.pid, session: SESSION, dir: process.cwd() };
  writeJson(ROOT, 'claims.json', claims);
}

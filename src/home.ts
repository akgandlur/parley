import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addressOf, isAddress, normalizeAddress, type Identity } from './crypto';

export const ROOT = process.env.PARLEY_HOME ?? join(homedir(), '.parley');

export type Config = {
  relay: string;
  approval: 'dialog' | 'terminal';
  openViewer?: boolean;
  limits: {
    idleMinutes: number;
    maxMinutes: number;
    maxEntries: number;
    aliveSeconds?: number;
  };
};

export type Contact = { name: string; firstSeen: string; key?: string };

// One of the names this machine holds. `home` is its folder: a folder under
// ROOT/ids, or ROOT itself for an identity made before sessions had names.
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
  // Several processes read contacts.json and claims.json while one writes.
  // The rename keeps a reader from ever seeing half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  if (secret) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const loadIdentity = (home: string) =>
  readJson<Identity>(home, 'identity.json');

export const loadConfig = (home: string) => readJson<Config>(home, 'config.json');

export function locals(): Local[] {
  const ids = join(ROOT, 'ids');
  const under = existsSync(ids) ? readdirSync(ids).map((d) => join(ids, d)) : [];
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
  return readJson<Record<string, Contact>>(ROOT, 'contacts.json');
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

// An address is 60 bits of its key, few enough that a second key with the
// same address could be searched for. So a contact is the key that opened
// the first session, and the address alone never stands in for it again.
// A contact saved before keys were kept has none until its next session.
export function isSavedKey(address: string, key: string): boolean {
  const saved = loadContacts()[address]?.key;
  return saved === undefined || saved === key;
}

export function callable(self: string): { name: string; address: string }[] {
  const here = locals().map(({ name, address }) => ({ name, address }));
  const known = Object.entries(loadContacts())
    .filter(([address]) => !here.some((l) => l.address === address))
    .map(([address, c]) => ({ name: c.name, address }));
  return [...here, ...known].filter((k) => k.address !== self);
}

// Anything shaped like an address is one, whatever a contact has named
// itself: a name must never be able to stand in for someone else's address.
export function addressFor(to: string, self: string): string {
  if (isAddress(to)) return normalizeAddress(to);
  const names = callable(self);
  const hits = names.filter((n) => sameName(n.name, to));
  const [only] = hits;
  if (only && hits.length === 1) return only.address;
  const list = (from: typeof names) =>
    from.map((n) => `"${n.name}" (${n.address})`).join(', ');
  if (hits.length) {
    throw new Error(`more than one address is named "${to}": ${list(hits)}. Call the address.`);
  }
  throw new Error(
    `nobody you can call by name is "${to}". ${names.length ? `The names are ${list(names)}.` : 'No names are saved yet.'} A name is saved once the two sides have had a session; before that, call the 12-character address, like k7fq-m2xa-9tzp.`,
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

// The name this Claude Code session holds. The claim is filed under the
// session id, so it survives the MCP server restarting inside one session.
export function mine(): Local | undefined {
  const claims = loadClaims();
  return locals().find((l) => {
    const claim = claims[l.address];
    return claim !== undefined && isMine(claim);
  });
}

// The session that holds a name right now. A claim whose process has gone
// stays on file so that session can resume into its name, but holds nothing.
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

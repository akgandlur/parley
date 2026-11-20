import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Identity } from './crypto';

export const HOME = process.env.PARLEY_HOME ?? join(homedir(), '.parley');

export type Config = {
  relay: string;
  approval: 'dialog' | 'terminal';
  limits: { idleMinutes: number; maxMinutes: number; maxEntries: number };
};

export type Contact = { name: string; firstSeen: string };

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
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  if (secret) chmodSync(path, 0o600);
}

export const loadIdentity = (home = HOME) =>
  readJson<Identity>(home, 'identity.json');

export const loadConfig = (home = HOME) => readJson<Config>(home, 'config.json');

export function loadContacts(home = HOME): Record<string, Contact> {
  if (!existsSync(join(home, 'contacts.json'))) return {};
  return readJson<Record<string, Contact>>(home, 'contacts.json');
}

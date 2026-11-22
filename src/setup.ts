import { join } from 'node:path';
import { addressOf, isAddress, newIdentity } from './crypto';
import { ROOT, locals, sameName, writeJson, type Local } from './home';

export function setUp(name: string, relay: string): Local {
  const taken = locals().find((l) => sameName(l.name, name));
  if (taken) {
    throw new Error(
      `this machine already has the parley name "${taken.name}" (${taken.address})`,
    );
  }
  if (isAddress(name)) {
    throw new Error(`"${name.trim()}" is shaped like a parley id, so nobody could message it by name; pick another name`);
  }
  if (!/^wss?:\/\//.test(relay)) {
    throw new Error(`"${relay}" is not a relay address; it starts with wss://`);
  }
  const identity = newIdentity(name.trim());
  const address = addressOf(identity.publicKey);
  const home = join(ROOT, 'ids', address);
  writeJson(home, 'identity.json', identity, true);
  writeJson(home, 'config.json', { relay });
  return { home, name: identity.name, address };
}

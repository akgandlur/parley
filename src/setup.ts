import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addressOf, newIdentity } from './crypto';
import { HOME, loadIdentity, writeJson, type Config } from './home';

export const isSetUp = () => existsSync(join(HOME, 'identity.json'));

export function setUp(
  name: string,
  relay: string,
  approval: string = process.platform === 'darwin' ? 'dialog' : 'terminal',
): { name: string; address: string } {
  if (isSetUp()) {
    throw new Error(
      `${HOME} already has an identity (${addressOf(loadIdentity().publicKey)}). Delete that folder to start over; the address changes with it.`,
    );
  }
  if (!/^wss?:\/\//.test(relay)) {
    throw new Error(`"${relay}" is not a relay address; it starts with wss://`);
  }
  if (approval !== 'dialog' && approval !== 'terminal') {
    throw new Error('approval is dialog or terminal');
  }
  if (approval === 'dialog' && process.platform !== 'darwin') {
    throw new Error('the approval dialog needs macOS; use terminal approval');
  }
  const config: Config = {
    relay,
    approval,
    limits: { idleMinutes: 15, maxMinutes: 120, maxEntries: 400 },
  };
  const identity = newIdentity(name);
  writeJson(HOME, 'identity.json', identity, true);
  writeJson(HOME, 'config.json', config);
  return { name, address: addressOf(identity.publicKey) };
}

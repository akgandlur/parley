import { join } from 'node:path';
import { addressOf, newIdentity } from './crypto';
import { ROOT, locals, sameName, writeJson, type Config, type Local } from './home';

export function setUp(
  name: string,
  relay: string,
  approval: string = process.platform === 'darwin' ? 'dialog' : 'terminal',
): Local {
  const taken = locals().find((l) => sameName(l.name, name));
  if (taken) {
    throw new Error(
      `this machine already has the parley name "${taken.name}" (${taken.address})`,
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
    openViewer: approval === 'dialog',
    limits: { idleMinutes: 15, maxMinutes: 120, maxEntries: 400 },
  };
  const identity = newIdentity(name.trim());
  const address = addressOf(identity.publicKey);
  const home = join(ROOT, 'ids', address);
  writeJson(home, 'identity.json', identity, true);
  writeJson(home, 'config.json', config);
  return { home, name: identity.name, address };
}

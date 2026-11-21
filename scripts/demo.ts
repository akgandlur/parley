// Plays a short scripted call between two local nodes, slowly, so the live
// view can be watched. Nothing here calls a model.
//
//   bun run demo
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../src/ipc';
import { openInBrowser } from '../src/open';
import { startRelay } from '../src/relay';
import type { View } from '../src/types';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const base = process.env.PARLEY_DEMO_DIR ?? mkdtempSync(join(tmpdir(), 'parley-demo-'));
const relay = startRelay(0, '127.0.0.1');
const roots = { mine: join(base, 'mine'), theirs: join(base, 'theirs') };
const homes = { mine: '', theirs: '' };
const pause = (seconds: number) => Bun.sleep(seconds * 1000);

function cli(root: string, ...args: string[]): string {
  const done = Bun.spawnSync(['bun', CLI, ...args], {
    env: { ...process.env, PARLEY_HOME: root },
  });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return done.stdout.toString();
}

const rpc = (who: keyof typeof homes, op: string, args: object = {}) =>
  request<View>(op, args, { home: homes[who] });

async function theirProposal(item: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const ref = (await rpc('mine', 'status')).session?.items.find((x) => x.id === item)?.theirs?.ref;
    if (ref) return ref;
    await Bun.sleep(100);
  }
  throw new Error(`no proposal arrived on ${item}`);
}

try {
  const url = `ws://127.0.0.1:${relay.port}`;
  for (const [who, name] of [['mine', 'Your Claude'], ['theirs', 'Their Claude']] as const) {
    const made = cli(roots[who], 'init', '--name', name, '--relay', url, '--approval', 'terminal');
    homes[who] = join(roots[who], 'ids', made.trim().split('\n')[1] ?? '');
    cli(roots[who], 'status');
  }

  const { viewer } = await rpc('mine', 'status');
  console.log(`Live view: ${viewer}`);
  if (!process.env.PARLEY_DEMO_NO_OPEN) {
    openInBrowser(viewer, (why) => console.error(`could not open a browser: ${why}`));
  }
  await pause(4);

  const them = (await rpc('theirs', 'status')).me.address;
  console.log('calling');
  await rpc('mine', 'call', {
    address: them,
    title: 'Agree the export format',
    items: ['Date format', 'Field name for the customer id', 'Who hosts the endpoint'],
  });
  await pause(4);
  console.log('a person accepts');
  await rpc('theirs', 'approve', { accept: true });
  await pause(2);

  await rpc('mine', 'say', { item: 'a1', text: 'We send dates as ISO 8601. Does your importer take a UTC offset?' });
  await pause(2);
  await rpc('theirs', 'say', { item: 'a2', text: 'On our side the column is customer_ref. Is yours an integer or a string?' });
  await pause(2);
  await rpc('theirs', 'say', { item: 'a1', text: 'It takes an offset, but UTC only is simpler for us.' });
  await pause(2);
  await rpc('mine', 'say', { item: 'a2', text: 'A string, up to 32 characters.' });
  await pause(2);
  await rpc('theirs', 'add_item', { title: 'Retry policy when the endpoint is down' });
  await pause(2);
  await rpc('theirs', 'propose', { item: 'a1', text: 'Dates are ISO 8601 in UTC, with a trailing Z.' });
  await pause(3);
  await rpc('mine', 'agree', { item: 'a1', proposal: await theirProposal('a1') });
  await pause(2);
  await rpc('theirs', 'propose', { item: 'a2', text: 'The field is customer_ref, a string of at most 32 characters.' });
  await pause(3);
  await rpc('mine', 'agree', { item: 'a2', proposal: await theirProposal('a2') });
  await pause(2);
  await rpc('mine', 'drop', { item: 'a3', reason: 'Needs a decision from the two people, not from us.' });
  await pause(2);
  await rpc('theirs', 'propose', { item: 'b1', text: 'Three retries, doubling from one second, then give up and report.' });
  await pause(3);
  await rpc('mine', 'agree', { item: 'b1', proposal: await theirProposal('b1') });

  const hold = Number(process.env.PARLEY_DEMO_HOLD ?? 45);
  console.log(`done; the page stays live for ${hold} more seconds`);
  await pause(hold);
} finally {
  for (const who of ['mine', 'theirs'] as const) {
    await request('stop', {}, { home: homes[who], start: false }).catch(() => {});
  }
  relay.stop(true);
}
process.exit(0);

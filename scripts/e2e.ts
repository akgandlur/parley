// Drives real nodes through a real relay on this machine. The script plays
// both agents and both people; nothing here calls a model.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verifyText } from '../src/crypto';
import { readJson, writeJson, type Config } from '../src/home';
import { request } from '../src/ipc';
import { startRelay } from '../src/relay';
import type { Ev, View, WaitResult } from '../src/types';

// PARLEY_E2E_CLI="node /abs/bin/parley.mjs" runs the same checks against
// the bundle the plugin ships.
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const RUN = (process.env.PARLEY_E2E_CLI ?? `bun ${CLI}`).split(' ');
const base = process.env.PARLEY_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'parley-'));
const relay = startRelay(0, '127.0.0.1');
const relayUrl = `ws://127.0.0.1:${relay.port}`;
let failures = 0;

function check(name: string, ok: unknown, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

class Peer {
  cursor = -1;
  home: string;
  constructor(public name: string) {
    this.home = join(base, name.toLowerCase());
  }
  init() {
    this.cli('init', '--name', this.name, '--relay', relayUrl, '--approval', 'terminal');
  }
  // Starting the node through the CLI makes it run on the runtime under test.
  start() {
    this.cli('status');
  }
  cli(...args: string[]) {
    const done = Bun.spawnSync([...RUN, ...args], {
      env: { ...process.env, PARLEY_HOME: this.home },
    });
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    return done.stdout.toString();
  }
  rpc<T = View>(op: string, args: object = {}, timeoutMs = 10_000) {
    return request<T>(op, args, { home: this.home, timeoutMs });
  }
  async fails(op: string, args: object): Promise<string> {
    try {
      await this.rpc(op, args);
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  async news(timeoutMs = 5000): Promise<Ev[]> {
    const res = await this.rpc<WaitResult>('wait', { cursor: this.cursor, timeoutMs }, timeoutMs + 5000);
    this.cursor = res.cursor;
    return res.events;
  }
  async until(kind: Ev['kind'], timeoutMs = 8000): Promise<Ev[]> {
    const seen: Ev[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      seen.push(...(await this.news(1000)));
      if (seen.some((e) => e.kind === kind)) return seen;
    }
    throw new Error(`${this.name} never saw "${kind}"; saw ${JSON.stringify(seen)}`);
  }
  async session() {
    const v = await this.rpc('status');
    if (!v.session) throw new Error(`${this.name} has no session`);
    return v.session;
  }
  async item(id: string) {
    const found = (await this.session()).items.find((i) => i.id === id);
    if (!found) throw new Error(`${this.name} has no item ${id}`);
    return found;
  }
  async call(to: string, title: string, items: string[]) {
    this.cursor = (await this.rpc('call', { address: to, title, items })).cursor;
  }
  address = async () => (await this.rpc('status')).me.address;
}

async function connected(p: Peer) {
  for (let i = 0; i < 50; i++) {
    if ((await p.rpc('status')).relay.connected) return;
    await Bun.sleep(100);
  }
  throw new Error(`${p.name} never reached the relay`);
}

async function open(caller: Peer, callee: Peer, title: string, items: string[]) {
  await caller.call(await callee.address(), title, items);
  await callee.until('incoming');
  await callee.rpc('approve', { accept: true });
  await caller.until('opened');
  await callee.until('opened');
}

function transcript(p: Peer, sessionId: string) {
  const dirs = [...new Bun.Glob(`*-${sessionId}/transcript.jsonl`).scanSync(join(p.home, 'sessions'))];
  const path = dirs[0];
  if (!path) throw new Error(`${p.name} has no transcript for ${sessionId}`);
  const [head, ...lines] = readFileSync(join(p.home, 'sessions', path), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { raw: string; sig?: string });
  if (!head) throw new Error('empty transcript');
  const parties = JSON.parse(head.raw);
  const keys: Record<string, string> = {
    [parties.caller.address]: parties.caller.publicKey,
    [parties.callee.address]: parties.callee.publicKey,
  };
  const entries = lines.map((l) => ({ ...l, entry: JSON.parse(l.raw) }));
  const signed = entries.every((l) => {
    const key = keys[l.entry.from];
    return key !== undefined && l.sig !== undefined && verifyText(key, l.raw, l.sig);
  });
  return { entries, signed };
}

const alice = new Peer('Alice');
const bob = new Peer('Bob');
const carol = new Peer('Carol');

async function fullSession() {
  console.log('\n# a full session');
  await alice.call(await bob.address(), 'Agree the export format', [
    'Date format',
    'Field name for the customer id',
    'Who hosts the endpoint',
  ]);
  const ring = await bob.until('incoming');
  check('callee sees the incoming call', ring.some((e) => e.kind === 'incoming'));
  const pending = await bob.session();
  check('the call waits for a person', pending.state === 'awaiting_approval' && pending.items.length === 3, pending);
  check('callee sees who is calling', pending.peer.name === 'Alice' && pending.peer.knownSince === undefined, pending.peer);
  check('callee agent cannot speak before a person accepts', (await bob.fails('say', { item: 'a1', text: 'hi' })).includes('not open yet'));
  check('caller agent cannot speak before a person accepts', (await alice.fails('say', { item: 'a1', text: 'hi' })).includes('not open yet'));

  await bob.rpc('approve', { accept: true });
  await alice.until('opened');
  await bob.until('opened');
  check('both sides are open', (await alice.session()).state === 'active' && (await bob.session()).state === 'active');

  await alice.rpc('say', { item: 'a1', text: 'We send ISO 8601 dates.' });
  await bob.rpc('say', { item: 'a2', text: 'We call it customer_ref.' });
  await bob.rpc('add_item', { title: 'Retry policy' });
  const toBob = await bob.until('say');
  const toAlice = await alice.until('add_item');
  check('a message lands on its own item', toBob.some((e) => e.kind === 'say' && e.item === 'a1' && e.text.includes('ISO 8601')), toBob);
  check('two threads move at once', toAlice.some((e) => e.kind === 'say' && e.item === 'a2') && toAlice.some((e) => e.kind === 'add_item' && e.item === 'b1'), toAlice);

  await alice.rpc('propose', { item: 'a1', text: 'Dates are ISO 8601 in UTC.' });
  const offer = (await bob.until('propose')).find((e) => e.kind === 'propose');
  const ref = offer?.kind === 'propose' ? offer.ref : '';
  check('a proposal arrives with a reference', ref.startsWith('a:'), offer);
  check('agreeing to a proposal that does not exist is refused', (await bob.fails('agree', { item: 'a1', proposal: 'a:999' })).includes('latest proposal'));
  await bob.rpc('agree', { item: 'a1', proposal: ref });
  await alice.until('agree');
  const [a1Alice, a1Bob] = [await alice.item('a1'), await bob.item('a1')];
  check('an agreed item closes on both sides with the same words', a1Alice.state === 'agreed' && a1Bob.state === 'agreed' && a1Alice.agreed?.text === a1Bob.agreed?.text, [a1Alice, a1Bob]);

  await alice.rpc('propose', { item: 'a2', text: 'customer_id' });
  const first = (await bob.until('propose')).find((e) => e.kind === 'propose');
  await alice.rpc('propose', { item: 'a2', text: 'customer_ref' });
  const second = (await bob.until('propose')).find((e) => e.kind === 'propose');
  const stale = first?.kind === 'propose' ? first.ref : '';
  const latest = second?.kind === 'propose' ? second.ref : '';
  check('agreeing to a replaced proposal is refused', (await bob.fails('agree', { item: 'a2', proposal: stale })).includes(`is ${latest}`));
  await bob.rpc('agree', { item: 'a2', proposal: latest });
  check('the agreement carries the latest wording', (await bob.item('a2')).agreed?.text === 'customer_ref');

  await bob.rpc('drop', { item: 'a3', reason: 'Out of scope for this session.' });
  await alice.until('drop');
  check('a dropped item takes no more messages', (await alice.fails('say', { item: 'a3', text: 'but' })).includes('already dropped'));

  await bob.rpc('propose', { item: 'b1', text: 'Three retries, doubling from one second.' });
  const last = (await alice.until('propose')).find((e) => e.kind === 'propose');
  await alice.rpc('agree', { item: 'b1', proposal: last?.kind === 'propose' ? last.ref : '' });

  const endAlice = (await alice.until('ended')).find((e) => e.kind === 'ended');
  const endBob = (await bob.until('ended')).find((e) => e.kind === 'ended');
  check('the session ends by itself when the agenda is done', endAlice?.kind === 'ended' && endAlice.reason === 'agenda complete' && endBob?.kind === 'ended' && endBob.reason === 'agenda complete', [endAlice, endBob]);

  const [sa, sb] = [await alice.session(), await bob.session()];
  const [ma, mb] = [sa.minutes, sb.minutes].map((m) => (m && existsSync(m) ? readFileSync(m, 'utf8') : ''));
  const agreedPart = (m: string | undefined) => m?.slice(m.indexOf('## Agreed'), m.indexOf('## Dropped')).replace(/Proposed by .*/g, '');
  check('both sides wrote minutes', Boolean(ma && mb));
  check('the minutes agree on what was agreed', agreedPart(ma) === agreedPart(mb) && ma?.includes('Three retries'), [agreedPart(ma), agreedPart(mb)]);
  check('the minutes mark an item added during the session', ma?.includes('Retry policy (added during the session by Bob)'), ma);
  const [ta, tb] = [transcript(alice, sa.id), transcript(bob, sb.id)];
  check('both sides hold the same number of entries', ta.entries.length === tb.entries.length && ta.entries.length > 10, [ta.entries.length, tb.entries.length]);
  check('every entry in both transcripts is signed by its sender', ta.signed && tb.signed);
  const contacts = readJson<Record<string, { name: string }>>(bob.home, 'contacts.json');
  check('the caller is saved as a contact', contacts[await alice.address()]?.name === 'Alice', contacts);
}

async function crossing() {
  console.log('\n# entries that cross on the wire');
  await open(alice, bob, 'Crossing', ['Drop against agree', 'Agree against agree']);
  check('a second call shows the caller as known', (await bob.session()).peer.knownSince !== undefined);

  await alice.rpc('propose', { item: 'a1', text: 'offer' });
  const offer = (await bob.until('propose')).find((e) => e.kind === 'propose');
  const crossed = await Promise.allSettled([
    alice.rpc('drop', { item: 'a1', reason: 'withdrawn' }),
    bob.rpc('agree', { item: 'a1', proposal: offer?.kind === 'propose' ? offer.ref : '' }),
  ]);
  await Bun.sleep(300);
  const [dropA, dropB] = [await alice.item('a1'), await bob.item('a1')];
  check(
    `drop against agree settles the same on both sides (${crossed.every((r) => r.status === 'fulfilled') ? 'they crossed' : 'they did not cross'}: ${dropA.state})`,
    dropA.state === dropB.state && dropA.agreed?.text === dropB.agreed?.text,
    [dropA, dropB],
  );

  await Promise.all([
    alice.rpc('propose', { item: 'a2', text: 'from the caller' }),
    bob.rpc('propose', { item: 'a2', text: 'from the callee' }),
  ]);
  await Bun.sleep(300);
  const [theirsA, theirsB] = [(await alice.item('a2')).theirs, (await bob.item('a2')).theirs];
  const both = await Promise.allSettled([
    alice.rpc('agree', { item: 'a2', proposal: theirsA?.ref ?? '' }),
    bob.rpc('agree', { item: 'a2', proposal: theirsB?.ref ?? '' }),
  ]);
  await alice.until('ended');
  await bob.until('ended');
  const [agA, agB] = [await alice.item('a2'), await bob.item('a2')];
  check(
    `agree against agree settles on one wording (${both.every((r) => r.status === 'fulfilled') ? 'they crossed' : 'they did not cross'}: "${agA.agreed?.text}")`,
    agA.state === 'agreed' && agA.agreed?.text === agB.agreed?.text,
    [agA, agB],
  );
}

async function otherEndings() {
  console.log('\n# other ways a call ends');
  await alice.call(await bob.address(), 'Declined', ['One']);
  await bob.until('incoming');
  await bob.rpc('approve', { accept: false, reason: 'not now' });
  const declined = (await alice.until('ended')).find((e) => e.kind === 'ended');
  check('a declined call ends for the caller with the reason', declined?.kind === 'ended' && declined.reason === 'the other side declined: not now', declined);
  check('a declined call leaves no minutes', (await alice.session()).minutes === undefined);
  await bob.until('ended');

  await alice.call('0000-0000-0000', 'Nobody', ['One']);
  const offline = (await alice.until('ended')).find((e) => e.kind === 'ended');
  check('calling an address that is not online says so', offline?.kind === 'ended' && offline.reason === 'the other side is not online', offline);

  await open(alice, bob, 'Cut short', ['First', 'Second']);
  await carol.call(await bob.address(), 'Third party', ['One']);
  const busy = (await carol.until('ended')).find((e) => e.kind === 'ended');
  check('a third caller is told the callee is busy', busy?.kind === 'ended' && busy.reason === 'the other side is in another session', busy);
  check('the busy callee never sees the third caller', (await bob.session()).peer.name === 'Alice');

  await bob.rpc('hangup', { reason: 'lunch' });
  const hung = (await alice.until('ended')).find((e) => e.kind === 'ended');
  check('a hang-up ends the session on the other side', hung?.kind === 'ended' && hung.reason === 'the other side hung up: lunch', hung);
  const minutes = readFileSync((await alice.session()).minutes ?? '', 'utf8');
  check('items still open are recorded as left open', minutes.includes('## Left open\n\n- a1 · First\n- a2 · Second'), minutes);

  const config = readJson<Config>(bob.home, 'config.json');
  writeJson(bob.home, 'config.json', { ...config, limits: { ...config.limits, idleMinutes: 0.05 } });
  await bob.rpc('stop');
  await Bun.sleep(300);
  bob.start();
  await connected(bob);
  bob.cursor = -1;
  await open(alice, bob, 'Goes quiet', ['One']);
  const idle = (await alice.until('ended', 15_000)).find((e) => e.kind === 'ended');
  check('a session that goes quiet ends by itself', idle?.kind === 'ended' && idle.reason.includes('nothing was said'), idle);
}

async function mcp() {
  console.log('\n# what an agent is given');
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: RUN[0] ?? 'bun',
      args: [...RUN.slice(1), 'mcp'],
      env: { ...process.env, PARLEY_HOME: alice.home } as Record<string, string>,
    }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check('the agent gets ten tools', tools.join(',') === 'add_item,agree,call,drop,hang_up,propose,say,setup,status,wait', tools);
  check('none of them accepts or declines a call', !tools.some((t) => /accept|approve|decline/.test(t)));
  const status = (await client.callTool({ name: 'status', arguments: {} })) as { content: { text: string }[] };
  check('status reads as plain text', status.content[0]?.text.includes('You are "Alice"'), status);
  const refused = (await client.callTool({ name: 'say', arguments: { item: 'a1', text: 'x' } })) as { isError?: boolean };
  check('an action with no session comes back as an error', refused.isError === true, refused);
  await client.close();

  const fresh = new Client({ name: 'e2e-fresh', version: '0' });
  const dave = new Peer('Dave');
  await fresh.connect(
    new StdioClientTransport({
      command: RUN[0] ?? 'bun',
      args: [...RUN.slice(1), 'mcp'],
      env: { ...process.env, PARLEY_HOME: dave.home, PARLEY_RELAY: relayUrl } as Record<string, string>,
    }),
  );
  type Reply = { isError?: boolean; content: { text: string }[] };
  const before = (await fresh.callTool({ name: 'status', arguments: {} })) as Reply;
  check('a machine with no identity is pointed at setup', before.isError === true && before.content[0]?.text.includes('setup tool'), before);
  const made = (await fresh.callTool({ name: 'setup', arguments: { name: 'Dave' } })) as Reply;
  check('setup creates an identity and returns its address', /The address is [0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.test(made.content[0]?.text ?? ''), made);
  const again = (await fresh.callTool({ name: 'setup', arguments: { name: 'Other' } })) as Reply;
  check('setup will not replace an identity', again.isError === true && again.content[0]?.text.includes('already has an identity'), again);
  const after = (await fresh.callTool({ name: 'status', arguments: {} })) as Reply;
  check('status works straight after setup', after.content[0]?.text.includes('You are "Dave"'), after);
  await fresh.close();
  await dave.rpc<string>('stop').catch(() => {});
}

try {
  for (const p of [alice, bob, carol]) p.init();
  for (const p of [alice, bob, carol]) p.start();
  for (const p of [alice, bob, carol]) await connected(p);
  await fullSession();
  await crossing();
  await otherEndings();
  await mcp();
} catch (err) {
  failures++;
  console.log('FAIL  the run stopped early ->', err instanceof Error ? err.message : err);
} finally {
  for (const p of [alice, bob, carol]) await p.rpc<string>('stop').catch(() => {});
  relay.stop(true);
}
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}   (state kept in ${base})`);
process.exit(failures ? 1 : 0);

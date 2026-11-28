import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ServerWebSocket } from 'bun';
import { addressOf, newIdentity, signText, verifyText, type Identity } from '../src/crypto';
import { answer, answerMail, canSeal, checkMailOffer, checkOffer, finish, loadPair, newPair, offer, offerMail, open, safetyNumber, savePair, seal, signPrekey } from '../src/ratchet';
import { MAIL_FRAMES_MAX } from '../src/mail';
import { machine } from '../src/host';
import { Prekeys } from '../src/prekeys';
import { makeAttestation, readAttestation } from '../src/attest';
import { readJson, writeJson, type Contact } from '../src/home';
import { MAX_PER_IP, RELAY_AUTH, startRelay } from '../src/relay';
import { VERSION } from '../src/types';

// PARLEY_E2E_CLI="node /abs/bin/parley.mjs" runs the same checks against the bundle.
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const RUN = (process.env.PARLEY_E2E_CLI ?? `bun ${CLI}`).split(' ');
const base = process.env.PARLEY_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'parley-'));
const relay = startRelay(0, '127.0.0.1');
const relayUrl = `ws://127.0.0.1:${relay.port}`;
let failures = 0;
const cleanup: Array<() => unknown> = [];

function check(name: string, ok: unknown, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

const {
  // The run may be inside a Claude Code session: never write into its socket, never see its sessions.
  CLAUDE_CODE_SESSION_ID: _id,
  CLAUDE_CODE_MESSAGING_SOCKET: _sock,
  CLAUDE_CODE_MESSAGING_TOKEN: _token,
  ...REAL
} = process.env;
const CLAUDE_DIR = join(base, 'claude');
// The daemon check starts one on purpose.
const ENV = { ...REAL, CLAUDE_CONFIG_DIR: CLAUDE_DIR, PARLEY_HOLD_SECONDS: '0', PARLEY_DAEMON: 'off' };

async function until<T>(get: () => T | undefined, ms = 8000): Promise<T | undefined> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(50)) {
    const got = get();
    if (got) return got;
  }
  return get();
}

async function eventually<T>(get: () => Promise<T | undefined>, ms = 8000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await get();
    if (got || Date.now() > deadline) return got;
    await Bun.sleep(200);
  }
}

type Arrival = { auth?: string; frame: any };

function fakeSession() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const path = join(dir, 's.sock');
  const token = randomBytes(16).toString('hex');
  const arrivals: Arrival[] = [];
  const server: Server = createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => (buf += d));
    c.on('end', () => {
      const lines = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const auth = lines[0]?.type === 'auth' ? lines.shift().token : undefined;
      for (const frame of lines) arrivals.push({ auth, frame });
    });
  });
  server.listen(path);
  cleanup.push(() => server.close());
  return {
    env: { CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: token },
    token,
    arrivals,
    texts: () => arrivals.map((a) => String(a.frame?.message?.content ?? '')),
    stop: () => server.close(),
  };
}

type Reply = { isError?: boolean; content: { text: string }[] };

async function agent(root: string, session: string, env: Record<string, string> = {}, run = RUN) {
  const transport = new StdioClientTransport({
    command: run[0] ?? 'bun',
    args: [...run.slice(1), 'mcp'],
    env: { ...ENV, PARLEY_HOME: root, PARLEY_RELAY: relayUrl, ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}), ...env } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  const a = {
    client,
    pid: transport.pid,
    tool: async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Reply;
      return { failed: res.isError === true, text: res.content[0]?.text ?? '' };
    },
    close: () => client.close(),
  };
  cleanup.push(() => client.close());
  return a;
}

const addressIn = (text: string) => /\b[a-z]{3}-[a-z]{3}-[a-z]{3}\b/.exec(text)?.[0] ?? '';

function cli(root: string, ...args: string[]) {
  const done = Bun.spawnSync([...RUN, ...args], { env: { ...ENV, PARLEY_HOME: root } });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return done.stdout.toString();
}

const alive = (pid: number | null) => {
  try {
    return pid !== null && (process.kill(pid, 0), true);
  } catch {
    return false;
  }
};

const fails = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

function sealing() {
  console.log('\n# a conversation is sealed between its two ends');
  const [ann, ben, cat] = [newIdentity('Ann'), newIdentity('Ben'), newIdentity('Cat')];
  const [annAddr, benAddr] = [addressOf(ann.publicKey), addressOf(ben.publicKey)];
  const start = () => {
    const o = offer(ann, benAddr);
    const b = answer(ben, annAddr, o.hello);
    return { a: finish(o.hello, o.pair, annAddr, b.reply), b: b.ratchet, o, reply: b.reply };
  };
  const { a, b, o, reply } = start();
  const text = 'line one\nline two · ünïcödé 🚀';
  check('the one who answered cannot send before it has heard', !canSeal(b) && fails(() => seal(b, 'too early')));
  const m1 = seal(a, text);
  check('the other end opens a message', open(b, m1) === text && canSeal(b));
  check('the same message does not open twice', fails(() => open(b, m1)));
  const back = seal(b, 'and back');
  check('it works the other way', open(a, back) === 'and back');
  const [x, y, z] = [seal(a, 'one'), seal(a, 'two'), seal(a, 'three')];
  check('messages that arrive out of order all open', open(b, z) === 'three' && open(b, x) === 'one' && open(b, y) === 'two');
  check('every message has its own key, and each reply brings a new exchange', new Set([m1.h.dh, x.h.dh, back.h.dh]).size === 3 && x.h.dh === y.h.dh && x.c !== seal(a, 'one').c);
  const flipped = Buffer.from(seal(a, 'intact').c, 'base64url');
  flipped[0] = flipped[0]! ^ 1;
  const good = seal(a, 'after the bad one');
  check('a changed byte does not open, and the conversation goes on', fails(() => open(b, { h: { ...good.h, n: good.h.n - 1 }, c: flipped.toString('base64url') })) && open(b, good) === 'after the bad one');
  check('a changed header does not open', (() => {
    const m = seal(b, 'header');
    return fails(() => open(a, { h: { ...m.h, pn: m.h.pn + 1 }, c: m.c })) && open(a, m) === 'header';
  })());
  const other = start();
  check('a message from another conversation between the same two does not open', fails(() => open(b, seal(other.a, 'elsewhere'))));

  check('an offer is only good for the id it names', checkOffer(o.hello, benAddr) && !checkOffer(o.hello, addressOf(cat.publicKey)));
  check('an offer signed by another key is refused', !checkOffer({ ...o.hello, key: cat.publicKey }, benAddr));
  check('an answer signed by another key is refused', fails(() => finish(o.hello, o.pair, annAddr, { ...reply, key: cat.publicKey })));
  const swapped = answer(cat, annAddr, o.hello).reply;
  check('an answer with a swapped one-time key is refused', fails(() => finish(o.hello, o.pair, annAddr, { ...reply, e: swapped.e })));

  const late = start();
  const kept = seal(late.a, 'said earlier');
  open(late.b, kept);
  const replay = answer(ben, annAddr, late.o.hello);
  check('the identity keys alone do not open a recorded message', fails(() => open(replay.ratchet, kept)));

  const number = safetyNumber(ann.publicKey, ben.publicKey);
  check('the safety number is the same from both sides, and changes with either key', /^(\d{5} ){5}\d{5}$/.test(number) && number === safetyNumber(ben.publicKey, ann.publicKey) && number !== safetyNumber(ann.publicKey, cat.publicKey));

  console.log('\n# a conversation can begin from keys left at the relay');
  const spk = newPair();
  const opk = newPair();
  const bundle = { key: ben.publicKey, spk: { pub: spk.publicKey, sig: signPrekey(ben, spk.publicKey) }, opk: opk.publicKey };
  const mailed = offerMail(ann, benAddr, bundle);
  const first = seal(mailed.ratchet, 'sealed while you were away');
  check('the offerer can send at once', canSeal(mailed.ratchet) && checkMailOffer(mailed.hello, benAddr));
  const benMail = answerMail(ben, mailed.hello, spk, opk);
  check('the other side opens it with the keys it left, and can then answer', open(benMail, first) === 'sealed while you were away' && canSeal(benMail) && open(mailed.ratchet, seal(benMail, 'back')) === 'back');
  check('the offer is only good for the id it names', !checkMailOffer(mailed.hello, addressOf(cat.publicKey)));
  check('a bundle whose signed prekey is signed by another key is refused', fails(() => offerMail(ann, benAddr, { ...bundle, spk: { ...bundle.spk, sig: signPrekey(cat, spk.publicKey) } })));
  check('without the one-time key it does not open', fails(() => open(answerMail(ben, { ...mailed.hello, opk: undefined }, spk, undefined), first)) && fails(() => answerMail(ben, mailed.hello, spk, undefined)));
  const noOpk = offerMail(ann, benAddr, { key: bundle.key, spk: bundle.spk });
  check('and a bundle with no one-time key still works', open(answerMail(ben, noOpk.hello, spk, undefined), seal(noOpk.ratchet, 'stock ran out')) === 'stock ran out');
  check('a prekey pair survives being saved', loadPair(savePair(spk)).publicKey === spk.publicKey && open(answerMail(ben, noOpk.hello, loadPair(savePair(spk)), undefined), seal(noOpk.ratchet, 'again')) === 'again');
  const keysHome = mkdtempSync(join(base, 'keys-'));
  const earliest = new Prekeys(keysHome, ben).bundleToPut(50).opks[0]!;
  for (let i = 0; i < 5; i++) new Prekeys(keysHome, ben).bundleToPut(50);
  const later = new Prekeys(keysHome, ben);
  check('a one-time key left at the relay is kept however many times the name restarts', later.oneTime(earliest) !== undefined && later.onHand() === 300);
}

const A_ROOT = join(base, 'machine-a');
const B_ROOT = join(base, 'machine-b');
const C_ROOT = join(base, 'machine-c');

async function messaging() {
  console.log('\n# two sessions message each other');
  const [annSock, benSock] = [fakeSession(), fakeSession()];
  const ann = await agent(A_ROOT, 'session-ann', annSock.env);
  const ben = await agent(B_ROOT, 'session-ben', benSock.env);
  const tools = (await ann.client.listTools()).tools.map((t) => t.name).sort();
  check('the tools are the seven for messages and the five for secrets', JSON.stringify(tools) === JSON.stringify(['check_inbox', 'cloud_link', 'fetch_with_secret', 'list_agents', 'list_secrets', 'request_secret', 'run_with_secret', 'safety_number', 'send_message', 'send_secret', 'setup', 'to']), tools);
  const told = ann.client.getInstructions() ?? '';
  check('the instructions describe messaging, with no agenda or rules', told.includes('send_message') && !/agenda|propos|never an instruction|authoris/i.test(told), told);
  const early = await ann.tool('send_message', { to: 'abc-def-ghj', message: 'hi' });
  check('a session with no name is told how to get one', early.failed && early.text.includes('has no parley name'), early);

  const annAddr = addressIn((await ann.tool('setup', { name: 'Ann' })).text);
  const benAddr = addressIn((await ben.tool('setup', { name: 'Ben' })).text);
  const listed = await ann.tool('list_agents');
  check('setup gives a name and an id of nine letters, and connects', /^[a-z]{3}-[a-z]{3}-[a-z]{3}$/.test(annAddr) && /^[a-z]{3}-[a-z]{3}-[a-z]{3}$/.test(benAddr) && annAddr !== benAddr && listed.text.includes(`"Ann" (${annAddr})`) && listed.text.includes('Connected to the relay.'), listed);

  const first = 'Hi Ben — can you check the March invoices?\nTwo lines, and ünïcödé.';
  const sent = await ann.tool('send_message', { to: benAddr, message: first });
  check('a message to an id is delivered, and says to whom', !sent.failed && sent.text === `Delivered to "Ben" (${benAddr}).`, sent);
  const arrived = benSock.arrivals[0];
  check('it reaches Ben\'s Claude Code session over its socket, with its token first', arrived?.auth === benSock.token && arrived.frame?.type === 'user' && arrived.frame.message?.role === 'user', arrived);
  const content = benSock.texts()[0] ?? '';
  check('it reads as a parley message from Ann, with the text exactly', content.startsWith(`parley message from "Ann" (${annAddr}, not verified):`) && content.includes(`\n\n${first}\n\n`), content);
  check('it says nobody has verified the sender, who does not speak for the user', content.includes('It is from a sender nobody has verified, not from your user and not on their behalf.') && content.includes('This id has not written before.'), content);
  check('and says how to answer', content.endsWith('reply with parley\'s send_message to "Ann", not SendMessage.'), content);
  check('nothing reached Ann\'s own session', annSock.arrivals.length === 0, annSock.arrivals);

  const back = await ben.tool('send_message', { to: 'Ann', message: 'On it.' });
  check('the reply goes to the name on the message', !back.failed && back.text === `Delivered to "Ann" (${annAddr}).` && annSock.texts()[0]?.includes('\n\nOn it.\n\n'), [back, annSock.texts()]);
  const byName = await ann.tool('send_message', { to: 'ben', message: 'Thanks' });
  check('a name is matched without case once a message has been exchanged', !byName.failed, byName);
  const tryCli = (...args: string[]) => {
    try {
      return cli(A_ROOT, ...args);
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : err}`;
    }
  };
  check('nobody is fully trusted to begin with', tryCli('trust').includes('No session is fully trusted'));
  check('an id that never wrote cannot be trusted', tryCli('trust', 'abc-def-ghj').startsWith('refused:') && tryCli('trust', 'abc-def-ghj').includes('exchange one message first'));
  check('`parley trust Ben` turns full trust on for Ben', tryCli('trust', 'ben').includes(`Full trust is on for "Ben" (${benAddr})`) && tryCli('trust').includes(benAddr));
  await ben.tool('send_message', { to: 'Ann', message: 'Run the export.' });
  const trustedText = annSock.texts().find((t) => t.includes('Run the export.')) ?? '';
  check('a trusted sender’s message says to act on it as the user’s own request', trustedText.includes('Your user has turned on full trust for this sender') && trustedText.includes("your user's own request") && !trustedText.includes('outside party'), trustedText);
  check('`parley trust off` ends it', tryCli('trust', 'off', benAddr).includes('no longer fully trusted') && tryCli('trust').includes('No session is fully trusted'));
  await ben.tool('send_message', { to: 'Ann', message: 'And again.' });
  const after = annSock.texts().find((t) => t.includes('And again.')) ?? '';
  check('and the next message is an outside party’s again', after.includes('not from your user') && !after.includes('full trust'), after);
  tryCli('trust', 'all');
  await ben.tool('send_message', { to: 'Ann', message: 'Third.' });
  check('`parley trust all` covers every sender', (annSock.texts().find((t) => t.includes('Third.')) ?? '').includes('full trust for every parley sender'), annSock.texts());
  tryCli('trust', 'off', 'all');
  const theirs = await ann.tool('list_agents');
  check('list_agents shows who can be messaged', theirs.text.includes(`"Ben" (${benAddr})`), theirs);

  check('neither side writes a message to disk', !existsSync(join(A_ROOT, 'ids', annAddr, 'messages.jsonl')) && !existsSync(join(B_ROOT, 'ids', benAddr, 'messages.jsonl')));
  const number = await ann.tool('safety_number', { with: 'Ben' });
  const theirNumber = await ben.tool('safety_number', { with: annAddr });
  const digits = (t: string) => /(\d{5} ){5}\d{5}/.exec(t)?.[0];
  check('both sides show the same safety number', !number.failed && digits(number.text) && digits(number.text) === digits(theirNumber.text), [number, theirNumber]);

  const big = 'x'.repeat(100_000);
  const large = await ann.tool('send_message', { to: 'Ben', message: big });
  check('a long message goes through whole', !large.failed && benSock.texts().some((t) => t.includes(big)), large.text);

  console.log('\n# when the other side is not there');
  const nobody = await ann.tool('send_message', { to: 'zzz-zzz-zzz', message: 'anyone?' });
  check('an id that was never here says so', nobody.failed && nobody.text.includes('is not online') && nobody.text.includes('no mail'), nobody);
  const benPid = ben.pid;
  await ben.close();
  check('closing the session ends its parley server', await until(() => !alive(benPid) || undefined, 5000), benPid);
  const gone = await ann.tool('send_message', { to: 'Ben', message: 'still there?' });
  check('a message to a closed session is left for it at the relay', !gone.failed && gone.text.startsWith(`Left for "Ben" (${benAddr}) at the relay`) && gone.text.includes('7 days'), gone);
  check('and nothing of it is on disk in the clear', !readFileSync(join(B_ROOT, 'ids', benAddr, 'prekeys.json'), 'utf8').includes('still there'));
  const again = await agent(B_ROOT, 'session-ben', benSock.env);
  const late = await until(() => benSock.texts().find((t) => t.includes('still there?')));
  check('it goes in when the session is back, saying when it was sent', late?.includes(`parley message from "Ann" (${annAddr}, not verified), sent 20`) && late.includes('kept until now'), late);
  const toldAnn = await until(() => annSock.texts().find((t) => t.includes('now has the message you left')));
  check('and Ann is told it arrived', toldAnn?.includes(`"Ben" (${benAddr}) now has the message you left`), annSock.texts());
  const resumed = await eventually(async () => {
    const r = await ann.tool('send_message', { to: 'Ben', message: 'welcome back' });
    return r.failed ? undefined : r;
  });
  check('the same session comes back as its name with no setup, and is reachable', resumed?.text.includes('Delivered') && benSock.texts().some((t) => t.includes('welcome back')), resumed);
  const replied = await again.tool('send_message', { to: 'Ann', message: 'back now' });
  check('and the conversation that began in mail goes on', !replied.failed && replied.text.startsWith('Delivered') && annSock.texts().some((t) => t.includes('back now')), replied);
  const listedBack = await again.tool('list_agents');
  check('and is that name', listedBack.text.includes(`"Ben" (${benAddr})`), listedBack);

  console.log('\n# a session without Claude Code\'s socket');
  const cat = await agent(C_ROOT, 'session-cat');
  const catAddr = addressIn((await cat.tool('setup', { name: 'Cat' })).text);
  await ann.tool('send_message', { to: catAddr, message: 'are you there, Cat?' });
  const shown = await cat.tool('list_agents');
  check('messages come with the next parley tool result instead', shown.text.includes('Messages that came in:') && shown.text.includes('are you there, Cat?'), shown);
  const twice = await cat.tool('list_agents');
  check('each one once', !twice.text.includes('are you there, Cat?'), twice);

  return { ann, ben: again, cat, annSock, benSock, annAddr, benAddr, catAddr };
}

type Pair = Awaited<ReturnType<typeof messaging>>;

async function forgery(p: Pair) {
  console.log('\n# what a relay or a stranger cannot do');
  const eve = newIdentity('Eve');
  const eveAddr = addressOf(eve.publicKey);
  const link = await dialRelay(relayUrl, eve);
  const annId = readJson<Identity>(join(A_ROOT, 'ids', p.annAddr), 'identity.json');
  const before = p.benSock.arrivals.length;
  const got: any[] = [];
  link.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'recv') got.push(m.payload);
  });
  const send = (to: string, payload: object) => link.ws.send(JSON.stringify({ t: 'send', to, ref: 'x', payload }));
  const inner = (text: string) => JSON.stringify({ t: 'msg', id: randomBytes(9).toString('base64url'), name: 'Eve', text, at: new Date().toISOString() });

  const asAnn = offer(eve, p.benAddr);
  send(p.benAddr, { v: 3, kind: 'hs1', ...asAnn.hello, key: annId.publicKey });
  const forCat = offer(eve, p.catAddr);
  send(p.benAddr, { v: 3, kind: 'hs1', ...forCat.hello });
  await Bun.sleep(600);
  check('a handshake under someone else\'s key, or made for another id, gets no answer', !got.some((g) => g.kind === 'hs2'), got);
  send(p.benAddr, { v: 3, kind: 'm', h: { dh: asAnn.hello.e, pn: 0, n: 0 }, c: 'AAAA' });
  await until(() => got.find((g) => g.kind === 'reset'), 3000);
  check('a message outside any conversation is not read', got.some((g) => g.kind === 'reset') && p.benSock.arrivals.length === before);

  const mine = offer(eve, p.benAddr);
  send(p.benAddr, { v: 3, kind: 'hs1', ...mine.hello });
  const reply = await until(() => got.find((g) => g.kind === 'hs2'), 3000);
  const r = finish(mine.hello, mine.pair, eveAddr, reply);
  const frame = { v: 3, kind: 'm', ...seal(r, inner('hello from Eve')) };
  send(p.benAddr, frame);
  send(p.benAddr, frame);
  const bad = seal(r, inner('altered on the way'));
  const raw = Buffer.from(bad.c, 'base64url');
  raw[3] = raw[3]! ^ 1;
  send(p.benAddr, { v: 3, kind: 'm', h: bad.h, c: raw.toString('base64url') });
  send(p.benAddr, { v: 3, kind: 'm', ...seal(r, inner('and one more from Eve')) });
  await until(() => p.benSock.texts().some((t) => t.includes('and one more from Eve')) || undefined, 3000);
  await Bun.sleep(400);
  const fromEve = p.benSock.texts().slice(before);
  check('a stranger can message by id, and a replayed message arrives once', fromEve.filter((t) => t.includes('hello from Eve')).length === 1, fromEve);
  check('a message altered on the way is dropped, and the next one still arrives', !fromEve.some((t) => t.includes('altered on the way')) && fromEve.some((t) => t.includes('and one more from Eve')), fromEve);
  link.ws.close();

  const contacts = readJson<Record<string, Contact>>(B_ROOT, 'contacts.json');
  writeJson(B_ROOT, 'contacts.json', { ...contacts, [eveAddr]: { ...contacts[eveAddr]!, key: newIdentity('Other').publicKey } });
  const again = await dialRelay(relayUrl, eve);
  const heard: any[] = [];
  again.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'recv') heard.push(m.payload);
  });
  const hello = () => again.ws.send(JSON.stringify({ t: 'send', to: p.benAddr, ref: 'x', payload: { v: 3, kind: 'hs1', ...offer(eve, p.benAddr).hello } }));
  hello();
  await Bun.sleep(800);
  const refused = !heard.some((g) => g.kind === 'hs2');
  writeJson(B_ROOT, 'contacts.json', contacts);
  hello();
  check('a known id that turns up with another key is not answered', refused && (await until(() => heard.find((g) => g.kind === 'hs2'), 3000)), heard);
  again.ws.close();
}

async function names(p: Pair) {
  console.log('\n# a name for each Claude Code session');
  const other = await agent(A_ROOT, 'session-ann-2');
  const taken = await other.tool('setup', { name: 'ann' });
  check('a name another open session holds is refused', taken.failed && taken.text.includes('is in use by another session'), taken);
  const second = await other.tool('setup', { name: 'Ann at home' });
  const secondAddr = addressIn(second.text);
  check('a second name on the machine has its own id', secondAddr && secondAddr !== p.annAddr, second);
  const hop = await other.tool('send_message', { to: p.annAddr, message: 'from the next tab' });
  check('two sessions on one machine message each other the same way', !hop.failed && p.annSock.texts().some((t) => t.includes('from the next tab')), hop);
  const ids = cli(A_ROOT, 'id');
  check('parley id lists both names', ids.includes(p.annAddr) && ids.includes(secondAddr), ids);
  const shaped = await other.tool('setup', { name: 'Old-Mac-Pro' });
  check('a name shaped like an id is refused', shaped.failed && shaped.text.includes('shaped like a parley id'), shaped);
  await other.close();
  const nine = await agent(join(base, 'machine-e'), 'session-nine', fakeSession().env);
  const nineAddr = addressIn((await nine.tool('setup', { name: 'Marketing' })).text);
  await nine.tool('send_message', { to: p.annAddr, message: 'hello from marketing' });
  const toNine = await p.ann.tool('send_message', { to: 'Marketing', message: 'hello back' });
  check('a nine-letter name is a name, not an id', !toNine.failed && toNine.text === `Delivered to "Marketing" (${nineAddr}).`, toNine);
  const spaced = await p.ann.tool('send_message', { to: nineAddr.replace(/-/g, ''), message: 'no hyphens' });
  check('an id typed without its hyphens is not taken for one', spaced.failed && spaced.text.includes('use the id, like'), spaced);
  const upper = await p.ann.tool('send_message', { to: ` ${nineAddr.toUpperCase()} `, message: 'capitals' });
  check('an id in capitals works', !upper.failed, upper);
  await nine.close();
  const reuse = await agent(A_ROOT, 'session-ann-3');
  const back = await reuse.tool('setup', { name: 'Ann at home' });
  check('a free name this machine has is taken again with its id', back.text.includes(`"Ann at home" (${secondAddr}), a name this machine already had`), back);
  await reuse.close();
}

async function olderContacts(p: Pair) {
  console.log('\n# contacts saved under ids of the old shape');
  const contacts = readJson<Record<string, Contact>>(A_ROOT, 'contacts.json');
  const ben = contacts[p.benAddr]!;
  const { [p.benAddr]: _gone, ...rest } = contacts;
  writeJson(A_ROOT, 'contacts.json', { ...rest, 'k7fq-m2xa-9tzp': ben, 'aaaa-bbbb-cccc': { name: 'No Key', firstSeen: '2026-11-01T00:00:00.000Z' } });
  const listed = await p.ann.tool('list_agents');
  check('a contact filed under an old id is listed under the id its key has now', listed.text.includes(`"Ben" (${p.benAddr})`) && !listed.text.includes('k7fq'), listed);
  check('one saved with no key is left out', !listed.text.includes('No Key'), listed);
  const sent = await p.ann.tool('send_message', { to: 'Ben', message: 'still by name' });
  check('and can still be messaged by name', !sent.failed && sent.text === `Delivered to "Ben" (${p.benAddr}).`, sent);
}

async function olderNode() {
  console.log('\n# an older background node is stopped');
  const root = join(base, 'machine-d');
  const made = cli(root, 'init', '--name', 'Dee', '--relay', relayUrl).trim().split('\n');
  const home = join(root, 'ids', made[1] ?? '');
  const ops: any[] = [];
  const old = createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d) => {
      ops.push(JSON.parse(String(d)));
      rmSync(join(home, 'node.json'), { force: true });
      c.end(JSON.stringify({ ok: true, result: {} }) + '\n');
    });
  });
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
  const port = (old.address() as { port: number }).port;
  writeJson(home, 'node.json', { port, token: 'old-token', pid: 999_999, version: '0.5.0' });
  const dee = await agent(root, 'session-dee');
  const set = await dee.tool('setup', { name: 'Dee' });
  check('taking the name asks the 0.5 node holding it to stop', ops[0]?.op === 'stop' && ops[0]?.token === 'old-token' && !existsSync(join(home, 'node.json')), ops);
  check('and connects in its place', set.text.includes('a name this machine already had') && (await dee.tool('list_agents')).text.includes('Connected to the relay.'), set);
  old.close();
  await dee.close();
}

async function olderVersion() {
  console.log('\n# a session on parley 0.8 meets this one');
  const old = join(base, 'parley-0.8.mjs');
  const built = Bun.spawnSync(['git', 'show', '6c0e92b:bin/parley.mjs'], { cwd: join(import.meta.dir, '..') });
  if (built.exitCode !== 0) throw new Error(`could not read the 0.8 plugin from git: ${built.stderr}`);
  writeFileSync(old, built.stdout);
  const [oldSock, newSock, otherSock] = [fakeSession(), fakeSession(), fakeSession()];
  const olive = await agent(join(base, 'machine-old'), 'session-olive', oldSock.env, ['node', old]);
  const nina = await agent(join(base, 'machine-new'), 'session-nina', newSock.env);
  const otto = await agent(join(base, 'machine-new'), 'session-otto', otherSock.env);
  const oliveAddr = addressIn((await olive.tool('setup', { name: 'Olive' })).text);
  const ninaAddr = addressIn((await nina.tool('setup', { name: 'Nina' })).text);
  const ottoAddr = addressIn((await otto.tool('setup', { name: 'Otto' })).text);

  const started = Date.now();
  const sent = await nina.tool('send_message', { to: oliveAddr, message: 'hello from 0.9' });
  check('sending to it fails at once and says it is on an older parley', sent.failed && sent.text.includes('older than 0.9') && Date.now() - started < 5000, { sent, ms: Date.now() - started });
  const note = await until(() => oldSock.texts().find((t) => t.includes('automatic note from parley')));
  check('it gets a note it can read, with how to update', note?.includes('"Nina"') && note.includes('claude plugin update parley@parley') && note.includes(VERSION), oldSock.texts());
  check('the sender is not told a second time by a notice', !newSock.texts().some((t) => t.includes('tried to reach')), newSock.texts());

  const back = await olive.tool('send_message', { to: ottoAddr, message: 'hello from 0.8' });
  check('its own message does not get through', back.failed, back);
  const notice = await until(() => otherSock.texts().find((t) => t.includes('tried to reach this session')));
  check('the session it tried is told who tried and why nothing arrived', notice?.includes(oliveAddr) && notice.includes('older than 0.9'), otherSock.texts());
  const second = await until(() => (oldSock.texts().filter((t) => t.includes('automatic note from parley')).length === 2 ? true : undefined));
  check('and it gets the note from that session too', second, oldSock.texts());
  await olive.tool('send_message', { to: ottoAddr, message: 'again' });
  await new Promise((r) => setTimeout(r, 500));
  check('a second try within ten minutes repeats neither', otherSock.texts().filter((t) => t.includes('tried to reach')).length === 1 && oldSock.texts().filter((t) => t.includes('automatic note')).length === 2, { other: otherSock.texts(), old: oldSock.texts() });
  const fine = await nina.tool('send_message', { to: ottoAddr, message: 'between two on this version' });
  check('two sessions on this version still talk, with no notice', !fine.failed && !newSock.texts().concat(otherSock.texts()).some((t) => t.includes('newer parley')), fine);
  for (const a of [olive, nina, otto]) await a.close();
}

async function manySenders() {
  console.log('\n# a session many others write to');
  const socks = [fakeSession(), fakeSession(), fakeSession()];
  const root = join(base, 'machine-busy');
  const hub = await agent(root, 'session-hub', { ...socks[0]!.env, PARLEY_HOLD_SECONDS: '3' });
  const one = await agent(join(base, 'machine-one'), 'session-one', socks[1]!.env);
  const two = await agent(join(base, 'machine-two'), 'session-two', socks[2]!.env);
  const hubAddr = addressIn((await hub.tool('setup', { name: 'Hub' })).text);
  await one.tool('setup', { name: 'One' });
  await two.tool('setup', { name: 'Two' });
  const got = () => socks[0]!.texts();

  const first = await one.tool('send_message', { to: hubAddr, message: 'first from one' });
  await until(() => got()[0]);
  check('the first message goes in at once', !first.failed && got().length === 1 && got()[0]!.startsWith('parley message from "One"'), got());
  const later = [
    await two.tool('send_message', { to: hubAddr, message: 'first from two' }),
    await one.tool('send_message', { to: hubAddr, message: 'second from one' }),
    await two.tool('send_message', { to: hubAddr, message: 'second from two' }),
  ];
  check('what follows is delivered to its senders at once and held from the session', later.every((r) => !r.failed && r.text.startsWith('Delivered to "Hub"')) && got().length === 1, { later, got: got() });
  const rush = await one.tool('send_message', { to: hubAddr, message: 'stop, the branch is gone', urgent: true });
  const urgent = await until(() => got()[1]);
  check('an urgent one goes in at once, marked as its sender\'s word, with what that sender had waiting before it', !rush.failed && urgent?.includes('marked urgent by its sender') && urgent.includes('1. second from one') && urgent.indexOf('second from one') < urgent.indexOf('stop, the branch is gone') && !urgent.includes('from two'), got());
  const batch = await until(() => got()[2], 6000);
  check('the rest go in together once the hold is over, by sender and in order', batch?.startsWith('2 parley messages came in close together, from one session') && batch.indexOf('1. first from two') < batch.indexOf('2. second from two') && batch.includes('send_message to "Two"'), got());
  await new Promise((r) => setTimeout(r, 3200));
  await one.tool('send_message', { to: hubAddr, message: 'much later' });
  const calm = await until(() => got()[3]);
  check('and a message after a quiet spell goes in at once again', calm?.startsWith('parley message from "One"') && got().length === 4, got());
  await hub.close();

  const [stillSock, goneSock] = [fakeSession(), fakeSession()];
  const still = await agent(join(base, 'machine-still'), 'session-still', { ...stillSock.env, PARLEY_HOLD_SECONDS: '60' });
  const gone = await agent(join(base, 'machine-gone'), 'session-gone', { ...goneSock.env, PARLEY_HOLD_SECONDS: '60' });
  const stillAddr = addressIn((await still.tool('setup', { name: 'Still' })).text);
  const goneAddr = addressIn((await gone.tool('setup', { name: 'Gone' })).text);
  for (const to of [stillAddr, goneAddr]) {
    await one.tool('send_message', { to, message: 'goes in' });
    await one.tool('send_message', { to, message: 'is held' });
  }
  await until(() => (stillSock.texts().length === 1 && goneSock.texts().length === 1 ? true : undefined));
  await still.close();
  const late = await until(() => stillSock.texts()[1]);
  check('when parley stops with a message held and the session still there, it goes in then', late?.includes('is held'), stillSock.texts());
  goneSock.stop();
  const before = socks[1]!.texts().length;
  await gone.close();
  const note = await until(() => socks[1]!.texts()[before]);
  check('when the session is gone too, the sender is told it was not read', note?.includes('"Gone" closed before reading the message you sent') && goneSock.texts().length === 1, socks[1]!.texts());
  for (const a of [one, two]) await a.close();
}

async function oneLine() {
  console.log('\n# /parley:to in one call');
  const [aSock, bSock] = [fakeSession(), fakeSession()];
  const a = await agent(join(base, 'machine-line-a'), 'session-line-a', aSock.env);
  const b = await agent(join(base, 'machine-line-b'), 'session-line-b', bSock.env);
  const bAddr = addressIn((await b.tool('setup', { name: 'Line B' })).text);
  const unnamed = await a.tool('to', { text: '' });
  check('a session Claude Code gave no name is told to ask for one', unnamed.failed && unnamed.text.includes('call setup with it'), unnamed);
  register('Line A', aSock.env.CLAUDE_CODE_MESSAGING_SOCKET);
  const empty = await a.tool('to', { text: '' });
  const aAddr = addressIn(empty.text.slice(empty.text.indexOf('sends them its id')));
  check('with no name yet and nobody known, it takes a name by itself, asks for an id and gives its own', !empty.failed && empty.text.includes('Ask the user for the parley id') && /^[a-z]{3}-[a-z]{3}-[a-z]{3}$/.test(aAddr), empty);
  const sent = await a.tool('to', { text: `${bAddr} are you there?` });
  check('an id and a message are sent in that one call', !sent.failed && sent.text === `Delivered to "Line B" (${bAddr}).` && (await until(() => bSock.texts()[0]))?.includes('are you there?'), sent);
  const who = await a.tool('to', { text: 'line b' });
  check('a name alone, in any case, asks what to say', !who.failed && who.text.includes(`"Line B" (${bAddr})`) && who.text.includes('Ask the user what to tell it'), who);
  const named = await a.tool('to', { text: 'Line B and by name, with spaces in it' });
  check('a name with spaces and a message are told apart', !named.failed && named.text.startsWith('Delivered') && (await until(() => bSock.texts().find((t) => t.includes('\nand by name, with spaces in it\n')))), { named, got: bSock.texts() });
  const list = await a.tool('to', { text: '' });
  check('with someone known, no name lists whom it can message', list.text.includes('Show the user this whole list') && list.text.includes(`"Line B" (${bAddr})`), list);
  const nobody = await a.tool('to', { text: 'zed hello' });
  check('a name nobody has says so and lists who there is', nobody.text.includes('named like "zed"') && nobody.text.includes('"Line B"'), nobody);
  check('its own id is refused', (await a.tool('to', { text: `${aAddr} hi` })).failed);
  await b.close();
  const gone = await a.tool('to', { text: `${bAddr} still there?` });
  check('a session that is not open gets the message left for it', !gone.failed && gone.text.startsWith(`Left for "Line B" (${bAddr}) at the relay`), gone);
  await a.close();
}

const cloudIssuer = newIdentity('Test cloud');
const unix = () => Math.floor(Date.now() / 1000);
type Account = { sub: string; domain: string | null; banned?: boolean; lifetime?: number; nets?: string[]; name?: string };

function startCloudStub() {
  const accounts = new Map<string, Account>();
  const machines = new Map<string, Account>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== '/api/attest' && path !== '/api/people') return Response.json({ error: 'nothing here' }, { status: 404 });
      const purpose = path.slice('/api/'.length);
      const text = await req.text();
      const [key, time, sig] = ['x-parley-key', 'x-parley-time', 'x-parley-sig'].map((h) => req.headers.get(h) ?? '');
      const digest = new Bun.CryptoHasher('sha256').update(text).digest('hex');
      const signed = verifyText(key ?? '', `parley-cloud-${purpose}\n${time}\n${digest}`, sig ?? '');
      const m = (JSON.parse(text) as { machine?: { key: string; sig: string } }).machine;
      const vouched = m && verifyText(m.key, `parley-cloud-machine\n${key}`, m.sig) ? machines.get(m.key) : undefined;
      const account = signed ? (accounts.get(key ?? '') ?? vouched) : undefined;
      if (!account) return Response.json({ error: 'not linked' }, { status: 403 });
      if (account.banned) return Response.json({ error: 'banned' }, { status: 403 });
      if (purpose === 'people') {
        const nets = (account.nets ?? []).map((id) => ({
          id,
          name: `Net ${id}`,
          people: [...accounts]
            .filter(([k, a]) => k !== key && a.sub !== account.sub && a.nets?.includes(id))
            .map(([k, a]) => ({ email: `${a.sub}@${a.domain}`, names: [{ address: addressOf(k), name: a.name ?? a.sub }] })),
        }));
        return Response.json({ mine: [], nets });
      }
      const iat = unix();
      const att = makeAttestation(cloudIssuer, { key: key ?? '', sub: account.sub, domain: account.domain, kind: 'account', nets: account.nets, iat, exp: iat + (account.lifetime ?? 86400) });
      return Response.json({ att, issuer: cloudIssuer.publicKey, sync: false });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, accounts, machines };
}

async function accounts() {
  console.log('\n# names on a relay that needs an account');
  const stub = startCloudStub();
  const gated = startRelay(0, '127.0.0.1', { issuers: [cloudIssuer.publicKey] });
  cleanup.push(() => gated.stop(true));
  const env = { PARLEY_CLOUD: stub.url, PARLEY_RELAY: `ws://127.0.0.1:${gated.port}` };
  const [miaSock, nedSock] = [fakeSession(), fakeSession()];
  const mia = await agent(join(base, 'machine-m'), 'session-mia', { ...env, ...miaSock.env });
  const ned = await agent(join(base, 'machine-n'), 'session-ned', { ...env, ...nedSock.env });
  const miaAddr = addressIn((await mia.tool('setup', { name: 'Mia' })).text);
  const nedAddr = addressIn((await ned.tool('setup', { name: 'Ned' })).text);
  const key = (root: string, addr: string) => readJson<Identity>(join(base, root, 'ids', addr), 'identity.json').publicKey;
  const refused = await mia.tool('list_agents');
  check('a name no account owns is refused, and list_agents gives the link to open', refused.text.includes('Not connected to the relay: this relay needs a parley account') && refused.text.includes('Open this link and sign in') && refused.text.includes(`${stub.url}/link?`), refused);
  const out = cli(join(base, 'machine-m'), 'cloud', 'link', '--url', stub.url);
  const machineM = readJson<Identity>(join(base, 'machine-m'), 'machine.json');
  const shownLink = new URL(/http\S+\/link\?\S+/.exec(refused.text)?.[0] ?? 'http://none');
  const q = shownLink.searchParams;
  check(
    'the link is for the machine, signed by its key and not by the name',
    q.get('kind') === 'machine' && q.get('key') === machineM.publicKey && q.get('key') !== key('machine-m', miaAddr) && verifyText(machineM.publicKey, `parley-cloud-link-machine\n${stub.url}\n${q.get('t')}\n${q.get('name')}`, q.get('sig') ?? ''),
    refused.text,
  );
  check('parley cloud link prints the same kind of link', out.includes(`${stub.url}/link?kind=machine&key=${machineM.publicKey}`), out);

  stub.accounts.set(key('machine-m', miaAddr), { sub: 'acct-mia', domain: 'mia.example' });
  stub.accounts.set(key('machine-n', nedAddr), { sub: 'acct-ned', domain: 'ned.example' });
  const linked = await eventually(async () => {
    const r = await mia.tool('list_agents');
    return r.text.includes('Connected to the relay.') ? r : undefined;
  }, 20_000);
  check('once the name is linked it gets its proof and connects', linked?.text.includes('verified · mia.example'), linked);
  await eventually(async () => ((await ned.tool('list_agents')).text.includes('Connected to the relay.') ? true : undefined), 20_000);
  const sent = await mia.tool('send_message', { to: nedAddr, message: 'between accounts' });
  check('linked names message each other', !sent.failed, sent);
  check('the message shows the sender\'s verified domain', nedSock.texts()[0]?.startsWith(`parley message from "Mia" (${miaAddr}, verified · mia.example):`), nedSock.texts());

  console.log('\n# a name linked before 0.7, in the folder layout of 0.1');
  const olaRoot = join(base, 'machine-o');
  const ola = newIdentity('Ola');
  const olaAddr = addressOf(ola.publicKey);
  writeJson(olaRoot, 'identity.json', ola, true);
  writeJson(olaRoot, 'config.json', { relay: 'wss://relay.invalid', approval: 'dialog', limits: { idleMinutes: 15 } });
  writeJson(olaRoot, 'cloud.json', { url: stub.url });
  writeJson(olaRoot, 'claims.json', { 'k7fq-m2xa-9tzp': { pid: 1, session: 'session-ola', dir: '/somewhere' } });
  const iat = unix();
  const stale = JSON.stringify({ v: 1, key: ola.publicKey, address: 'k7fq-m2xa-9tzp', sub: 'acct-ola', domain: 'ola.example', kind: 'account', iat, exp: iat + 86400 });
  writeJson(olaRoot, 'attest.json', { att: `${Buffer.from(stale).toString('base64url')}.${signText(cloudIssuer, 'parley-attest\n' + stale)}`, issuer: cloudIssuer.publicKey, sync: true, fetchedAt: new Date().toISOString() });
  stub.accounts.set(ola.publicKey, { sub: 'acct-ola', domain: 'ola.example' });
  const olaSession = await agent(olaRoot, 'session-ola', env);
  const unnamedYet = await olaSession.tool('list_agents');
  check('the session is told its name is free to take again', unnamedYet.failed && unnamedYet.text.includes(`"Ola" (${olaAddr}): free`), unnamedYet);
  const taken = await olaSession.tool('setup', { name: 'Ola' });
  check('it takes the name, with the id its key has now', !taken.failed && taken.text.includes(`"Ola" (${olaAddr})`), taken);
  const olaOn = await eventually(async () => {
    const r = await olaSession.tool('list_agents');
    return r.text.includes('Connected to the relay.') ? r : undefined;
  }, 20_000);
  check('the proof saved under the old id is replaced, and it connects verified', olaOn?.text.includes('verified · ola.example') && readAttestation(readJson<{ att: string }>(olaRoot, 'attest.json').att, [cloudIssuer.publicKey], ola.publicKey).address === olaAddr, olaOn);
  const toOla = await mia.tool('send_message', { to: olaAddr, message: 'to an upgraded name' });
  check('and it can be messaged', !toOla.failed, toOla);
  await olaSession.close();

  stub.accounts.set(key('machine-m', miaAddr), { sub: 'acct-mia', domain: 'mia.example', banned: true });
  await mia.close();
  const back = await agent(join(base, 'machine-m'), 'session-mia', { ...env, ...miaSock.env });
  const banned = await eventually(async () => {
    const r = await back.tool('list_agents');
    return r.text.includes('banned') ? r : undefined;
  }, 10_000);
  check('a banned account is shown as banned', banned, banned);
  await back.close();
  await ned.close();
}

type Link = { ws: WebSocket; ready: boolean; closed?: { code: number; reason: string } };

function dialRelay(url: string, id: Identity, att?: string, forwardedFor?: string): Promise<Link> {
  const options: Bun.WebSocketOptions = forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {};
  // The DOM typing of WebSocket shadows Bun's, which takes headers.
  const ws = new WebSocket(url, options as unknown as string[]);
  const link: Link = { ws, ready: false };
  return new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.t === 'challenge') {
        ws.send(JSON.stringify({ t: 'hello', publicKey: id.publicKey, sig: signText(id, RELAY_AUTH + msg.nonce), ...(att ? { att } : {}) }));
      } else if (msg.t === 'ready') {
        link.ready = true;
        resolve(link);
      }
    };
    ws.onclose = (ev) => {
      link.closed = { code: ev.code, reason: ev.reason };
      resolve(link);
    };
  });
}

async function networks() {
  console.log('\n# two accounts on one network');
  const stub = startCloudStub();
  const gated = startRelay(0, '127.0.0.1', { issuers: [cloudIssuer.publicKey] });
  cleanup.push(() => gated.stop(true));
  const env = { PARLEY_CLOUD: stub.url, PARLEY_RELAY: `ws://127.0.0.1:${gated.port}` };
  const [pamSock, quinnSock] = [fakeSession(), fakeSession()];
  const pam = await agent(join(base, 'machine-p'), 'session-pam', { ...env, ...pamSock.env });
  const quinn = await agent(join(base, 'machine-q'), 'session-quinn', { ...env, ...quinnSock.env });
  const pamAddr = addressIn((await pam.tool('setup', { name: 'Pam' })).text);
  const quinnAddr = addressIn((await quinn.tool('setup', { name: 'Quinn' })).text);
  const key = (root: string, addr: string) => readJson<Identity>(join(base, root, 'ids', addr), 'identity.json').publicKey;
  stub.accounts.set(key('machine-p', pamAddr), { sub: 'pam', domain: 'pam.example', nets: ['t1'], name: 'Pam' });
  stub.accounts.set(key('machine-q', quinnAddr), { sub: 'quinn', domain: 'quinn.example', nets: ['t1'], name: 'Quinn' });
  const connected = (a: typeof pam) => eventually(async () => {
    const r = await a.tool('list_agents');
    return r.text.includes('Connected to the relay.') ? r : undefined;
  }, 20_000);
  const [pamOn] = await Promise.all([connected(pam), connected(quinn)]);
  check('list_agents shows the network, who is on it, and their sessions', pamOn?.text.includes('On your network "Net t1"') && pamOn.text.includes('quinn@quinn.example:') && pamOn.text.includes(`"Quinn" (${quinnAddr})`), pamOn);
  const proof = readAttestation(readJson<{ att: string }>(join(base, 'machine-p', 'ids', pamAddr), 'attest.json').att, [cloudIssuer.publicKey], key('machine-p', pamAddr));
  check('the account proof names the network', JSON.stringify(proof.nets) === '["t1"]', proof);
  const byName = await pam.tool('send_message', { to: 'quinn', message: 'Deploy at five?' });
  check('a teammate is messaged by name before any message has been exchanged', !byName.failed && byName.text === `Delivered to "Quinn" (${quinnAddr}).`, byName);
  const heard = quinnSock.texts().find((t) => t.includes('Deploy at five?'));
  check('the message says it is a teammate\'s, to act on as the user\'s own request', heard?.includes('It is from a teammate: someone at pam.example on your user\'s parley network "Net t1".') && heard.includes('without checking back') && !heard.includes('outside party'), heard);

  stub.accounts.set(key('machine-q', quinnAddr), { sub: 'quinn', domain: 'quinn.example', nets: [], name: 'Quinn' });
  const off = await eventually(async () => {
    const r = await quinn.tool('list_agents');
    return r.text.includes('On your network') ? undefined : r;
  }, 10_000);
  check('an account taken off the network stops seeing it', !!off, off);
  const after = await pam.tool('send_message', { to: quinnAddr, message: 'Still there?' });
  const outside = quinnSock.texts().find((t) => t.includes('Still there?'));
  check('and the next message is an outside party\'s again', !after.failed && outside?.includes('not from your user') && !outside.includes('teammate'), outside);
  await pam.close();
  await quinn.close();
}

async function closedWithin(link: Link, ms: number) {
  for (const deadline = Date.now() + ms; Date.now() < deadline && !link.closed; await Bun.sleep(50));
  return link.closed;
}

async function accountRelays() {
  console.log('\n# a relay that admits only names with an account proof');
  const issuer = newIdentity('Test cloud');
  const stranger = newIdentity('Other cloud');
  const now = () => Math.floor(Date.now() / 1000);
  const proof = (id: Identity, sub = 'acct-1', exp = now() + 86400, by = issuer) =>
    makeAttestation(by, { key: id.publicKey, sub, domain: 'example.com', kind: 'account', iat: now(), exp });
  const gated = startRelay(0, '127.0.0.1', { issuers: [issuer.publicKey] });
  const url = `ws://127.0.0.1:${gated.port}`;
  const opened: Link[] = [];
  const keep = (l: Link) => (opened.push(l), l);
  const shut = async (links: Link[]) => {
    for (const l of links) l.ws.close();
    for (const l of links) await closedWithin(l, 2000);
  };
  try {
    const plain = keep(await dialRelay(relayUrl, newIdentity('Plain')));
    const ignored = keep(await dialRelay(relayUrl, newIdentity('Odd'), 'not.a-proof'));
    check('a relay with no issuers lets in a name without a proof, and ignores a bad one', plain.ready && ignored.ready, [plain.closed, ignored.closed]);

    const me = newIdentity('Verified');
    const refusals: [string, Link][] = [
      ['no proof', await dialRelay(url, me)],
      ['a malformed proof', await dialRelay(url, me, 'garbage')],
      ['a proof from an unknown cloud', await dialRelay(url, me, proof(me, 'acct-1', now() + 86400, stranger))],
      ['an expired proof', await dialRelay(url, me, proof(me, 'acct-1', now() - 1))],
      ['a proof for another key', await dialRelay(url, me, proof(newIdentity('Someone else')))],
    ];
    for (const [what, l] of refusals) {
      check(`${what} is refused with 4003 and a reason`, !l.ready && l.closed?.code === 4003 && l.closed.reason.startsWith('this relay needs a parley account') === (what === 'no proof') && l.closed.reason.length > 10, l.closed);
    }
    check('the reasons say what is wrong', refusals[2]![1].closed?.reason === 'the account proof is not from a known parley cloud' && refusals[3]![1].closed?.reason === 'the account proof has expired' && refusals[4]![1].closed?.reason === 'the account proof is for another key', refusals.map(([, l]) => l.closed?.reason));
    const good = keep(await dialRelay(url, me, proof(me)));
    check('a valid proof connects', good.ready, good.closed);
    await shut([good]);

    const brief = newIdentity('Brief');
    const renewed = keep(await dialRelay(url, brief, proof(brief, 'acct-1', now() + 2)));
    const lapse = newIdentity('Lapse');
    const expiring = keep(await dialRelay(url, lapse, proof(lapse, 'acct-1', now() + 2)));
    renewed.ws.send(JSON.stringify({ t: 'renew', att: proof(brief, 'acct-1', now() + 5) }));
    const ended = await closedWithin(expiring, 4000);
    check('a connection whose proof expires is closed with 4003', ended?.code === 4003 && ended.reason === 'the account proof has expired', ended);
    check('a renewed connection outlives its first proof', renewed.ready && !renewed.closed, renewed.closed);
    const later = await closedWithin(renewed, 4000);
    check('and is closed when the renewed proof expires', later?.code === 4003 && later.reason === 'the account proof has expired', later);

    const crowd: Link[] = [];
    for (let i = 0; i < MAX_PER_IP; i++) {
      const id = newIdentity(`Crowd ${i}`);
      crowd.push(keep(await dialRelay(url, id, proof(id, `crowd-${i}`), '10.0.0.1, 203.0.113.7')));
    }
    const extra = newIdentity('One too many');
    const over = keep(await dialRelay(url, extra, proof(extra, 'crowd-x'), '203.0.113.7'));
    const elsewhere = keep(await dialRelay(url, extra, proof(extra, 'crowd-x'), '203.0.113.7, 198.51.100.9'));
    check(`${MAX_PER_IP} connections from one IP are let in`, crowd.every((l) => l.ready), crowd.map((l) => l.closed));
    check('one more from that IP is closed with 4029', !over.ready && over.closed?.code === 4029, over.closed);
    check('behind a loopback proxy, the last X-Forwarded-For hop is the IP', elsewhere.ready, elsewhere.closed);
    await shut([crowd[0]!]);
    const again = keep(await dialRelay(url, newIdentity('Back'), undefined, '203.0.113.7'));
    check('a closed connection frees its place', again.closed?.code === 4003 && again.closed.reason.startsWith('this relay needs'), again.closed);
    await shut([...crowd, elsewhere]);

    const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
    if (!lan) throw new Error('this machine has no non-loopback IPv4 address to test a direct peer on');
    const direct = startRelay(0, lan, { issuers: [issuer.publicKey] });
    try {
      const spoofed: Link[] = [];
      for (let i = 0; i <= MAX_PER_IP; i++) {
        const id = newIdentity(`Spoof ${i}`);
        spoofed.push(keep(await dialRelay(`ws://${lan}:${direct.port}`, id, proof(id, `spoof-${i}`), `192.0.2.${i}`)));
      }
      check('from a peer that is not loopback, X-Forwarded-For is ignored', spoofed.slice(0, MAX_PER_IP).every((l) => l.ready) && spoofed[MAX_PER_IP]!.closed?.code === 4029, spoofed.map((l) => l.closed?.code));
      await shut(spoofed);
    } finally {
      direct.stop(true);
    }

    const team: Link[] = [];
    for (let i = 0; i < 51; i++) {
      const id = newIdentity(`Team ${i}`);
      team.push(keep(await dialRelay(url, id, proof(id, 'big-account'), `198.51.100.${Math.floor(i / 10)}`)));
    }
    check('fifty connections of one account are let in', team.slice(0, 50).every((l) => l.ready), team.map((l) => l.closed?.code));
    check('the 51st is closed with 4029', team[50]!.closed?.code === 4029, team[50]!.closed);
    await shut([team[0]!]);
    const rejoin = newIdentity('Team again');
    const back = keep(await dialRelay(url, rejoin, proof(rejoin, 'big-account'), '198.51.100.99'));
    check('a closed connection frees its account place', back.ready, back.closed);
    await shut([...team, back]);

    const flood = keep(await dialRelay(relayUrl, newIdentity('Flood')));
    const chunk = JSON.stringify({ t: 'send', to: 'nobody', ref: 'x', payload: 'a'.repeat(200_000) });
    for (let i = 0; i < 25 && !flood.closed; i++) {
      flood.ws.send(chunk);
      await Bun.sleep(20);
    }
    const flooded = await closedWithin(flood, 2000);
    check('more than 4 MB in 10 s is closed with 4029, even on an open relay', flooded?.code === 4029, flooded);
  } finally {
    for (const l of opened) l.ws.close();
    gated.stop(true);
  }
}

async function conversations() {
  console.log('\n-- conversations that start, restart and collide');
  const [fayRoot, gusRoot] = [mkdtempSync(join(base, 'fay-')), mkdtempSync(join(base, 'gus-'))];
  const [faySock, gusSock] = [fakeSession(), fakeSession()];
  const fay = await agent(fayRoot, 'session-fay', faySock.env);
  let gus = await agent(gusRoot, 'session-gus', gusSock.env);
  const fayAddr = addressIn((await fay.tool('setup', { name: 'Fay' })).text);
  const gusAddr = addressIn((await gus.tool('setup', { name: 'Gus' })).text);
  const [toGus, toFay] = await Promise.all([
    fay.tool('send_message', { to: gusAddr, message: 'first from Fay' }),
    gus.tool('send_message', { to: fayAddr, message: 'first from Gus' }),
  ]);
  check('two sessions that write to each other at the same moment both get through', !toGus.failed && !toFay.failed && gusSock.texts().some((t) => t.includes('first from Fay')) && faySock.texts().some((t) => t.includes('first from Gus')), [toGus, toFay]);
  const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => fay.tool('send_message', { to: 'Gus', message: `burst ${n}` })));
  check('several messages sent at once all arrive', burst.every((r) => !r.failed) && [1, 2, 3, 4, 5].every((n) => gusSock.texts().some((t) => t.includes(`burst ${n}`))), burst);

  await gus.close();
  gus = await agent(gusRoot, 'session-gus', gusSock.env);
  await eventually(async () => ((await gus.tool('list_agents')).text.includes('Connected to the relay.') ? true : undefined));
  const after = await fay.tool('send_message', { to: 'Gus', message: 'after you restarted' });
  check('a session that restarted lost the conversation keys, and the next message starts over by itself', !after.failed && gusSock.texts().some((t) => t.includes('after you restarted')), after);
  await gus.close();
  gus = await agent(gusRoot, 'session-gus', gusSock.env);
  await eventually(async () => ((await gus.tool('list_agents')).text.includes('Connected to the relay.') ? true : undefined));
  const fromNew = await gus.tool('send_message', { to: 'Fay', message: 'from the restarted side' });
  const onward = await fay.tool('send_message', { to: 'Gus', message: 'and onward' });
  check('and so does one from the side that restarted', !fromNew.failed && !onward.failed && faySock.texts().some((t) => t.includes('from the restarted side')) && gusSock.texts().some((t) => t.includes('and onward')), [fromNew, onward]);
}

function listen(link: Link): any[] {
  const frames: any[] = [];
  link.ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
  return frames;
}

async function mailAtRelay() {
  console.log('\n# mail at the relay');
  const owl = newIdentity('Owl');
  const owlAddr = addressOf(owl.publicKey);
  const sam = newIdentity('Sam');
  let owlLink = await dialRelay(relayUrl, owl);
  let owlFrames = listen(owlLink);
  const spk = newPair();
  const opks = [newPair(), newPair(), newPair()];
  owlLink.ws.send(JSON.stringify({ t: 'prekeys', spk: { pub: spk.publicKey, sig: signPrekey(sam, spk.publicKey) }, opks: opks.map((o) => o.publicKey) }));
  const refused = await until(() => owlFrames.find((f) => f.t === 'prekeys' && f.error));
  check('a signed prekey not signed by the name is refused', refused?.error.includes('not signed by this name'), refused);
  const samLink = await dialRelay(relayUrl, sam);
  const samFrames = listen(samLink);
  samLink.ws.send(JSON.stringify({ t: 'send', to: addressOf(newIdentity('Nobody').publicKey), ref: 'm1', payload: { n: 1 }, hold: true }));
  const noBox = await until(() => samFrames.find((f) => f.t === 'undeliverable' && f.ref === 'm1'));
  check('a frame for a name that left no keys cannot be held', noBox?.why === 'no mailbox', noBox);
  owlLink.ws.send(JSON.stringify({ t: 'prekeys', spk: { pub: spk.publicKey, sig: signPrekey(owl, spk.publicKey) }, opks: opks.map((o) => o.publicKey) }));
  const left = await until(() => owlFrames.find((f) => f.t === 'prekeys' && f.left !== undefined));
  check('leaving keys says how many one-time keys the relay holds', left?.left === 3, left);
  samLink.ws.send(JSON.stringify({ t: 'prekeys', id: owlAddr }));
  const bundle = await until(() => samFrames.find((f) => f.t === 'prekeys' && f.id === owlAddr));
  check('a sender gets the signed prekey and one one-time key', bundle?.key === owl.publicKey && bundle.spk?.pub === spk.publicKey && bundle.spk.sig === signPrekey(owl, spk.publicKey) && opks.some((o) => o.publicKey === bundle.opk), bundle);
  const fewer = await until(() => owlFrames.find((f) => f.t === 'prekeys' && f.left === 2));
  check('and the owner is told its stock is low', fewer, owlFrames);
  samLink.ws.send(JSON.stringify({ t: 'prekeys', id: 'zzz-zzz-zzz' }));
  const none = await until(() => samFrames.find((f) => f.t === 'prekeys' && f.id === 'zzz-zzz-zzz'));
  check('a name that left no keys gives none', none && none.key === undefined, none);
  samLink.ws.send(JSON.stringify({ t: 'send', to: owlAddr, ref: 'live', payload: { n: 0 }, hold: true }));
  const live = await until(() => owlFrames.find((f) => f.t === 'recv' && f.payload?.n === 0));
  check('a frame for a name that is online is delivered, hold or not', live && live.held === undefined, live);

  owlLink.ws.close();
  await Bun.sleep(200);
  samLink.ws.send(JSON.stringify({ t: 'send', to: owlAddr, ref: 'plain', payload: { n: -1 } }));
  const plain = await until(() => samFrames.find((f) => f.t === 'undeliverable' && f.ref === 'plain'));
  check('a frame sent without hold is not kept', plain && plain.why === undefined, plain);
  for (let n = 1; n <= MAIL_FRAMES_MAX; n++) samLink.ws.send(JSON.stringify({ t: 'send', to: owlAddr, ref: `m${n}`, payload: { n }, hold: true }));
  const heldAll = await until(() => samFrames.filter((f) => f.t === 'held').length === MAIL_FRAMES_MAX || undefined);
  check(`a frame sent with hold is kept, up to ${MAIL_FRAMES_MAX}`, heldAll && samFrames.find((f) => f.t === 'held')?.ref === 'm1', samFrames.filter((f) => f.t === 'held').length);
  samLink.ws.send(JSON.stringify({ t: 'send', to: owlAddr, ref: 'one-more', payload: { n: 101 }, hold: true }));
  const full = await until(() => samFrames.find((f) => f.t === 'undeliverable' && f.ref === 'one-more'));
  check('and the one after is refused as full', full?.why === 'full', full);
  const reach = await fetch(`http://127.0.0.1:${relay.port}/online`, { method: 'POST', body: JSON.stringify({ ids: [owlAddr, addressOf(sam.publicKey), 'zzz-zzz-zzz'] }) }).then((r) => r.json() as Promise<any>);
  check('/online says who has mail', reach.reachable.length === 1 && reach.reachable[0] === owlAddr && reach.online.length === 1, reach);

  owlLink = await dialRelay(relayUrl, owl);
  owlFrames = listen(owlLink);
  const all = await until(() => (owlFrames.filter((f) => f.t === 'recv' && f.held).length === MAIL_FRAMES_MAX ? owlFrames.filter((f) => f.t === 'recv' && f.held) : undefined));
  check('what was held comes when the owner is back, oldest first, with when it arrived', all && all[0]?.payload.n === 1 && all[0].held.seq === 1 && all[MAIL_FRAMES_MAX - 1]?.held.seq === MAIL_FRAMES_MAX && all[0].from === addressOf(sam.publicKey) && /^20/.test(all[0].held.at), all?.slice(0, 2));
  check('after the stock count', owlFrames[0]?.t === 'prekeys' && owlFrames[0].left === 2, owlFrames[0]);
  owlLink.ws.send(JSON.stringify({ t: 'took', seq: 2 }));
  await Bun.sleep(100);
  owlLink.ws.close();
  await Bun.sleep(200);
  owlLink = await dialRelay(relayUrl, owl);
  owlFrames = listen(owlLink);
  const rest = await until(() => (owlFrames.filter((f) => f.t === 'recv' && f.held).length === MAIL_FRAMES_MAX - 2 ? owlFrames.filter((f) => f.t === 'recv' && f.held) : undefined));
  check('what was not taken comes again', rest && rest[0]?.held.seq === 3, rest?.[0]);
  owlLink.ws.send(JSON.stringify({ t: 'took', seq: MAIL_FRAMES_MAX }));
  await Bun.sleep(100);
  owlLink.ws.close();
  await Bun.sleep(200);
  owlLink = await dialRelay(relayUrl, owl);
  owlFrames = listen(owlLink);
  await Bun.sleep(300);
  check('and what was taken does not', !owlFrames.some((f) => f.t === 'recv'), owlFrames);
  owlLink.ws.close();

  for (let i = 0; i < 5; i++) samLink.ws.send(JSON.stringify({ t: 'prekeys', id: owlAddr }));
  const limited = await until(() => samFrames.find((f) => f.t === 'prekeys' && f.id === owlAddr && f.error));
  check('a sender cannot take the keys of one name over and over', limited?.error.includes('too many'), limited);
  samLink.ws.close();
}

async function mailKeptWhenUnopenable() {
  console.log('\n# mail a session cannot open is kept, not dropped');
  const mailDir = join(base, 'kept-mail');
  const r = startRelay(0, '127.0.0.1', { mailDir });
  cleanup.push(() => r.stop(true));
  const at = { PARLEY_RELAY: `ws://127.0.0.1:${r.port}` };
  const annSock = fakeSession();
  const gusSock = fakeSession();
  const annRoot = mkdtempSync(join(base, 'kept-ann-'));
  const gusRoot = mkdtempSync(join(base, 'kept-gus-'));
  const ann = await agent(annRoot, 'session-kept-ann', { ...annSock.env, ...at });
  const annAddr = addressIn((await ann.tool('setup', { name: 'Ann2' })).text);
  const gus = await agent(gusRoot, 'session-gus', { ...gusSock.env, ...at });
  const gusAddr = addressIn((await gus.tool('setup', { name: 'Gus' })).text);
  const gusHome = join(gusRoot, 'ids', gusAddr);
  await until(() => (existsSync(join(gusHome, 'prekeys.json')) ? true : undefined));
  await gus.close();
  const sent = await eventually(async () => {
    const res = await ann.tool('send_message', { to: gusAddr, message: 'you will never read this' });
    return res.text.startsWith('Left for') ? res : undefined;
  });
  check('the message is left at the relay', sent?.text.includes('at the relay'), sent);
  const mailFile = join(mailDir, `${gusAddr}.json`);
  const held = () => (existsSync(mailFile) ? (JSON.parse(readFileSync(mailFile, 'utf8')).frames.length as number) : 0);
  check('and the relay holds it', await until(() => (held() === 1 ? true : undefined)), held());
  // Gus loses the one-time key its only copy was sealed to, so it can never open it.
  rmSync(join(gusHome, 'prekeys.json'), { force: true });
  const back = await agent(gusRoot, 'session-gus', { ...gusSock.env, ...at });
  await Bun.sleep(3000);
  check('a session that cannot open it does not read it', !gusSock.texts().some((t) => t.includes('you will never read this')), gusSock.texts());
  check('the relay still holds it, rather than dropping it on a took', existsSync(mailFile) && held() === 1, existsSync(mailFile) && held());
  check('and the sender is not told it arrived', !annSock.texts().some((t) => t.includes('now has the message') || t.includes('has read the message')), annSock.texts());
  await back.close();
  await ann.close();
}

async function daemon(p: Pair) {
  console.log('\n# the machine\'s daemon');
  const root = join(base, 'machine-dan');
  const danSock = fakeSession();
  const on = { ...danSock.env, PARLEY_DAEMON: 'on' };
  const dan = await agent(root, 'session-dan', on);
  const danAddr = addressIn((await dan.tool('setup', { name: 'Dan' })).text);
  const info = await until(() => (existsSync(join(root, 'daemon.json')) ? readJson<{ pid: number; version: string }>(root, 'daemon.json') : undefined), 10_000);
  cleanup.push(() => cli(root, 'daemon', 'stop'));
  check('a session that takes a name starts the daemon', info && alive(info.pid) && info.version === VERSION, info);
  const idle = await eventually(async () => (cli(root, 'daemon', 'status').includes('nothing') ? true : undefined), 10_000);
  check('which holds nothing while the session holds the name', idle, cli(root, 'daemon', 'status'));
  await dan.close();
  const took = await eventually(async () => (cli(root, 'daemon', 'status').includes(`"Dan" (${danAddr}): connected`) ? true : undefined), 15_000);
  check('and holds it once the session is gone', took, cli(root, 'daemon', 'status'));
  const sent = await eventually(async () => {
    const r = await p.ann.tool('send_message', { to: danAddr, message: 'for when you are back' });
    return r.failed ? undefined : r;
  });
  check('a message to the name is left with its machine', sent?.text.startsWith(`Left for "Dan" (${danAddr}): no session with that name is open`) && sent.text.includes('its machine holds the message'), sent);
  const inbox = join(root, 'ids', danAddr, 'inbox.json');
  check('and waits in its inbox, for its owner only', existsSync(inbox) && (statSync(inbox).mode & 0o777) === 0o600 && readFileSync(inbox, 'utf8').includes('for when you are back'));
  check('the daemon logs no message text', !readFileSync(join(root, 'daemon.log'), 'utf8').includes('for when you are back'));
  const back = await agent(root, 'session-dan', on);
  const got = await until(() => danSock.texts().find((t) => t.includes('for when you are back')));
  check('it goes in when a session takes the name again, saying when it was sent', got?.includes(`from "Ann" (${p.annAddr}, not verified), sent 20`) && got.includes('kept until now'), got);
  const read = await until(() => p.annSock.texts().find((t) => t.includes('has read the message you left')));
  check('and the sender is told it was read', read?.includes(`"Dan" (${danAddr}) has read the message you left for it`), p.annSock.texts());
  check('the inbox is empty again', !existsSync(inbox));
  const freed = await eventually(async () => (cli(root, 'daemon', 'status').includes('nothing') ? true : undefined), 10_000);
  check('and the daemon has let go of the name', freed, cli(root, 'daemon', 'status'));
  const live = await p.ann.tool('send_message', { to: danAddr, message: 'and now live' });
  check('a message to the open session is delivered as before', !live.failed && live.text === `Delivered to "Dan" (${danAddr}).` && danSock.texts().some((t) => t.includes('and now live')), live);
  await back.close();
  cli(root, 'daemon', 'stop');
  const stopped = await until(() => !existsSync(join(root, 'daemon.json')) || undefined, 5000);
  check('`parley daemon stop` ends it', stopped && cli(root, 'daemon', 'status').includes('No parley daemon'), stopped);
}

async function otherAgents(p: Pair) {
  console.log('\n# agents other than Claude Code');
  const home = mkdtempSync(join(base, 'home-'));
  const setup = (...args: string[]) => {
    const { XDG_CONFIG_HOME: _x, CODEX_HOME: _c, ...clean } = ENV as Record<string, string | undefined>;
    const done = Bun.spawnSync([...RUN, 'install', ...args], { env: { ...clean, HOME: home, PARLEY_HOME: A_ROOT, PARLEY_RELAY: relayUrl, PARLEY_CLOUD: 'https://cloud.test' } });
    return { ok: done.exitCode === 0, text: done.stdout.toString() + done.stderr.toString() };
  };
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const all = setup('all');
  const read = (...parts: string[]) => JSON.parse(readFileSync(join(home, ...parts), 'utf8'));
  const cursor = read('.cursor', 'mcp.json');
  check('`parley install all` writes every agent\'s config and says so', all.ok && ['Codex', 'Cursor', 'Gemini CLI', 'opencode', 'Copilot CLI'].every((a) => all.text.includes(`${a}: parley is in`)), all);
  check('Cursor gets the server beside what was there', cursor.mcpServers.other.command === 'x' && cursor.mcpServers.parley.args.at(-1) === 'mcp' && cursor.mcpServers.parley.env.PARLEY_AGENT === 'cursor' && cursor.mcpServers.parley.env.PARLEY_RELAY === relayUrl, cursor);
  const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  check('Codex gets a TOML table beside what was there', codex.startsWith('model = "o3"') && codex.includes('[mcp_servers.other]') && codex.includes('[mcp_servers.parley]') && codex.includes('PARLEY_AGENT = "codex"'), codex);
  check('Gemini CLI, opencode and Copilot CLI get theirs', read('.gemini', 'settings.json').mcpServers.parley.env.PARLEY_AGENT === 'gemini' && read('.config', 'opencode', 'opencode.json').mcp.parley.command.at(-1) === 'mcp' && read('.copilot', 'mcp-config.json').mcpServers.parley.tools[0] === '*');
  setup('codex');
  setup('cursor');
  check('installing again changes nothing', readFileSync(join(home, '.codex', 'config.toml'), 'utf8') === codex && JSON.stringify(read('.cursor', 'mcp.json')) === JSON.stringify(cursor));
  writeFileSync(join(home, '.gemini', 'settings.json'), '{');
  const bad = setup('gemini');
  check('a config that is not JSON is left alone', !bad.ok && bad.text.includes('not JSON') && readFileSync(join(home, '.gemini', 'settings.json'), 'utf8') === '{', bad);

  const root = join(base, 'machine-codex');
  const cx = await agent(root, '', { PARLEY_AGENT: 'codex' });
  const told = cx.client.getInstructions() ?? '';
  check('a Codex session is told so, and not about SendMessage', told.includes('this Codex session') && told.includes('check_inbox') && !told.includes('SendMessage'), told.slice(0, 200));
  check('it has the inbox tool', (await cx.client.listTools()).tools.some((t) => t.name === 'check_inbox'));
  const listed = await cx.tool('list_agents');
  const name = `Codex on ${machine()}`;
  check('and takes a name by itself, from the agent and the machine', !listed.failed && listed.text.includes(`This session is "${name}"`) && listed.text.includes('Connected to the relay.'), listed);
  const addr = addressIn(listed.text);
  const sent = await p.ann.tool('send_message', { to: addr, message: 'hello codex' });
  check('a message to it is delivered', !sent.failed && sent.text === `Delivered to "${name}" (${addr}).`, sent);
  const got = await cx.tool('check_inbox');
  check('and check_inbox gives it', !got.failed && got.text.includes('parley message from "Ann"') && got.text.includes('hello codex'), got);
  const empty = await cx.tool('check_inbox');
  check('once', empty.text === 'Nothing came in.', empty);
  const waiting = cx.tool('check_inbox', { wait: 20 });
  setTimeout(() => void p.ann.tool('send_message', { to: addr, message: 'while you wait' }), 500);
  const waited = await waiting;
  check('check_inbox with wait returns when a message comes', waited.text.includes('while you wait'), waited);
  const back = await cx.tool('send_message', { to: 'Ann', message: 'hi from codex' });
  check('it replies by name', !back.failed && back.text.startsWith('Delivered') && (await until(() => p.annSock.texts().find((t) => t.includes('hi from codex'))))?.includes(`from "${name}"`), back);
  const cx2 = await agent(root, '', { PARLEY_AGENT: 'codex' });
  const second = await cx2.tool('list_agents');
  check('a second session on the machine gets the next name', second.text.includes(`This session is "${name} 2"`), second);
  await cx2.close();
  await cx.close();
  const cx3 = await agent(root, '', { PARLEY_AGENT: 'codex' });
  const third = await cx3.tool('list_agents');
  check('a session that restarts is its name again', third.text.includes(`This session is "${name}" (${addr})`), third);
  await cx3.close();
}

async function twoRelays() {
  console.log('\n-- two relays behind one address');
  const free = () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const { port } = probe;
    probe.stop(true);
    return port;
  };
  const [p1, p2] = [free(), free()];
  const urls = [`ws://127.0.0.1:${p1}`, `ws://127.0.0.1:${p2}`];
  const peers = (i: number) => ({ port: [p1, p2][i]!, hostname: '127.0.0.1', secret: 'between-relays', self: urls[i]!, discover: async () => [...urls, `${urls[i]}/`] });
  const talksFile = join(base, 'talks.json');
  const mailDir = join(base, 'mail');
  const east = startRelay(0, '127.0.0.1', { peers: peers(0), talksFile, mailDir });
  const west = startRelay(0, '127.0.0.1', { peers: peers(1) });
  cleanup.push(() => east.stop(true), () => west.stop(true));
  const at = (r: { port?: number }) => ({ PARLEY_RELAY: `ws://127.0.0.1:${r.port}` });
  const eveSock = fakeSession();
  const walSock = fakeSession();
  const eveRoot = mkdtempSync(join(base, 'eve-'));
  const eve = await agent(eveRoot, 'session-eve', { ...eveSock.env, ...at(east) });
  const wal = await agent(mkdtempSync(join(base, 'wal-')), 'session-wal', { ...walSock.env, ...at(west) });
  const eveAddr = addressIn((await eve.tool('setup', { name: 'Eve' })).text);
  const walAddr = addressIn((await wal.tool('setup', { name: 'Wal' })).text);

  const over = await eventually(async () => {
    const r = await eve.tool('send_message', { to: walAddr, message: 'across the relays' });
    return r.failed ? undefined : r;
  });
  check('a name on one relay reaches a name on the other', over?.text === `Delivered to "Wal" (${walAddr}).` && walSock.texts().some((t) => t.includes('across the relays')), over);
  const back = await wal.tool('send_message', { to: 'Eve', message: 'and back' });
  check('and the reply comes back', !back.failed && eveSock.texts().some((t) => t.includes('and back')), back);
  const status = (r: { port?: number }, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${r.port}/online`, { method: 'POST', headers, body: JSON.stringify({ ids: [eveAddr, walAddr, 'abc-def-ghj'] }) }).then((res) => res.json() as Promise<any>);
  for (const [name, relay] of [['east', east], ['west', west]] as const) {
    const seen = await status(relay);
    check(`the ${name} relay tells its own machine who is online and who talked with whom`, seen.online.length === 2 && seen.talks[eveAddr]?.[0]?.[0] === walAddr && seen.talks[walAddr]?.[0]?.[0] === eveAddr && !seen.talks['abc-def-ghj'], seen);
  }
  await Bun.sleep(22_000);
  for (const [name, relay] of [['east', east], ['west', west]] as const) {
    const { talks } = await status(relay);
    check(`the ${name} relay does not count a session checking its own connection as talking with itself`, talks[eveAddr].length === 1 && talks[walAddr].length === 1, talks);
  }
  const saved = readFileSync(talksFile, 'utf8');
  writeFileSync(join(base, 'talks-old.json'), JSON.stringify([...JSON.parse(saved), ['abc-def-ghj', [[walAddr, Date.now() - 8 * 24 * 3600_000]]]]));
  const restarted = startRelay(0, '127.0.0.1', { talksFile: join(base, 'talks-old.json') });
  cleanup.push(() => restarted.stop(true));
  const { talks: kept } = await status(restarted);
  check('a relay that restarts still knows who talked with whom', kept[eveAddr]?.[0]?.[0] === walAddr && kept[walAddr]?.[0]?.[0] === eveAddr, kept);
  check('but not from more than seven days ago', kept['abc-def-ghj'] === undefined, kept);
  check('and what it saved holds ids and times alone, for its own user only', /^[\[\]",\-a-z0-9]+$/.test(saved) && !saved.includes('across') && (statSync(talksFile).mode & 0o777) === 0o600, saved);
  writeFileSync(join(base, 'talks-bad.json'), 'not json');
  const bad = startRelay(0, '127.0.0.1', { talksFile: join(base, 'talks-bad.json') });
  cleanup.push(() => bad.stop(true));
  check('a saved file that cannot be read does not keep the relay down', (await status(bad)).online.length === 0);
  const outside = await status(east, { 'x-forwarded-for': '203.0.113.9' });
  check('a caller from elsewhere is told who is online and no more', outside.online.length === 2 && outside.talks === undefined, outside);
  const nobody = await eve.tool('send_message', { to: 'abc-def-ghj', message: 'anyone?' });
  check('an id on neither relay is not online', nobody.failed && nobody.text.includes('is not online'), nobody);

  await eve.close();
  const moved = await agent(eveRoot, 'session-eve', { ...eveSock.env, ...at(west) });
  const again = await eventually(async () => {
    const r = await wal.tool('send_message', { to: 'Eve', message: 'you moved' });
    return !r.failed && r.text.startsWith('Delivered') ? r : undefined;
  });
  check('a name that reconnects to the other relay is found there', again && eveSock.texts().some((t) => t.includes('you moved')), again);
  await moved.close();
  const gone = await eventually(async () => {
    const r = await wal.tool('send_message', { to: eveAddr, message: 'still there?' });
    return !r.failed && r.text.startsWith('Left for') ? r : undefined;
  });
  check('once it closes, a message from the other relay is left in its mail at the keeper', gone?.text.includes('at the relay'), gone);
  const file = await until(() => (existsSync(join(mailDir, `${eveAddr}.json`)) ? readFileSync(join(mailDir, `${eveAddr}.json`), 'utf8') : undefined), 3000);
  check('which keeps it on disk, sealed, for its own user only', file && !file.includes('still there') && (statSync(join(mailDir, `${eveAddr}.json`)).mode & 0o777) === 0o600, file?.slice(0, 80));
  const returned = await agent(eveRoot, 'session-eve', { ...eveSock.env, ...at(west) });
  const waited = await until(() => eveSock.texts().find((t) => t.includes("still there?")), 10_000);
  check("and it reaches the name when it is back on the other relay", waited?.includes('kept until now'), eveSock.texts());
  check('with the sender told', await until(() => walSock.texts().find((t) => t.includes('now has the message you left'))), walSock.texts());
  await returned.close();

  await Bun.sleep(4000);
  const steady = await wal.tool('list_agents');
  check('a relay that finds itself among its peers keeps its names online', steady.text.includes('Connected to the relay.'), steady);

  const outsider = new WebSocket(`ws://127.0.0.1:${p1}`);
  const closed = new Promise<number>((resolve) => (outsider.onclose = (ev) => resolve(ev.code)));
  outsider.onopen = () => outsider.send(JSON.stringify({ t: 'peer', secret: 'a guess', from: 'ws://evil' }));
  check('a relay without the shared secret is turned away', (await closed) === 4001);
}

function register(name: string, socket: string, pid?: number) {
  const proc = pid === undefined ? Bun.spawn(['sleep', '600']) : undefined;
  if (proc) cleanup.push(() => proc.kill());
  const id = pid ?? proc!.pid;
  const dir = join(CLAUDE_DIR, 'sessions');
  const peerToken = randomBytes(16).toString('hex');
  writeJson(dir, `${id}.json`, { pid: id, name, messagingSocketPath: socket, status: 'idle' });
  writeJson(dir, `${id}.${createHash('sha256').update(socket).digest('hex')}.key`, { peerToken }, true);
  return { peerToken, forget: () => rmSync(join(dir, `${id}.json`)) };
}

async function linkedMachine() {
  console.log('\n-- a machine linked to an account');
  const stub = startCloudStub();
  const gated = startRelay(0, '127.0.0.1', { issuers: [cloudIssuer.publicKey] });
  cleanup.push(() => gated.stop(true));
  const root = mkdtempSync(join(base, 'linked-'));
  const env = { PARLEY_CLOUD: stub.url, PARLEY_RELAY: `ws://127.0.0.1:${gated.port}` };
  const [oneSock, twoSock] = [fakeSession(), fakeSession()];
  const one = await agent(root, 'session-one', { ...env, ...oneSock.env });
  await one.tool('setup', { name: 'One' });
  const before = await one.tool('list_agents');
  check('before the machine is linked, its session is refused', before.text.includes('This machine is not linked to a parley account yet'), before);
  stub.machines.set(readJson<Identity>(root, 'machine.json').publicKey, { sub: 'acct-owner', domain: 'owner.example' });
  const on = await eventually(async () => {
    const r = await one.tool('list_agents');
    return r.text.includes('Connected to the relay.') ? r : undefined;
  }, 45_000);
  check('once it is linked, the session gets on by itself', on?.text.includes('verified · owner.example'), on);
  const two = await agent(root, 'session-two', { ...env, ...twoSock.env });
  const twoAddr = addressIn((await two.tool('setup', { name: 'Two' })).text);
  const second = await eventually(async () => {
    const r = await two.tool('list_agents');
    return r.text.includes('Connected to the relay.') ? r : undefined;
  }, 20_000);
  check('a new name on the machine needs no link of its own', second?.text.includes('verified · owner.example') && !second.text.includes('/link?'), second);
  const sent = await one.tool('send_message', { to: twoAddr, message: 'same account' });
  check('and the two message each other', !sent.failed && twoSock.texts().some((t) => t.includes('same account')), sent);
  const stranger = await agent(mkdtempSync(join(base, 'other-')), 'session-x', { ...env, ...fakeSession().env });
  await stranger.tool('setup', { name: 'Stranger' });
  const no = await stranger.tool('list_agents');
  check('a name on another machine is still refused', no.text.includes('Not connected to the relay'), no);
}

async function sessionsHere() {
  console.log('\n-- sessions on this machine are Claude Code\'s own to message');
  const frontSock = fakeSession();
  const backSock = fakeSession();
  register('front-desk', frontSock.env.CLAUDE_CODE_MESSAGING_SOCKET);
  register('Back-Office', backSock.env.CLAUDE_CODE_MESSAGING_SOCKET);
  const fd = await agent(mkdtempSync(join(base, 'fd-')), 'session-front', frontSock.env);
  check('the instructions send same-machine messages to SendMessage', (fd.client.getInstructions() ?? '').includes('to message a session on this machine, use SendMessage'));
  const named = await fd.tool('setup', {});
  check('setup with no name takes the Claude Code session name', !named.failed && named.text.includes('This session is now "front-desk"') && addressIn(named.text), named);
  const listed = await fd.tool('list_agents');
  check('list_agents does not list the sessions on this machine', !listed.failed && !listed.text.includes('Back-Office'), listed);
  const sent = await fd.tool('send_message', { to: 'Back-Office', message: 'hello' });
  check('and a Claude Code session name is not something parley delivers to', sent.failed && backSock.arrivals.length === 0, sent);
}

try {
  console.log(`parley ${VERSION} on ${RUN[0]}`);
  sealing();
  const pair = await messaging();
  await mailAtRelay();
  await mailKeptWhenUnopenable();
  await daemon(pair);
  await otherAgents(pair);
  await forgery(pair);
  await names(pair);
  await olderContacts(pair);
  await olderNode();
  await olderVersion();
  await manySenders();
  await oneLine();
  await accountRelays();
  await accounts();
  await networks();
  await linkedMachine();
  await sessionsHere();
  await twoRelays();
  await conversations();
} catch (err) {
  failures++;
  console.log('FAIL  the run stopped early ->', err instanceof Error ? err.stack : err);
} finally {
  for (const done of cleanup.reverse()) {
    try {
      await done();
    } catch {
    }
  }
  relay.stop(true);
}
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}   (state kept in ${base})`);
process.exit(failures ? 1 : 0);

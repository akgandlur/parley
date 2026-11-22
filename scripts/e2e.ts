// Drives real parley MCP servers through a real relay on this machine. Each
// stands in a Claude Code session whose socket the script plays; nothing
// here calls a model.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ServerWebSocket } from 'bun';
import { addressOf, newIdentity, openFor, sealTo, signText, verifyText, type Identity } from '../src/crypto';
import { makeAttestation } from '../src/attest';
import { readJson, writeJson, type Contact } from '../src/home';
import { MAX_PER_IP, RELAY_AUTH, startRelay } from '../src/relay';
import { VERSION } from '../src/types';

// PARLEY_E2E_CLI="node /abs/bin/parley.mjs" runs the same checks against
// the bundle the plugin ships.
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

// The run may itself be inside a Claude Code session. The sessions here are
// not that one, and must never write into its socket.
const {
  CLAUDE_CODE_SESSION_ID: _id,
  CLAUDE_CODE_MESSAGING_SOCKET: _sock,
  CLAUDE_CODE_MESSAGING_TOKEN: _token,
  ...ENV
} = process.env;

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

// What Claude Code's side of its messaging socket sees: an optional auth
// line, then frames, one connection per message.
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
  };
}

type Reply = { isError?: boolean; content: { text: string }[] };

// One Claude Code session's MCP server. `session` stands in for the id
// Claude Code gives each session.
async function agent(root: string, session: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: RUN[0] ?? 'bun',
    args: [...RUN.slice(1), 'mcp'],
    env: { ...ENV, PARLEY_HOME: root, PARLEY_RELAY: relayUrl, CLAUDE_CODE_SESSION_ID: session, ...env } as Record<string, string>,
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

function sealing() {
  console.log('\n# a message is sealed to the address it is for');
  const [ann, ben, cat] = [newIdentity('Ann'), newIdentity('Ben'), newIdentity('Cat')];
  const text = 'line one\nline two · ünïcödé 🚀';
  const sealed = sealTo(ben.publicKey, text);
  check('the one it is sealed to opens it', openFor(ben, sealed.eph, sealed.box) === text);
  check('anyone else cannot', (() => {
    try {
      openFor(cat, sealed.eph, sealed.box);
      return false;
    } catch {
      return true;
    }
  })());
  const flipped = Buffer.from(sealed.box, 'base64url');
  flipped[0] = flipped[0]! ^ 1;
  check('a changed byte does not open', (() => {
    try {
      openFor(ben, sealed.eph, flipped.toString('base64url'));
      return false;
    } catch {
      return true;
    }
  })());
  const back = sealTo(ann.publicKey, 'and back');
  check('it works the other way and twice over', openFor(ann, back.eph, back.box) === 'and back' && sealTo(ben.publicKey, text).box !== sealed.box);
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
  check('the tools are setup, list_agents, send_message and cloud_link', JSON.stringify(tools) === JSON.stringify(['cloud_link', 'list_agents', 'send_message', 'setup']), tools);
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
  check('and says how to answer', content.endsWith('reply with parley\'s send_message to "Ann", not SendMessage.'), content);
  check('nothing reached Ann\'s own session', annSock.arrivals.length === 0, annSock.arrivals);

  const back = await ben.tool('send_message', { to: 'Ann', message: 'On it.' });
  check('the reply goes to the name on the message', !back.failed && back.text === `Delivered to "Ann" (${annAddr}).` && annSock.texts()[0]?.includes('\n\nOn it.\n\n'), [back, annSock.texts()]);
  const byName = await ann.tool('send_message', { to: 'ben', message: 'Thanks' });
  check('a name is matched without case once a message has been exchanged', !byName.failed, byName);
  const theirs = await ann.tool('list_agents');
  check('list_agents shows who can be messaged', theirs.text.includes(`"Ben" (${benAddr})`), theirs);

  const log = (root: string, addr: string) =>
    readFileSync(join(root, 'ids', addr, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const annLog = log(A_ROOT, annAddr);
  const benLog = log(B_ROOT, benAddr);
  check('both sides keep a log of what went each way', annLog.filter((e) => e.dir === 'out').length === 2 && annLog.filter((e) => e.dir === 'in').length === 1 && benLog.filter((e) => e.dir === 'in').length === 2 && benLog[0].text === first, [annLog, benLog]);

  const big = 'x'.repeat(100_000);
  const large = await ann.tool('send_message', { to: 'Ben', message: big });
  check('a long message goes through whole', !large.failed && benSock.texts().some((t) => t.includes(big)), large.text);

  console.log('\n# when the other side is not there');
  const nobody = await ann.tool('send_message', { to: 'zzz-zzz-zzz', message: 'anyone?' });
  check('an id with no open session says so', nobody.failed && nobody.text.includes('is not online'), nobody);
  const benPid = ben.pid;
  await ben.close();
  check('closing the session ends its parley server', await until(() => !alive(benPid) || undefined, 5000), benPid);
  const gone = await ann.tool('send_message', { to: 'Ben', message: 'still there?' });
  check('a message to a closed session says it is not online', gone.failed && gone.text.includes('is not online'), gone);
  const again = await agent(B_ROOT, 'session-ben', benSock.env);
  const before = benSock.arrivals.length;
  const resumed = await eventually(async () => {
    const r = await ann.tool('send_message', { to: 'Ben', message: 'welcome back' });
    return r.failed ? undefined : r;
  });
  check('the same session comes back as its name with no setup, and is reachable', resumed?.text.includes('Delivered') && benSock.arrivals.length === before + 1, resumed);
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

// A raw relay client stands in for a relay or a peer that misbehaves.
async function forgery(p: Pair) {
  console.log('\n# what a relay or a stranger cannot do');
  const eve = newIdentity('Eve');
  const link = await dialRelay(relayUrl, eve);
  const benKey = readJson<Identity>(join(B_ROOT, 'ids', p.benAddr), 'identity.json').publicKey;
  const annId = readJson<Identity>(join(A_ROOT, 'ids', p.annAddr), 'identity.json');
  const before = p.benSock.arrivals.length;
  const send = (to: string, payload: object) => link.ws.send(JSON.stringify({ t: 'send', to, ref: 'x', payload }));
  const inner = (name: string, text: string) => JSON.stringify({ id: randomBytes(9).toString('base64url'), name, text, at: new Date().toISOString() });

  const asAnn = sealTo(benKey, inner('Ann', 'from Eve, claiming to be Ann'));
  send(p.benAddr, { v: 2, kind: 'msg', key: annId.publicKey, ...asAnn, sig: signText(annId, `parley message\n${p.benAddr}\n${asAnn.eph}\n${asAnn.box}`) });
  const forCat = sealTo(benKey, inner('Eve', 'meant for someone else'));
  const catKey = readJson<Identity>(join(C_ROOT, 'ids', p.catAddr), 'identity.json').publicKey;
  const toCat = sealTo(catKey, inner('Eve', 'signed for Ben, sent to Cat'));
  send(p.catAddr, { v: 2, kind: 'msg', key: eve.publicKey, ...toCat, sig: signText(eve, `parley message\n${p.benAddr}\n${toCat.eph}\n${toCat.box}`) });
  send(p.benAddr, { v: 2, kind: 'msg', key: eve.publicKey, ...forCat, sig: 'not-a-signature' });
  await Bun.sleep(800);
  check('a message under someone else\'s key is dropped', p.benSock.arrivals.length === before, p.benSock.texts().slice(before));
  const catSaw = await p.cat.tool('list_agents');
  check('a message signed for another id is dropped', !catSaw.text.includes('signed for Ben'), catSaw);

  const own = sealTo(benKey, inner('Eve', 'hello from Eve'));
  const frame = { v: 2, kind: 'msg', key: eve.publicKey, ...own, sig: signText(eve, `parley message\n${p.benAddr}\n${own.eph}\n${own.box}`) };
  send(p.benAddr, frame);
  send(p.benAddr, frame);
  const got = await until(() => p.benSock.texts().filter((t) => t.includes('hello from Eve')).length || undefined, 3000);
  await Bun.sleep(500);
  check('a stranger can message by id, and a replayed message arrives once', got === 1 && p.benSock.texts().filter((t) => t.includes('hello from Eve')).length === 1, p.benSock.texts().slice(before));
  link.ws.close();

  const contacts = readJson<Record<string, Contact>>(B_ROOT, 'contacts.json');
  writeJson(B_ROOT, 'contacts.json', { ...contacts, [p.annAddr]: { ...contacts[p.annAddr]!, key: newIdentity('Other').publicKey } });
  const count = p.benSock.arrivals.length;
  void p.ann.tool('send_message', { to: 'Ben', message: 'from a key Ben does not know for me' });
  await Bun.sleep(1500);
  check('a known id that turns up with another key is not believed', p.benSock.arrivals.length === count);
  writeJson(B_ROOT, 'contacts.json', contacts);
}

async function names(p: Pair) {
  console.log('\n# a name for each Claude Code session');
  const other = await agent(A_ROOT, 'session-ann-2');
  const taken = await other.tool('setup', { name: 'ann' });
  check('a name another open session holds is refused', taken.failed && taken.text.includes('is in use by another Claude Code session'), taken);
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

const cloudIssuer = newIdentity('Test cloud');
const unix = () => Math.floor(Date.now() / 1000);
type Account = { sub: string; domain: string | null; banned?: boolean; lifetime?: number };

// A stand-in for the cloud: it checks what a real one must check and gives
// the accounts it is told about their proofs.
function startCloudStub() {
  const accounts = new Map<string, Account>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const text = await req.text();
      const [key, time, sig] = ['x-parley-key', 'x-parley-time', 'x-parley-sig'].map((h) => req.headers.get(h) ?? '');
      const digest = new Bun.CryptoHasher('sha256').update(text).digest('hex');
      const signed = verifyText(key ?? '', `parley-cloud-attest\n${time}\n${digest}`, sig ?? '');
      const account = signed ? accounts.get(key ?? '') : undefined;
      if (!account) return Response.json({ error: 'not linked' }, { status: 403 });
      if (account.banned) return Response.json({ error: 'banned' }, { status: 403 });
      const iat = unix();
      const att = makeAttestation(cloudIssuer, { key: key ?? '', sub: account.sub, domain: account.domain, kind: 'account', iat, exp: iat + (account.lifetime ?? 86400) });
      return Response.json({ att, issuer: cloudIssuer.publicKey, sync: false });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, accounts };
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
  check('a name no account owns is refused, and list_agents gives the link to open', refused.text.includes('Not connected to the relay: this relay needs a parley account') && refused.text.includes('Ask your user to open this link') && refused.text.includes(`${stub.url}/link?`), refused);
  const out = cli(join(base, 'machine-m'), 'cloud', 'link', '--url', stub.url);
  check('parley cloud link prints a link for the name', out.includes(`${stub.url}/link?key=`), out);

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

try {
  console.log(`parley ${VERSION} on ${RUN[0]}`);
  sealing();
  const pair = await messaging();
  await forgery(pair);
  await names(pair);
  await olderContacts(pair);
  await olderNode();
  await accountRelays();
  await accounts();
} catch (err) {
  failures++;
  console.log('FAIL  the run stopped early ->', err instanceof Error ? err.stack : err);
} finally {
  for (const done of cleanup.reverse()) {
    try {
      await done();
    } catch {
      // already closed
    }
  }
  relay.stop(true);
}
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}   (state kept in ${base})`);
process.exit(failures ? 1 : 0);

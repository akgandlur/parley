import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { startAccount, type AccountState, type Verified } from './account';
import { readAttestation } from './attest';
import { addressOf, sealTo08, signText } from './crypto';
import { isSavedKey, loadConfig, loadContacts, loadIdentity, readJson, saveContact } from './home';
import { OPKS_LOW } from './mail';
import { OPKS_STOCK, Prekeys } from './prekeys';
import {
  answer,
  answerMail,
  canSeal,
  checkMailOffer,
  checkOffer,
  finish,
  offer,
  offerMail,
  open,
  safetyNumber,
  seal,
  type Bundle,
  type MailHello,
  type Ratchet,
} from './ratchet';
import { RELAY_AUTH } from './relay';
import { secretArrived, startRequests } from './secrets';
import { TEXT_MAX, VERSION } from './types';
import { parseRule, putSecret, type Rule } from './vault';

const RETRY_MAX_MS = 15_000;
const CONNECT_WAIT_MS = 15_000;
const PROBE_EVERY_MS = 20_000;
const PROBE_WAIT_MS = 10_000;
const ANSWER_MS = 15_000;
const PREKEYS_WAIT_MS = 5000;
const TOLD_AGAIN_MS = 10 * 60_000;
const LEFT_KEEP_MS = 7 * 24 * 3600_000;
const ROTATE_EVERY_MS = 3600_000;

export const HOW_TO_UPDATE =
  'To update parley, its user runs `claude plugin marketplace update parley && claude plugin update parley@parley` in a terminal, then /reload-plugins in Claude Code.';

export type Incoming = {
  id: string;
  // `first`: this id has not written before; `was`: an id that wrote under the same name.
  from: { name: string; address: string; verified?: Verified; own: boolean; net?: string; first: boolean; was?: string };
  text: string;
  at: string;
  urgent: boolean;
  waited?: boolean;
};

export type AgentState = {
  name: string;
  address: string;
  relay: { connected: boolean; error?: string };
  account: AccountState;
};

export type Outcome = 'delivered' | 'machine' | 'relay';
export type Sent = { name: string; outcome: Outcome };

class Offline extends Error {}
class Stale extends Error {}

type Hello = { key: string; e: string; sig: string };

type Conv = {
  ratchet?: Ratchet;
  key?: string;
  offered?: ReturnType<typeof offer>;
  mail?: MailHello;
  theirE?: string;
  ready: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
};

const explain = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A 0.5 node and a session replace each other's relay connection without end.
async function retireOldNode(home: string, log: (...parts: unknown[]) => void) {
  if (!existsSync(join(home, 'node.json'))) return;
  const info = readJson<{ port: number; token: string; pid: number }>(home, 'node.json');
  await new Promise<void>((resolve) => {
    const socket = connect(info.port, '127.0.0.1');
    socket.on('connect', () => socket.end(JSON.stringify({ token: info.token, op: 'stop', args: {} }) + '\n'));
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
    socket.setTimeout(3000, () => socket.destroy());
  });
  for (let i = 0; i < 30 && existsSync(join(home, 'node.json')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (existsSync(join(home, 'node.json'))) {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {}
    rmSync(join(home, 'node.json'), { force: true });
  }
  log(`stopped the older parley node (pid ${info.pid})`);
}

export async function startAgent(
  home: string,
  log: (...parts: unknown[]) => void,
  onMessage: (m: Incoming) => Promise<void | 'held'>,
  onNotice: (text: string) => void,
) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('parley needs Node 22 or newer (or Bun)');
  }
  const me = loadIdentity(home);
  // PARLEY_RELAY wins over the saved relay so a plugin update can move everyone.
  const relayUrl = process.env.PARLEY_RELAY ?? loadConfig(home).relay;
  const address = addressOf(me.publicKey);
  await retireOldNode(home, log);
  const prekeys = new Prekeys(home, me);

  let socket: WebSocket | undefined;
  let ready = false;
  let relayError: string | undefined = 'connecting';
  let refused = false;
  let closed = false;
  let retryMs = 2000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let socketSince = 0;
  let probe: { n: number; at: number } | undefined;
  let probes = 0;
  let lastProbe = 0;
  let firstAnswer = () => {};
  const answered = new Promise<void>((resolve) => (firstAnswer = resolve));
  const convs = new Map<string, Conv>();
  const acks = new Map<string, { to: string; body: Record<string, unknown>; resolve: (s: Sent) => void; reject: (e: Error) => void }>();
  const left = new Map<string, { to: string; at: number; told?: boolean }>();
  const bundles = new Map<string, { resolve: (b: Bundle | undefined) => void }>();
  const seen = new Set<string>();
  const told = new Map<string, number>();

  const account = startAccount(home, me, log, (att) => {
    if (socket && ready) socket.send(JSON.stringify({ t: 'renew', att }));
    else if (!socket && refused && !closed) {
      clearTimeout(retryTimer);
      connectRelay();
    }
  });

  function verify(att: unknown, key: string, who: string): Verified | undefined {
    if (typeof att !== 'string') return undefined;
    try {
      const a = readAttestation(att, account.issuers(), key);
      return { domain: a.domain, kind: a.kind, sub: a.sub, nets: a.nets ?? [] };
    } catch (err) {
      log(`the account proof from ${who} does not check out:`, explain(err));
      return undefined;
    }
  }

  function connectRelay() {
    const ws = new WebSocket(relayUrl);
    socket = ws;
    socketSince = Date.now();
    probe = undefined;
    ws.onmessage = (ev) => {
      if (socket !== ws) return;
      try {
        onRelay(JSON.parse(String(ev.data)));
      } catch (err) {
        log('could not handle a relay message:', explain(err));
      }
    };
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = undefined;
      ready = false;
      relayError = ev.reason || 'cannot reach it';
      refused = ev.code === 4003;
      firstAnswer();
      failAll(new Offline(`the relay connection closed: ${relayError}`));
      if (closed) return;
      log(`relay connection closed (${ev.code} ${ev.reason}); retrying`);
      if (refused) void account.check();
      retryTimer = setTimeout(connectRelay, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
    ws.onerror = () => {};
  }

  // A connection that died silently (sleep, a network change) can take minutes to report it.
  function replaceRelay(why: string) {
    const old = socket;
    socket = undefined;
    ready = false;
    relayError = why;
    log(`relay connection replaced: ${why}`);
    try {
      old?.close();
    } catch {}
    connectRelay();
  }

  const timer = setInterval(() => {
    if (!socket) return;
    const now = Date.now();
    if (!ready) {
      if (now - socketSince > CONNECT_WAIT_MS) replaceRelay('the relay did not answer');
    } else if (probe) {
      if (now - probe.at > PROBE_WAIT_MS) replaceRelay('the relay stopped answering');
    } else if (now - lastProbe >= PROBE_EVERY_MS) {
      probe = { n: ++probes, at: now };
      lastProbe = now;
      socket.send(JSON.stringify({ t: 'send', to: address, ref: `probe:${probe.n}`, payload: { probe: probe.n } }));
    }
  }, 250);

  const rotation = setInterval(() => {
    if (prekeys.rotate() && socket && ready) leaveKeys(0);
    const cutoff = Date.now() - LEFT_KEEP_MS;
    for (const [id, l] of left) if (l.at < cutoff) left.delete(id);
  }, ROTATE_EVERY_MS);

  function relaySend(to: string, ref: string, payload: object, hold = false) {
    if (!socket || !ready) throw new Offline(`not connected to the relay: ${relayError}`);
    const frame = JSON.stringify({ t: 'send', to, ref, payload, ...(hold ? { hold } : {}) });
    if (frame.length > 250_000) throw new Error('the message is too long for the relay');
    socket.send(frame);
  }

  function leaveKeys(more: number) {
    if (!socket || !ready) return;
    socket.send(JSON.stringify({ t: 'prekeys', ...prekeys.bundleToPut(more) }));
  }

  function newConv(): Conv {
    let resolve = () => {};
    let reject = (_: Error) => {};
    const ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    ready.catch(() => {});
    return { ready, resolve, reject };
  }

  function drop(from: string, err: Error) {
    const conv = convs.get(from);
    convs.delete(from);
    conv?.reject(err);
    for (const [id, wait] of acks) {
      if (wait.to !== from) continue;
      acks.delete(id);
      wait.reject(err);
    }
  }

  function failAll(err: Error) {
    for (const [id, wait] of acks) {
      acks.delete(id);
      wait.reject(err);
    }
    for (const [to, conv] of convs) {
      if (conv.ratchet && canSeal(conv.ratchet)) continue;
      convs.delete(to);
      conv.reject(err);
    }
    for (const [id, b] of bundles) {
      bundles.delete(id);
      b.resolve(undefined);
    }
  }

  function fetchBundle(id: string): Promise<Bundle | undefined> {
    return new Promise((resolve) => {
      bundles.get(id)?.resolve(undefined);
      bundles.set(id, { resolve });
      setTimeout(() => {
        if (bundles.get(id)?.resolve === resolve) {
          bundles.delete(id);
          resolve(undefined);
        }
      }, PREKEYS_WAIT_MS);
      try {
        socket!.send(JSON.stringify({ t: 'prekeys', id }));
      } catch (err) {
        bundles.delete(id);
        resolve(undefined);
      }
    });
  }

  const contactName = (id: string) => loadContacts()[id]?.name ?? id;

  function onRelay(msg: any) {
    if (msg.t === 'challenge') {
      socket?.send(
        JSON.stringify({
          t: 'hello',
          publicKey: me.publicKey,
          sig: signText(me, RELAY_AUTH + msg.nonce),
          att: account.att(),
        }),
      );
    } else if (msg.t === 'ready') {
      ready = true;
      relayError = undefined;
      refused = false;
      retryMs = 2000;
      firstAnswer();
      log('connected to the relay as', msg.address);
      leaveKeys(prekeys.onHand() ? 0 : OPKS_STOCK);
    } else if (msg.t === 'recv') {
      if (msg.from === address) {
        if (probe && msg.payload?.probe === probe.n) probe = undefined;
        return;
      }
      const from = String(msg.from);
      const done = onPeer(from, msg.payload, msg.held !== undefined).catch((err) => {
        log(`could not handle what ${from} sent:`, explain(err));
        return false;
      });
      if (msg.held && Number.isInteger(msg.held.seq)) {
        const seq = msg.held.seq as number;
        void done.then((consumed) => {
          if (consumed) socket?.send(JSON.stringify({ t: 'took', seq }));
        });
      }
    } else if (msg.t === 'undeliverable') {
      const ref = String(msg.ref ?? '');
      if (ref.startsWith('probe:')) return replaceRelay('the relay no longer knows this connection');
      if (ref.startsWith('hs:')) return void offline(String(msg.to));
      if (ref.startsWith('hs-live:')) return drop(String(msg.to), new Offline('not online'));
      if (ref.startsWith('msg:')) drop(String(msg.to), new Offline(msg.why === 'full' ? 'mail full' : 'not online'));
    } else if (msg.t === 'held') {
      const ref = String(msg.ref ?? '');
      if (!ref.startsWith('msg:')) return;
      const id = ref.slice(4);
      const wait = acks.get(id);
      if (!wait || wait.to !== msg.to) return;
      acks.delete(id);
      left.set(id, { to: wait.to, at: Date.now() });
      wait.resolve({ name: contactName(wait.to), outcome: 'relay' });
      // They may not have this conversation when back: again, with a handshake from their prekeys.
      if (convs.get(wait.to)?.mail === undefined) void remail(wait.to, wait.body, id);
    } else if (msg.t === 'prekeys') {
      if (typeof msg.id === 'string') {
        const waiting = bundles.get(msg.id);
        bundles.delete(msg.id);
        if (typeof msg.error === 'string') log(`the relay gave no prekeys for ${msg.id}:`, msg.error);
        waiting?.resolve(typeof msg.key === 'string' && msg.spk ? { key: msg.key, spk: msg.spk, ...(typeof msg.opk === 'string' ? { opk: msg.opk } : {}) } : undefined);
      } else if (typeof msg.error === 'string') {
        log('the relay did not take the prekeys:', msg.error);
      } else if (Number.isInteger(msg.left) && msg.left < OPKS_LOW) {
        leaveKeys(OPKS_STOCK - msg.left);
      }
    }
  }

  async function remail(to: string, body: Record<string, unknown>, id: string) {
    convs.delete(to);
    try {
      const conv = await converse(to);
      if (conv.mail) relaySend(to, `msg:${id}`, sealed(conv, body, id).payload, true);
    } catch (err) {
      log(`could not leave the message for ${to} with a handshake:`, explain(err));
    }
  }

  async function offline(to: string) {
    const conv = convs.get(to);
    if (!conv?.offered) return;
    const bundle = await fetchBundle(to);
    if (convs.get(to) !== conv || !conv.offered) return;
    if (!bundle) return drop(to, new Offline('not online'));
    if (!knownKey(to, bundle.key)) return drop(to, new Error(`${to} left a different key at the relay than this machine knew for it, so nothing was sent`));
    try {
      const made = offerMail(me, to, bundle);
      conv.offered = undefined;
      conv.ratchet = made.ratchet;
      conv.key = bundle.key;
      conv.mail = made.hello;
      conv.resolve();
    } catch (err) {
      drop(to, err instanceof Error ? err : new Error(String(err)));
    }
  }

  function knownKey(from: string, key: unknown): key is string {
    if (typeof key !== 'string' || addressOf(key) !== from) return false;
    if (isSavedKey(from, key)) return true;
    log(`${from} showed a different key than this id had before, so it is not answered`);
    return false;
  }

  // A 0.8 session reads only its own format.
  function otherVersion(from: string, p: any) {
    if (!Number.isInteger(p?.v) || p.speaks === 3) return;
    if (p.v < 3 && (typeof p.key !== 'string' || addressOf(p.key) !== from)) return;
    const asked = convs.get(from)?.offered !== undefined;
    if (asked && p.v < 3) drop(from, new Error(`${from} is on a parley older than 0.9, which this one cannot talk with. It has been sent a note saying it has to update`));
    if (Date.now() - (told.get(from) ?? 0) < TOLD_AGAIN_MS) return;
    told.set(from, Date.now());
    if (p.v > 3) {
      return onNotice(`parley: ${from} tried to reach this session from a newer parley than this one (${VERSION}), and the two cannot talk. ${HOW_TO_UPDATE}`);
    }
    if (!asked) {
      onNotice(`parley: ${from} tried to reach this session, but it is on a parley older than 0.9, which this one cannot talk with. Nothing it sent arrived. It has been sent a note saying it has to update.`);
    }
    const id = randomBytes(9).toString('base64url');
    const text = `This is an automatic note from parley, not from the session itself. This session is on parley ${VERSION}, and yours is older than 0.9: the two cannot talk, so nothing you send here arrives. ${HOW_TO_UPDATE} From 0.9 on, each machine is linked once to a parley account.`;
    const { eph, box } = sealTo08(p.key, JSON.stringify({ id, name: me.name, text, at: new Date().toISOString(), att: account.att() }));
    relaySend(from, `note:${id}`, { v: 2, kind: 'msg', key: me.publicKey, eph, box, sig: signText(me, `parley message\n${from}\n${eph}\n${box}`) });
  }

  function fromMail(from: string, p: MailHello & { h: unknown; c: string }): Conv | undefined {
    const conv = convs.get(from);
    if (conv?.theirE === p.e && conv.ratchet) return conv;
    if (!knownKey(from, p.key) || !checkMailOffer(p, address)) return undefined;
    const spk = prekeys.signedPrekey(p.spk);
    const opk = p.opk ? prekeys.oneTime(p.opk) : undefined;
    if (!spk || (p.opk && !opk)) {
      log(`${from} sealed to prekeys this name no longer has`);
      return undefined;
    }
    const next = newConv();
    next.ratchet = answerMail(me, p, spk, opk);
    next.key = p.key;
    next.theirE = p.e;
    if (conv) drop(from, new Stale('the other side started the conversation again'));
    convs.set(from, next);
    if (p.opk) prekeys.dropOneTime(p.opk);
    return next;
  }

  // Returns whether a held frame was consumed, so the relay keeps a frame
  // this process could not open yet for a later connection.
  async function onPeer(from: string, p: any, waited: boolean): Promise<boolean> {
    if (p?.v !== 3) {
      otherVersion(from, p);
      return true;
    }
    const conv = convs.get(from);
    if (p.kind === 'hs1') {
      if (!knownKey(from, p.key) || !checkOffer(p as Hello, address)) return true;
      // Both offered at once: the lower id's handshake wins.
      if (conv?.offered && address < from) return true;
      const made = answer(me, from, p as Hello);
      const next = conv?.offered ? conv : newConv();
      if (conv && next !== conv) drop(from, new Stale('the other side started the conversation again'));
      next.offered = undefined;
      next.ratchet = made.ratchet;
      next.key = p.key;
      convs.set(from, next);
      relaySend(from, 'hs2', { v: 3, kind: 'hs2', ...made.reply });
    } else if (p.kind === 'hs2') {
      if (!conv?.offered || !knownKey(from, p.key)) return true;
      try {
        conv.ratchet = finish(conv.offered.hello, conv.offered.pair, address, p as Hello);
      } catch (err) {
        drop(from, err instanceof Error ? err : new Error(String(err)));
        return true;
      }
      conv.key = p.key;
      conv.offered = undefined;
      conv.resolve();
    } else if (p.kind === 'reset') {
      if (conv) drop(from, new Stale('the other side lost the conversation'));
    } else if (p.kind === 'm' || p.kind === 'hsm') {
      const c = p.kind === 'hsm' ? fromMail(from, p) : conv;
      if (!c?.ratchet || !c.key) {
        // Stale mail from a conversation this process never had is kept, not
        // reset: a live message instead means the conversation is gone.
        if (!waited) relaySend(from, 'reset', { v: 3, kind: 'reset' });
        return false;
      }
      let inner: any;
      try {
        inner = JSON.parse(open(c.ratchet, p));
      } catch (err) {
        log(`a message from ${from} was dropped:`, explain(err));
        return false;
      }
      c.mail = undefined;
      c.resolve();
      if (inner.t === 'ack') {
        const id = String(inner.id);
        const wait = acks.get(id);
        saveContact(from, String(inner.name), c.key);
        if (wait && wait.to === from) {
          acks.delete(id);
          if (inner.error) wait.reject(new Error(`${from} did not take it: ${String(inner.error).slice(0, 500)}`));
          else if (inner.held === true) {
            left.set(id, { to: from, at: Date.now(), told: true });
            wait.resolve({ name: String(inner.name), outcome: 'machine' });
          } else wait.resolve({ name: String(inner.name), outcome: 'delivered' });
        } else if (left.get(id)?.to === from && !inner.error) {
          const l = left.get(id)!;
          if (inner.held === true) {
            if (!l.told) onNotice(`parley: the message you left for "${inner.name}" (${from}) at ${new Date(l.at).toISOString()} has reached its machine, and waits there for a session to open.`);
            l.told = true;
          } else {
            left.delete(id);
            onNotice(`parley: "${inner.name}" (${from}) now has the message you left for it at ${new Date(l.at).toISOString()}.`);
          }
        }
      } else if (inner.t === 'read') {
        const id = String(inner.id);
        const l = left.get(id);
        if (l?.to !== from) return true;
        left.delete(id);
        onNotice(`parley: "${String(inner.name)}" (${from}) has read the message you left for it at ${new Date(l.at).toISOString()}.`);
      } else if (inner.t === 'secret') {
        const id = String(inner.id);
        const who = `"${String(inner.name)}" (${from})`;
        let error: string | undefined;
        if (!seen.has(id)) {
          seen.add(id);
          saveContact(from, String(inner.name), c.key);
          try {
            const use = (Array.isArray(inner.use) ? inner.use : []).map((r: any) => parseRule(('run' in r ? ['run', String(r.run), ...r.args.map(String)] : ['http', String(r.http)])));
            putSecret(String(inner.label), String(inner.value), who, use);
            onNotice(secretArrived(String(inner.label), `${who} sent it`, use));
          } catch (err) {
            error = explain(err);
          }
        }
        relaySend(from, `ack:${id}`, { v: 3, kind: 'm', ...seal(c.ratchet, JSON.stringify({ t: 'ack', id, name: me.name, error })) }, true);
      } else if (inner.t === 'msg') {
        await receive(from, c, inner, waited);
      }
    }
    return true;
  }

  async function receive(from: string, conv: Conv, inner: any, waited: boolean) {
    const key = conv.key as string;
    const id = String(inner.id);
    const name = String(inner.name);
    let held = false;
    if (!seen.has(id)) {
      seen.add(id);
      const verified = verify(inner.att, key, from);
      const mine = account.state().verified;
      const own = !!verified && verified.kind === 'account' && mine?.kind === 'account' && verified.sub === mine.sub;
      const net = verified && mine ? verified.nets.find((n) => mine.nets.includes(n)) : undefined;
      const known = loadContacts();
      const first = !known[from];
      const was = first ? Object.keys(known).find((k) => known[k]!.name === name) : undefined;
      saveContact(from, name, key);
      const m: Incoming = { id, from: { name, address: from, verified, own, net, first, was }, text: String(inner.text), at: String(inner.at), urgent: inner.urgent === true };
      if (waited) m.waited = true;
      held = (await onMessage(m)) === 'held';
    }
    if (convs.get(from) !== conv || !conv.ratchet) return;
    relaySend(from, `ack:${id}`, { v: 3, kind: 'm', ...seal(conv.ratchet, JSON.stringify({ t: 'ack', id, name: me.name, ...(held ? { held } : {}) })) }, true);
  }

  async function converse(to: string, mail = true): Promise<Conv> {
    let conv = convs.get(to);
    if (!conv) {
      conv = newConv();
      conv.offered = offer(me, to);
      convs.set(to, conv);
      const mine = conv;
      try {
        relaySend(to, mail ? `hs:${to}` : `hs-live:${to}`, { v: 3, kind: 'hs1', ...conv.offered.hello });
        // Only a session older than 0.9 answers this.
        relaySend(to, 'older?', { v: 2, kind: 'key?', key: me.publicKey, speaks: 3 });
      } catch (err) {
        convs.delete(to);
        throw err;
      }
      setTimeout(() => {
        if (convs.get(to) === mine && !(mine.ratchet && canSeal(mine.ratchet))) {
          drop(to, new Error(`${to} did not answer. It may be on a parley older than 0.9`));
        }
      }, ANSWER_MS);
    }
    await conv.ready;
    return conv;
  }

  function sealed(conv: Conv, body: Record<string, unknown>, id = randomBytes(9).toString('base64url')): { id: string; payload: object } {
    const box = seal(conv.ratchet as Ratchet, JSON.stringify({ ...body, id, name: me.name, at: new Date().toISOString(), att: account.att() }));
    return { id, payload: conv.mail ? { v: 3, kind: 'hsm', ...conv.mail, ...box } : { v: 3, kind: 'm', ...box } };
  }

  async function sendOnce(to: string, body: Record<string, unknown>): Promise<Sent> {
    const conv = await converse(to);
    const { id, payload } = sealed(conv, body);
    return new Promise<Sent>((resolve, reject) => {
      acks.set(id, { to, body, resolve, reject });
      setTimeout(() => {
        if (acks.delete(id)) reject(new Error(body.t === 'secret' ? `${to} did not confirm it got the secret. It may be on a parley older than 0.10, which cannot take one` : `${to} did not confirm it got the message`));
      }, ANSWER_MS);
      try {
        relaySend(to, `msg:${id}`, payload, true);
      } catch (err) {
        acks.delete(id);
        reject(err);
      }
    });
  }

  async function deliver(to: string, body: Record<string, unknown>): Promise<Sent> {
    try {
      return await sendOnce(to, body).catch((err) => {
        if (err instanceof Stale) return sendOnce(to, body);
        throw err;
      });
    } catch (err) {
      if (err instanceof Offline && err.message === 'not online') {
        throw new Error(`${to} is not online, and has no mail at the relay to leave the message in: no session with that parley name is open right now, and its parley is older than 0.12 or has not been online since updating`);
      }
      if (err instanceof Offline && err.message === 'mail full') {
        throw new Error(`${to} is not online, and its mail at the relay is full, so the message could not be left`);
      }
      throw err;
    }
  }

  const secrets = startRequests(home, me, () => account.state().url, log, onNotice);

  connectRelay();
  await Promise.race([answered, new Promise((r) => setTimeout(r, 5000))]);

  return {
    address,
    name: me.name,
    account,
    state: (): AgentState => ({
      name: me.name,
      address,
      relay: { connected: ready, error: ready ? undefined : relayError },
      account: account.state(),
    }),
    async send(to: string, text: string, urgent = false): Promise<Sent> {
      if (text.length > TEXT_MAX) throw new Error(`a message is at most ${TEXT_MAX} characters`);
      if (to === address) throw new Error("that is this session's own id");
      return deliver(to, { t: 'msg', text, urgent: urgent || undefined });
    },
    sendSecret(to: string, label: string, value: string, use: Rule[]): Promise<Sent> {
      if (to === address) throw new Error("that is this session's own id");
      return deliver(to, { t: 'secret', label, value, use });
    },
    // Live only: a read receipt is not worth one of their one-time keys.
    async read(to: string, id: string) {
      try {
        const conv = await converse(to, false);
        relaySend(to, `read:${id}`, sealed(conv, { t: 'read' }, id).payload, true);
      } catch (err) {
        log(`could not tell ${to} its message was read:`, explain(err));
      }
    },
    secrets,
    safetyNumber(to: string): string {
      const theirs = loadContacts()[to]?.key;
      if (!theirs) throw new Error(`no message has been exchanged with ${to} yet, so there is no key of theirs to compare`);
      return safetyNumber(me.publicKey, theirs);
    },
    close() {
      closed = true;
      clearInterval(timer);
      clearInterval(rotation);
      socket?.close();
      socket = undefined;
    },
  };
}

export type Agent = Awaited<ReturnType<typeof startAgent>>;

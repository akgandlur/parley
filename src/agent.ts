import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { startAccount, type AccountState, type Verified } from './account';
import { readAttestation } from './attest';
import { addressOf, sealTo08, signText } from './crypto';
import { isSavedKey, loadConfig, loadContacts, loadIdentity, readJson, saveContact } from './home';
import { answer, canSeal, checkOffer, finish, offer, open, safetyNumber, seal, type Ratchet } from './ratchet';
import { RELAY_AUTH } from './relay';
import { TEXT_MAX, VERSION } from './types';

const RETRY_MAX_MS = 15_000;
const CONNECT_WAIT_MS = 15_000;
const PROBE_EVERY_MS = 20_000;
const PROBE_WAIT_MS = 10_000;
const ANSWER_MS = 15_000;
const TOLD_AGAIN_MS = 10 * 60_000;

export const HOW_TO_UPDATE =
  'To update parley, its user runs `claude plugin marketplace update parley && claude plugin update parley@parley` in a terminal, then /reload-plugins in Claude Code.';

export type Incoming = {
  id: string;
  // `own`: on the same parley account as this session. `first`: this id has
  // not written before; `was` is an id that wrote under the same name.
  from: { name: string; address: string; verified?: Verified; own: boolean; first: boolean; was?: string };
  text: string;
  at: string;
  urgent: boolean;
};

export type AgentState = {
  name: string;
  address: string;
  relay: { connected: boolean; error?: string };
  account: AccountState;
};

class Offline extends Error {}
// The other side no longer has this conversation's keys; a new handshake fixes it.
class Stale extends Error {}

type Hello = { key: string; e: string; sig: string };

// One conversation with one other session. `ready` settles once this side can seal.
type Conv = {
  ratchet?: Ratchet;
  key?: string;
  offered?: ReturnType<typeof offer>;
  ready: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
};

const explain = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A 0.5 node runs in the background and holds the name's relay connection.
// Two connections for one id replace each other without end, so it goes.
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
  onMessage: (m: Incoming) => Promise<void>,
  onNotice: (text: string) => void,
) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('parley needs Node 22 or newer (or Bun)');
  }
  const me = loadIdentity(home);
  // The plugin sets PARLEY_RELAY, and it wins over the saved address so a
  // plugin update can move everyone to a new relay.
  const relayUrl = process.env.PARLEY_RELAY ?? loadConfig(home).relay;
  const address = addressOf(me.publicKey);
  await retireOldNode(home, log);

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
  const acks = new Map<string, { to: string; resolve: (name: string) => void; reject: (e: Error) => void }>();
  const seen = new Set<string>();
  const told = new Map<string, number>();

  const account = startAccount(home, me, log, (att) => {
    if (socket && ready) socket.send(JSON.stringify({ t: 'renew', att }));
    else if (!socket && refused && !closed) {
      clearTimeout(retryTimer);
      connectRelay();
    }
  });

  // A proof this side cannot check (no issuer of its own, or a bad one) is
  // shown as no proof at all.
  function verify(att: unknown, key: string, who: string): Verified | undefined {
    if (typeof att !== 'string') return undefined;
    try {
      const a = readAttestation(att, account.issuers(), key);
      return { domain: a.domain, kind: a.kind, sub: a.sub };
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

  // A connection that died without a close (sleep, a network change) can
  // take minutes to report it, so it is dropped here and replaced at once.
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

  function relaySend(to: string, ref: string, payload: object) {
    if (!socket || !ready) throw new Offline(`not connected to the relay: ${relayError}`);
    const frame = JSON.stringify({ t: 'send', to, ref, payload });
    if (frame.length > 250_000) throw new Error('the message is too long for the relay');
    socket.send(frame);
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

  // Conversations outlive a reconnect: their keys are in memory on both
  // sides. Only what was waiting on an answer fails.
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
  }

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
    } else if (msg.t === 'recv') {
      if (msg.from === address) {
        if (probe && msg.payload?.probe === probe.n) probe = undefined;
        return;
      }
      onPeer(String(msg.from), msg.payload);
    } else if (msg.t === 'undeliverable') {
      const ref = String(msg.ref ?? '');
      if (ref.startsWith('probe:')) return replaceRelay('the relay no longer knows this connection');
      if (ref.startsWith('hs:') || ref.startsWith('msg:')) drop(String(msg.to), new Offline('not online'));
    }
  }

  // The key a side shows has to be the one its id stands for, and the one
  // this machine heard from that id before.
  function knownKey(from: string, key: unknown): key is string {
    if (typeof key !== 'string' || addressOf(key) !== from) return false;
    if (isSavedKey(from, key)) return true;
    log(`${from} showed a different key than this id had before, so it is not answered`);
    return false;
  }

  // A session on another version of parley cannot read this one's messages,
  // nor this one its. Each side is told which of the two has to update. A 0.8
  // session reads only its own format, so the note to it is written in that.
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

  function onPeer(from: string, p: any) {
    if (p?.v !== 3) return otherVersion(from, p);
    const conv = convs.get(from);
    if (p.kind === 'hs1') {
      if (!knownKey(from, p.key) || !checkOffer(p as Hello, address)) return;
      // Both sides started at once: the lower id's handshake is the one kept.
      if (conv?.offered && address < from) return;
      const made = answer(me, from, p as Hello);
      const next = conv?.offered ? conv : newConv();
      if (conv && next !== conv) drop(from, new Stale('the other side started the conversation again'));
      next.offered = undefined;
      next.ratchet = made.ratchet;
      next.key = p.key;
      convs.set(from, next);
      relaySend(from, 'hs2', { v: 3, kind: 'hs2', ...made.reply });
    } else if (p.kind === 'hs2') {
      if (!conv?.offered || !knownKey(from, p.key)) return;
      try {
        conv.ratchet = finish(conv.offered.hello, conv.offered.pair, address, p as Hello);
      } catch (err) {
        return drop(from, err instanceof Error ? err : new Error(String(err)));
      }
      conv.key = p.key;
      conv.offered = undefined;
      conv.resolve();
    } else if (p.kind === 'reset') {
      if (conv) drop(from, new Stale('the other side lost the conversation'));
    } else if (p.kind === 'm') {
      if (!conv?.ratchet || !conv.key) return relaySend(from, 'reset', { v: 3, kind: 'reset' });
      let inner: any;
      try {
        inner = JSON.parse(open(conv.ratchet, p));
      } catch (err) {
        return log(`a message from ${from} was dropped:`, explain(err));
      }
      conv.resolve();
      if (inner.t === 'ack') {
        const wait = acks.get(String(inner.id));
        if (!wait || wait.to !== from) return;
        acks.delete(String(inner.id));
        saveContact(from, String(inner.name), conv.key);
        wait.resolve(String(inner.name));
      } else if (inner.t === 'msg') {
        void receive(from, conv, inner).catch((err) => log(`a message from ${from} was dropped:`, explain(err)));
      }
    }
  }

  async function receive(from: string, conv: Conv, inner: any) {
    const key = conv.key as string;
    const id = String(inner.id);
    const name = String(inner.name);
    if (!seen.has(id)) {
      seen.add(id);
      const verified = verify(inner.att, key, from);
      const mine = account.state().verified;
      const own = !!verified && verified.kind === 'account' && mine?.kind === 'account' && verified.sub === mine.sub;
      const known = loadContacts();
      const first = !known[from];
      const was = first ? Object.keys(known).find((k) => known[k]!.name === name) : undefined;
      saveContact(from, name, key);
      await onMessage({ id, from: { name, address: from, verified, own, first, was }, text: String(inner.text), at: String(inner.at), urgent: inner.urgent === true });
    }
    if (convs.get(from) !== conv || !conv.ratchet) return;
    relaySend(from, `ack:${id}`, { v: 3, kind: 'm', ...seal(conv.ratchet, JSON.stringify({ t: 'ack', id, name: me.name })) });
  }

  // The conversation with `to`, ready to seal. Starts one if there is none.
  async function converse(to: string): Promise<Conv> {
    let conv = convs.get(to);
    if (!conv) {
      conv = newConv();
      conv.offered = offer(me, to);
      convs.set(to, conv);
      const mine = conv;
      try {
        relaySend(to, `hs:${to}`, { v: 3, kind: 'hs1', ...conv.offered.hello });
        // Only a session older than 0.9 answers this, which is how it is known to be one.
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

  async function sendOnce(to: string, text: string, urgent: boolean): Promise<string> {
    const conv = await converse(to);
    const id = randomBytes(9).toString('base64url');
    const sealed = seal(conv.ratchet as Ratchet, JSON.stringify({ t: 'msg', id, name: me.name, text, at: new Date().toISOString(), att: account.att(), urgent: urgent || undefined }));
    return new Promise<string>((resolve, reject) => {
      acks.set(id, { to, resolve, reject });
      setTimeout(() => {
        if (acks.delete(id)) reject(new Error(`${to} did not confirm it got the message`));
      }, ANSWER_MS);
      try {
        relaySend(to, `msg:${id}`, { v: 3, kind: 'm', ...sealed });
      } catch (err) {
        acks.delete(id);
        reject(err);
      }
    });
  }

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
    // Resolves with the name the other side answered under, once it has the message.
    async send(to: string, text: string, urgent = false): Promise<string> {
      if (text.length > TEXT_MAX) throw new Error(`a message is at most ${TEXT_MAX} characters`);
      if (to === address) throw new Error("that is this session's own id");
      try {
        return await sendOnce(to, text, urgent).catch((err) => {
          if (err instanceof Stale) return sendOnce(to, text, urgent);
          throw err;
        });
      } catch (err) {
        if (err instanceof Offline && err.message === 'not online') {
          throw new Error(`${to} is not online: no Claude Code session with that parley name is open right now`);
        }
        throw err;
      }
    },
    // Needs the other side's key, which is saved once a message has been exchanged.
    safetyNumber(to: string): string {
      const theirs = loadContacts()[to]?.key;
      if (!theirs) throw new Error(`no message has been exchanged with ${to} yet, so there is no key of theirs to compare`);
      return safetyNumber(me.publicKey, theirs);
    },
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      socket?.close();
      socket = undefined;
    },
  };
}

export type Agent = Awaited<ReturnType<typeof startAgent>>;

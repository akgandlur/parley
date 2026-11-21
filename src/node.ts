import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import VIEWER from './viewer.html' with { type: 'text' };
import {
  addressOf,
  deriveSessionKeys,
  newEphemeral,
  normalizeAddress,
  open,
  seal,
  signText,
  verifyText,
  type Ephemeral,
  type Role,
  type SessionKeys,
} from './crypto';
import {
  holder,
  isSavedKey,
  loadConfig,
  loadContacts,
  loadIdentity,
  saveContact,
  writeJson,
  type Config,
} from './home';
import { startCloud } from './cloud';
import { request } from './ipc';
import { openInBrowser } from './open';
import { renderMinutes } from './render';
import { RELAY_AUTH } from './relay';
import {
  ArgSchemas,
  ControlSchema,
  EntrySchema,
  LIMITS,
  VERSION,
  type Control,
  type Entry,
  type EntryBody,
  type Ev,
  type EvBody,
  type FeedEntry,
  type SessionState,
  type View,
  type WaitResult,
  type Who,
} from './types';

const RING_MS = 5 * 60_000;
const HANDSHAKE_MS = 30_000;
const HANGUP_WAIT_MS = 30_000;
const GAP_WAIT_MS = 60_000;
const RESEND_MS = 3_000;
const RESEND_TRIES = 20;
const INBOX_MAX = 100;
const RETRY_MAX_MS = 15_000;
const CONNECT_WAIT_MS = 15_000;
const QUIET_SHOWN = 3;
const QUIET_ENDS = 6;
const ALIVE_MISSES = 3;

const LETTERS = 'abcdefgh';

// Sides are named by letter: a is the caller, then b, c... in the order
// called. An author's letter prefixes its item ids and proposal refs.
type Proposal = { ref: string; by: string; text: string; agreedBy: Set<string> };

type Item = {
  id: string;
  title: string;
  addedBy: string | 'call';
  state: 'open' | 'agreed' | 'dropped';
  proposals: Map<string, Proposal>;
  latest: Map<string, Proposal>;
  agreed?: Proposal;
  dropReason?: string;
};

type Side = {
  id: string;
  address: string;
  publicKey?: string;
  name?: string;
  knownSince?: string;
  savedAs?: string;
  // The seq of this author's next entry. Every entry an author sends goes
  // to the caller, so a forwarded run has no gaps a hub could hide.
  nextSeq: number;
};

// One encrypted pairwise channel. A called side has one, to the caller; the
// caller has one per called side. Frame seqs are per leg, entry seqs per author.
type Leg = {
  side: Side;
  eph: Ephemeral;
  keys?: SessionKeys;
  group?: boolean;
  sendSeq: number;
  recvSeq: number;
  inbox: Map<number, string>;
  gapSince?: number;
  sent: Map<number, { payload: object; tries: number; at: number }>;
  // Set once the side has sent one valid alive. A 0.2.0 node never does,
  // and must not be ended for staying silent.
  speaksAlive?: boolean;
  lastHeard: number;
  aliveMisses: number;
};

type Session = {
  id: string;
  dir: string;
  role: Role;
  state: SessionState;
  group: boolean;
  self: string;
  sides: Side[];
  legs: Leg[];
  seq: number;
  accepted: Set<string>;
  left: Map<string, string>;
  confirmed: Set<string>;
  title: string;
  items: Item[];
  createdAt: number;
  activeSince?: number;
  lastActivity: number;
  closingSince?: number;
  entries: number;
  hungUp: Partial<Record<Who, string>>;
  endReason?: string;
  endedAt?: number;
  dialog?: ChildProcess;
  answerIn?: Config['approval'];
};

class ProtocolError extends Error {}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ProtocolError(message);
}

// apply() can end a session under a caller that has already narrowed
// s.state, so those callers re-read it through here.
const hasEnded = (s: { state: SessionState }) => s.state === 'ended';

function explain(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

const log = (...parts: unknown[]) =>
  console.log(new Date().toISOString(), ...parts);

const newItem = (id: string, title: string, addedBy: Item['addedBy']): Item => ({
  id,
  title,
  addedBy,
  state: 'open',
  proposals: new Map(),
  latest: new Map(),
});

const peerOf = (s: Session): Side => {
  const [first] = s.sides;
  if (!first) throw new Error('the session has no other side');
  return first;
};

const everyone = (s: Session) => [s.self, ...s.sides.map((x) => x.id)];
const present = (s: Session) => everyone(s).filter((id) => !s.left.has(id));
const liveLegs = (s: Session) => s.legs.filter((l) => l.keys && !s.left.has(l.side.id));

const fullyAgreed = (s: Session, p: Proposal) =>
  present(s).every((id) => id === p.by || p.agreedBy.has(id));

export async function runNode(home: string) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('parley needs Node 22 or newer (or Bun)');
  }
  const me = loadIdentity(home);
  const config = loadConfig(home);
  // The plugin sets PARLEY_RELAY, and it wins over the saved address so a
  // plugin update can move everyone to a new relay.
  const relayUrl = process.env.PARLEY_RELAY ?? config.relay;
  const address = addressOf(me.publicKey);
  const token = randomBytes(24).toString('base64url');
  const events: Ev[] = [];
  const feed: FeedEntry[] = [];
  const viewToken = randomBytes(18).toString('base64url');
  let feedCounter = 0;
  let viewerUrl = '';
  const waiters = new Set<() => void>();
  const outbox: string[] = [];
  let counter = 0;
  let current: Session | undefined;
  let socket: WebSocket | undefined;
  let relayReady = false;
  let relayError: string | undefined;
  let retryMs = 2000;
  let socketSince = 0;
  let probe: { n: number; at: number } | undefined;
  let probeCounter = 0;
  let lastProbe = 0;
  const aliveMs = (config.limits.aliveSeconds ?? 10) * 1000;
  const probeEveryMs = 2 * aliveMs;
  const probeWaitMs = aliveMs;
  let relayAnswered = () => {};
  const relayFirstAnswer = new Promise<void>((resolve) => (relayAnswered = resolve));

  try {
    await request('ping', {}, { home, start: false, timeoutMs: 2000 });
    throw new Error(`a parley node is already running for "${me.name}" (${home})`);
  } catch (err) {
    if (explain(err).includes('already running')) throw err;
  }

  const cloud = startCloud(home, me, log, () => {
    const s = current;
    return (
      s && {
        id: s.id,
        dir: s.dir,
        role: s.role,
        state: s.state,
        peer: { address: peerOf(s).address, name: peerOf(s).name },
        title: s.title,
        endedReason: s.state === 'ended' ? s.endReason : undefined,
      }
    );
  });

  function emit(ev: EvBody) {
    cloud.touch();
    events.push({ ...ev, n: ++counter } as Ev);
    for (const wake of [...waiters]) wake();
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
      relayReady = false;
      relayError = ev.reason || 'cannot reach it';
      relayAnswered();
      log(`relay connection closed (${ev.code} ${ev.reason}); retrying`);
      setTimeout(connectRelay, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
    ws.onerror = () => {};
  }

  // A connection that died without a close (sleep, a network change) can
  // take minutes to report it, so it is dropped here and replaced at once.
  function replaceRelay(why: string) {
    const old = socket;
    socket = undefined;
    relayReady = false;
    relayError = why;
    log(`relay connection replaced: ${why}`);
    try {
      old?.close();
    } catch {}
    connectRelay();
  }

  setInterval(() => {
    if (!socket) return;
    const now = Date.now();
    if (!relayReady) {
      if (now - socketSince > CONNECT_WAIT_MS) replaceRelay('the relay did not answer');
    } else if (probe) {
      if (now - probe.at > probeWaitMs) replaceRelay('the relay stopped answering');
    } else if (now - lastProbe >= probeEveryMs) {
      probe = { n: ++probeCounter, at: now };
      lastProbe = now;
      socket.send(
        JSON.stringify({
          t: 'send',
          to: address,
          ref: `probe:${probe.n}`,
          payload: { probe: probe.n },
        }),
      );
    }
  }, 250);

  function onRelay(msg: any) {
    if (msg.t === 'challenge') {
      socket?.send(
        JSON.stringify({
          t: 'hello',
          publicKey: me.publicKey,
          sig: signText(me, RELAY_AUTH + msg.nonce),
        }),
      );
    } else if (msg.t === 'ready') {
      relayReady = true;
      relayError = undefined;
      if (current && current.state !== 'ended') {
        for (const leg of current.legs) leg.lastHeard = Date.now();
      }
      retryMs = 2000;
      relayAnswered();
      log('connected to the relay as', msg.address);
      for (const queued of outbox.splice(0)) socket?.send(queued);
    } else if (msg.t === 'recv') {
      if (msg.from === address) {
        if (probe && msg.payload?.probe === probe.n) probe = undefined;
        return;
      }
      onPeer(msg.from, msg.payload);
    } else if (msg.t === 'undeliverable') {
      if (typeof msg.ref === 'string' && msg.ref.startsWith('probe:')) {
        return replaceRelay('the relay no longer knows this connection');
      }
      onUndeliverable(msg.ref, msg.to);
    }
  }

  function relaySend(to: string, payload: object, ref: string) {
    const msg = JSON.stringify({ t: 'send', to, ref, payload });
    if (relayReady && socket) socket.send(msg);
    else outbox.push(msg);
  }

  function sendControl(
    to: string,
    kind: Control['kind'],
    session: string,
    eph?: string,
    group?: boolean,
  ) {
    const signed = JSON.stringify({
      kind,
      session,
      to,
      at: new Date().toISOString(),
      eph,
      group: group ? 1 : undefined,
    });
    relaySend(
      to,
      { signed, sig: signText(me, signed), key: me.publicKey },
      `${kind}:${session}`,
    );
  }

  function onUndeliverable(ref: unknown, to: unknown) {
    const s = current;
    if (!s || s.state === 'ended' || typeof ref !== 'string') return;
    const leg = s.legs.find((l) => l.side.address === to);
    if (!leg || s.left.has(leg.side.id)) return;
    if (ref === `ring:${s.id}`) {
      if (s.state === 'dialing') dropAtDial(s, leg, 'not online', 'the other side is not online');
      return;
    }
    if (ref === `alive:${s.id}`) {
      if (leg.speaksAlive && ++leg.aliveMisses >= ALIVE_MISSES) lose(s, leg, 'went offline');
      return;
    }
    const [id, seq] = ref.split(':');
    const frame = id === s.id ? leg.sent.get(Number(seq)) : undefined;
    if (!frame) return;
    if (++frame.tries > RESEND_TRIES) return lose(s, leg, 'went offline');
    setTimeout(() => {
      if (current === s && s.state !== 'ended' && leg.sent.get(Number(seq)) === frame) {
        frame.at = Date.now();
        relaySend(leg.side.address, frame.payload, ref);
      }
    }, RESEND_MS);
  }

  // Carried with no `signed` and no top-level `session`: a 0.2.0 node fails
  // the session on an unknown signed kind, but drops this shape unread.
  function sendAlive(s: Session, leg: Leg) {
    const alive = JSON.stringify({ session: s.id, have: leg.recvSeq, at: new Date().toISOString() });
    socket?.send(
      JSON.stringify({
        t: 'send',
        to: leg.side.address,
        ref: `alive:${s.id}`,
        payload: { alive, sig: signText(me, alive) },
      }),
    );
  }

  function onAlive(s: Session, leg: Leg, payload: any) {
    const key = leg.side.publicKey;
    if (!key || typeof payload.sig !== 'string') return;
    if (!verifyText(key, payload.alive, payload.sig)) return;
    let a: any;
    try {
      a = JSON.parse(payload.alive);
    } catch {
      return;
    }
    if (a?.session !== s.id || !Number.isInteger(a.have) || a.have < 0 || a.have > leg.sendSeq) {
      return;
    }
    const now = Date.now();
    leg.speaksAlive = true;
    leg.lastHeard = now;
    leg.aliveMisses = 0;
    for (const [seq, frame] of leg.sent) {
      if (seq < a.have) leg.sent.delete(seq);
      else if (now - frame.at > aliveMs && relayReady) {
        frame.at = now;
        relaySend(leg.side.address, frame.payload, `${s.id}:${seq}`);
      }
    }
  }

  // Silence only counts while this side can hear: with its own relay link
  // down, the fault is here, not with the other side.
  const quietFor = (s: Session, leg: Leg) =>
    leg.speaksAlive && s.state !== 'ended' && relayReady ? Date.now() - leg.lastHeard : 0;

  const quietShown = (s: Session, leg?: Leg) => {
    const quiet = leg ? quietFor(s, leg) : 0;
    return quiet >= QUIET_SHOWN * aliveMs ? Math.round(quiet / 1000) : undefined;
  };

  function onPeer(from: string, payload: any) {
    const s = current;
    const leg = s && s.state !== 'ended' ? s.legs.find((l) => l.side.address === from) : undefined;
    if (s && leg) {
      if (typeof payload?.alive === 'string') return onAlive(s, leg, payload);
      leg.lastHeard = Date.now();
      leg.aliveMisses = 0;
    }
    try {
      if (typeof payload?.signed === 'string') onControl(from, payload);
      else onFrame(from, payload);
    } catch (err) {
      const s = current;
      const leg = s?.legs.find((l) => l.side.address === from);
      if (!s || s.state === 'ended' || !leg) log(`dropped a message from ${from}:`, explain(err));
      else if (s.group && s.role === 'caller' && s.state !== 'dialing') {
        log(`dropped ${from} from the session:`, explain(err));
        lose(s, leg, `protocol error: ${explain(err)}`);
      } else fail(s, err);
    }
  }

  // A called side that is lost leaves a group call. Losing the caller, or the
  // other side of two, ends the session.
  function lose(s: Session, leg: Leg, what: string) {
    if (s.state === 'dialing') return dropAtDial(s, leg, what, `the other side ${what}`);
    if (!s.group || s.role !== 'caller') {
      return end(s, `${s.group ? 'the caller' : 'the other side'} ${what}`);
    }
    if (s.left.has(leg.side.id)) return;
    leg.inbox.clear();
    leg.sent.clear();
    leg.gapSince = undefined;
    if (s.state === 'closing' || !liveLegs(s).some((l) => l !== leg)) {
      return leave(s, leg.side.id, what);
    }
    // Set first so the entry that tells the others is not sent to it.
    s.left.set(leg.side.id, what);
    sendEntry(s, { type: 'left', side: leg.side.id, reason: what });
  }

  // At dial time a group call goes ahead with whoever answers. Nobody has
  // been given the roster yet, so the sides still in it are lettered afresh.
  function dropAtDial(s: Session, leg: Leg, reason: string, twoSided: string) {
    if (!s.group) return giveUp(s, twoSided);
    const who = leg.side.savedAs ?? leg.side.address;
    if (s.legs.length === 1) return giveUp(s, `no one called could join (${who}: ${reason})`);
    s.legs = s.legs.filter((l) => l !== leg);
    s.sides = s.legs.map((l, i) => Object.assign(l.side, { id: LETTERS[i + 1]! }));
    emit({ kind: 'left', who, reason });
    callIfReady(s);
  }

  // A group call that cannot go ahead tells every side already keyed. A
  // hangup is a type every version knows.
  function giveUp(s: Session, reason: string) {
    if (s.group && s.role === 'caller' && s.legs.some((l) => l.keys)) {
      s.endReason = reason;
      sendEntry(s, { type: 'hangup', reason });
    }
    end(s, reason);
  }

  function onControl(from: string, payload: any) {
    const { signed, sig, key } = payload;
    if (
      typeof sig !== 'string' ||
      typeof key !== 'string' ||
      addressOf(key) !== from ||
      !verifyText(key, signed, sig)
    ) {
      log('dropped a badly signed control message from', from);
      return;
    }
    const c = ControlSchema.parse(JSON.parse(signed));
    if (c.to !== address) return;
    const s = current;

    if (c.kind === 'ring') {
      if (!c.eph) return;
      if (!isSavedKey(from, key)) {
        log(`refused a call from ${from}: not the key saved for that contact`);
        emit({ kind: 'impostor', address: from });
        return;
      }
      if (s && s.state !== 'ended') {
        sendControl(from, 'busy', c.session);
        return;
      }
      const next = startSession(c.session, 'callee', [from]);
      const leg = next.legs[0]!;
      next.group = c.group === 1;
      leg.side.publicKey = key;
      leg.keys = deriveSessionKeys(leg.eph, c.eph, next.id, 'callee');
      next.state = 'ringing';
      writeHeader(next);
      sendControl(from, 'ringing', next.id, leg.eph.publicKey, next.group);
      return;
    }

    const leg = s?.legs.find((l) => l.side.address === from);
    if (
      !s ||
      !leg ||
      leg.keys ||
      s.id !== c.session ||
      s.role !== 'caller' ||
      s.state !== 'dialing'
    ) {
      return;
    }
    if (!isSavedKey(from, key)) {
      return giveUp(s, `the answer did not come from the key saved for ${s.group ? from : 'this contact'}, so this is not the contact you know`);
    }
    if (c.kind === 'busy') {
      return dropAtDial(s, leg, 'in another session', 'the other side is in another session');
    }
    if (!c.eph) return;
    leg.side.publicKey = key;
    leg.keys = deriveSessionKeys(leg.eph, c.eph, s.id, 'caller');
    leg.group = c.group === 1;
    if (s.group && !leg.group) {
      return giveUp(s, `${from} runs a parley that cannot join a session of more than two`);
    }
    callIfReady(s);
  }

  function callIfReady(s: Session) {
    if (!s.legs.every((l) => l.keys)) return;
    s.group = s.legs.length > 1;
    writeHeader(s);
    sendEntry(s, {
      type: 'call',
      name: me.name,
      title: s.title,
      items: s.items.map((i) => i.title),
      roster: s.group
        ? [
            { id: 'a', address, key: me.publicKey },
            ...s.sides.map((x) => ({ id: x.id, address: x.address, key: x.publicKey ?? '' })),
          ]
        : undefined,
    });
  }

  // Which side wrote an entry. On a group call a called side takes entries
  // the caller forwards from the others; anywhere else only the leg's own side.
  function authorOf(s: Session, leg: Leg, from: unknown): Side {
    const side =
      s.group && s.role === 'callee'
        ? s.sides.find((x) => x.address === from)
        : from === leg.side.address
          ? leg.side
          : undefined;
    expect(side?.publicKey, s.group ? 'an entry came from someone not in this session' : 'an entry was not signed by the other side');
    return side;
  }

  function onFrame(from: string, payload: any) {
    const s = current;
    const leg = s?.legs.find((l) => l.side.address === from);
    if (
      !s ||
      !leg ||
      !leg.keys ||
      s.state === 'ended' ||
      s.left.has(leg.side.id) ||
      payload?.session !== s.id
    ) {
      return;
    }
    expect(
      Number.isInteger(payload.seq) && typeof payload.sealed === 'string',
      'malformed frame',
    );
    if (payload.seq < leg.recvSeq) return;
    expect(leg.inbox.size < INBOX_MAX, 'too many out-of-order frames');
    leg.inbox.set(payload.seq, payload.sealed);

    for (
      let sealed = leg.inbox.get(leg.recvSeq);
      sealed !== undefined && !hasEnded(s);
      sealed = leg.inbox.get(leg.recvSeq)
    ) {
      leg.inbox.delete(leg.recvSeq);
      const { raw, sig } = JSON.parse(open(leg.keys.recv, leg.recvSeq, sealed));
      expect(typeof raw === 'string' && typeof sig === 'string', 'an entry was not signed by the other side');
      const author = authorOf(s, leg, JSON.parse(raw)?.from);
      expect(
        author.publicKey && verifyText(author.publicKey, raw, sig),
        s.group ? `an entry was not signed by ${author.address}, whose entry it says it is` : 'an entry was not signed by the other side',
      );
      const entry = EntrySchema.parse(JSON.parse(raw));
      expect(
        entry.session === s.id && entry.seq === author.nextSeq,
        'an entry does not belong to this session',
      );
      leg.recvSeq++;
      author.nextSeq++;
      record(s, raw, sig);
      // Forwarded before it takes effect here: an entry that ends the agenda
      // makes the caller hang up, and that must not overtake it.
      if (s.group && s.role === 'caller') {
        for (const other of liveLegs(s)) if (other !== leg) sendFrame(s, other, raw, sig);
      }
      apply(s, entry, author.id);
    }
    leg.gapSince = leg.inbox.size ? (leg.gapSince ?? Date.now()) : undefined;
  }

  function startSession(id: string, role: Role, peers: string[]): Session {
    events.length = 0;
    feed.length = 0;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const dir = join(home, 'sessions', `${stamp}-${id}`);
    mkdirSync(dir, { recursive: true });
    const contacts = loadContacts();
    const sides = peers.map((peer, i) => ({
      id: role === 'caller' ? LETTERS[i + 1]! : 'a',
      address: peer,
      knownSince: contacts[peer]?.firstSeen,
      savedAs: contacts[peer]?.name,
      nextSeq: 0,
    }));
    current = {
      id,
      dir,
      role,
      state: 'dialing',
      group: false,
      self: role === 'caller' ? 'a' : 'b',
      sides,
      legs: sides.map((side) => ({
        side,
        eph: newEphemeral(),
        sendSeq: 0,
        recvSeq: 0,
        inbox: new Map(),
        sent: new Map(),
        lastHeard: Date.now(),
        aliveMisses: 0,
      })),
      seq: 0,
      accepted: new Set(),
      left: new Map(),
      confirmed: new Set(),
      title: '',
      items: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      entries: 0,
      hungUp: {},
    };
    return current;
  }

  function writeHeader(s: Session) {
    const mine = { address, publicKey: me.publicKey };
    const peer = peerOf(s);
    const theirs = { address: peer.address, publicKey: peer.publicKey };
    record(
      s,
      JSON.stringify({
        session: s.id,
        caller: s.role === 'caller' ? mine : theirs,
        callee: s.role === 'caller' ? theirs : mine,
        sides:
          s.group && s.role === 'caller'
            ? s.sides.map((x) => ({ id: x.id, address: x.address, publicKey: x.publicKey }))
            : undefined,
      }),
    );
  }

  function record(s: Session, raw: string, sig?: string) {
    appendFileSync(
      join(s.dir, 'transcript.jsonl'),
      JSON.stringify({ raw, sig }) + '\n',
    );
    cloud.touch();
  }

  function sendFrame(s: Session, leg: Leg, raw: string, sig: string) {
    if (!leg.keys) throw new Error('the session has no keys yet');
    const seq = leg.sendSeq++;
    const payload = {
      kind: 'frame',
      session: s.id,
      seq,
      sealed: seal(leg.keys.send, seq, JSON.stringify({ raw, sig })),
    };
    leg.sent.set(seq, { payload, tries: 0, at: Date.now() });
    relaySend(leg.side.address, payload, `${s.id}:${seq}`);
  }

  function sendEntry(s: Session, body: EntryBody) {
    const legs = liveLegs(s);
    if (!legs.length) throw new Error('the session has no keys yet');
    const seq = s.seq++;
    const entry = {
      session: s.id,
      seq,
      from: address,
      at: new Date().toISOString(),
      ...body,
    } as Entry;
    const raw = JSON.stringify(entry);
    const sig = signText(me, raw);
    for (const leg of legs) sendFrame(s, leg, raw, sig);
    record(s, raw, sig);
    apply(s, entry, s.self);
  }

  const sideOf = (s: Session, id: string) => s.sides.find((x) => x.id === id);

  function nameOf(s: Session, id: string): string {
    if (id === s.self) return me.name;
    const x = sideOf(s, id);
    return `${x?.name ?? x?.savedAs ?? x?.address ?? 'unknown'} (${id})`;
  }

  function takeRoster(s: Session, roster: NonNullable<Extract<Entry, { type: 'call' }>['roster']>) {
    expect(s.group, 'a call of more than two sides that did not ask for one');
    const caller = peerOf(s);
    const [first] = roster;
    expect(
      first?.address === caller.address &&
        first.key === caller.publicKey &&
        roster.every((r, i) => r.id === LETTERS[i] && addressOf(r.key) === r.address) &&
        new Set(roster.map((r) => r.address)).size === roster.length,
      'the call names its sides wrongly',
    );
    const mine = roster.find((r) => r.address === address);
    expect(mine && mine.key === me.publicKey, 'the call does not name this side');
    const contacts = loadContacts();
    const others = roster.filter((r) => r.id !== 'a' && r !== mine);
    for (const r of others) {
      expect(isSavedKey(r.address, r.key), `the call names ${r.address} with a key other than the one saved for that contact`);
    }
    s.self = mine.id;
    s.sides = [
      caller,
      ...others.map((r) => ({
        id: r.id,
        address: r.address,
        publicKey: r.key,
        knownSince: contacts[r.address]?.firstSeen,
        savedAs: contacts[r.address]?.name,
        nextSeq: 0,
      })),
    ];
  }

  function openIfReady(s: Session) {
    if (s.state !== 'awaiting_approval') return;
    if (!present(s).every((id) => id === 'a' || s.accepted.has(id))) return;
    s.state = 'active';
    s.activeSince = Date.now();
    for (const x of s.sides) {
      if (x.name && x.publicKey && !s.left.has(x.id)) saveContact(x.address, x.name, x.publicKey);
    }
    emit({ kind: 'opened' });
    if (config.openViewer) {
      openInBrowser(viewerUrl, (why) => log('could not open the live view:', why));
    }
  }

  // A side has left a group call. What it already agreed stays agreed; what
  // waited only on its agreement now closes.
  function leave(s: Session, id: string, reason: string) {
    if (s.role === 'caller' && s.state === 'closing') {
      s.confirmed.add(id);
      if (s.sides.every((x) => s.left.has(x.id) || s.confirmed.has(x.id))) end(s, s.endReason ?? reason);
      return;
    }
    s.left.set(id, reason);
    emit({ kind: 'left', who: nameOf(s, id), reason });
    if (present(s).length < 2) {
      return end(s, `everyone else has left (${nameOf(s, id)}: ${reason})`);
    }
    openIfReady(s);
    if (s.state !== 'active') return;
    for (const item of s.items) {
      if (item.state !== 'open') continue;
      const done = [...item.proposals.values()].filter((p) => fullyAgreed(s, p) && p.agreedBy.size);
      const p = done.find((d) => d.ref.startsWith('a:')) ?? done[0];
      if (p) {
        item.state = 'agreed';
        item.agreed = p;
      }
    }
    finishIfDone(s);
  }

  function finishIfDone(s: Session) {
    if (s.state === 'active' && s.items.every((i) => i.state !== 'open')) {
      sendEntry(s, { type: 'hangup', reason: 'agenda complete' });
    }
  }

  // Every side runs every entry through this, its own and the others',
  // possibly in a different order. Each rule has to give the same final
  // state whichever order two crossing entries arrive in.
  function apply(s: Session, e: Entry, author: string) {
    s.lastActivity = Date.now();
    s.entries++;
    const by: Who = author === s.self ? 'me' : 'peer';
    const lead = author;
    const said = s.group ? { by: nameOf(s, author) } : {};
    // Before the entry takes effect: an entry that ends the agenda sends a
    // hangup from inside this call, and the feed has to show them in order.
    feed.push({
      n: ++feedCounter,
      by,
      author: s.group ? author : undefined,
      at: e.at,
      type: e.type,
      item: 'item' in e ? e.item : e.type === 'add_item' ? e.id : undefined,
      text:
        e.type === 'left'
          ? `${nameOf(s, e.side)}: ${e.reason}`
          : 'text' in e ? e.text : 'reason' in e ? e.reason : 'title' in e ? e.title : undefined,
      ref: e.type === 'propose' ? `${lead}:${e.seq}` : 'ref' in e ? e.ref : undefined,
    });

    switch (e.type) {
      case 'call':
        expect(
          author === 'a' &&
            s.state === (by === 'me' ? 'dialing' : 'ringing'),
          'a call arrived out of turn',
        );
        if (by === 'peer') {
          if (e.roster) takeRoster(s, e.roster);
          else s.group = false;
        }
        s.title = e.title;
        s.items = e.items.map((t, i) => newItem(`a${i + 1}`, t, 'call'));
        s.state = 'awaiting_approval';
        if (by === 'peer') {
          peerOf(s).name = e.name;
          s.answerIn = config.approval;
          emit({ kind: 'incoming' });
          void promptForApproval(s);
        }
        return;
      case 'accept':
        expect(
          author !== 'a' && s.state === 'awaiting_approval' && !s.accepted.has(author),
          'an accept arrived out of turn',
        );
        if (by === 'peer') {
          const x = sideOf(s, author);
          if (x) x.name = e.name;
        }
        s.accepted.add(author);
        openIfReady(s);
        return;
      case 'decline':
        expect(
          author !== 'a' && s.state === 'awaiting_approval',
          'a decline arrived out of turn',
        );
        if (!s.group || by === 'me') {
          end(
            s,
            by === 'me'
              ? `you declined: ${e.reason}`
              : `the other side declined: ${e.reason}`,
          );
        } else {
          leave(s, author, `declined: ${e.reason}`);
        }
        return;
      case 'left':
        expect(
          s.group && author === 'a' && e.side !== s.self && sideOf(s, e.side),
          'a side was said to leave out of turn',
        );
        leave(s, e.side, e.reason);
        return;
      case 'hangup':
        if (s.group) {
          if (by === 'me' && s.self === 'a') {
            s.endReason ??= e.reason;
            s.state = 'closing';
            s.closingSince = Date.now();
            if (s.sides.every((x) => s.left.has(x.id))) end(s, s.endReason);
          } else if (by === 'me') {
            end(s, s.endReason ?? e.reason);
          } else if (author === 'a') {
            s.endReason ??= `${nameOf(s, 'a')} hung up: ${e.reason}`;
            sendEntry(s, { type: 'hangup', reason: 'the caller hung up' });
          } else {
            leave(s, author, e.reason);
          }
          return;
        }
        s.hungUp[by] = e.reason;
        s.endReason ??=
          by === 'me' ? e.reason : `the other side hung up: ${e.reason}`;
        if (by === 'peer' && !s.hungUp.me) {
          sendEntry(s, { type: 'hangup', reason: 'the other side hung up' });
        } else if (s.hungUp.me && s.hungUp.peer) {
          end(s, s.endReason);
        } else {
          s.state = 'closing';
          s.closingSince = Date.now();
        }
        return;
    }

    expect(
      s.state === 'active' || s.state === 'closing',
      `${e.type} arrived before the session was open`,
    );

    if (e.type === 'add_item') {
      expect(
        new RegExp(`^${lead}[1-9][0-9]*$`).test(e.id) &&
          !s.items.some((i) => i.id === e.id),
        `bad agenda item id ${e.id}`,
      );
      expect(s.items.length < LIMITS.itemsTotal, 'too many agenda items');
      s.items.push(newItem(e.id, e.title, author));
      if (by === 'peer') emit({ kind: 'add_item', item: e.id, title: e.title, ...said });
    } else {
      const item = s.items.find((i) => i.id === e.item);
      expect(item, `no agenda item ${e.item}`);
      if (e.type === 'say') {
        if (by === 'peer') emit({ kind: 'say', item: item.id, text: e.text, ...said });
      } else if (e.type === 'propose') {
        const p: Proposal = { ref: `${lead}:${e.seq}`, by: author, text: e.text, agreedBy: new Set() };
        item.proposals.set(p.ref, p);
        if (item.state === 'open') item.latest.set(author, p);
        if (by === 'peer') {
          emit({ kind: 'propose', item: item.id, ref: p.ref, text: e.text, ...said });
        }
      } else if (e.type === 'agree') {
        const p = item.proposals.get(e.ref);
        expect(p && p.by !== author, 'agree names a proposal that is not the other side’s');
        p.agreedBy.add(author);
        // An agree beats a drop or a newer proposal that crossed it: the
        // offer was open when it was accepted. If two agrees cross, the
        // caller's proposal is the one every side keeps.
        if (fullyAgreed(s, p) && (item.state !== 'agreed' || p.ref.startsWith('a:'))) {
          item.state = 'agreed';
          item.agreed = p;
        }
        if (by === 'peer') emit({ kind: 'agree', item: item.id, ref: e.ref, ...said });
      } else if (item.state === 'open') {
        item.state = 'dropped';
        item.dropReason = e.reason;
        if (by === 'peer') {
          emit({ kind: 'drop', item: item.id, reason: e.reason, ...said });
        }
      }
    }

    finishIfDone(s);
  }

  function end(s: Session, reason: string) {
    if (s.state === 'ended') return;
    s.state = 'ended';
    s.endReason = reason;
    s.endedAt = Date.now();
    s.dialog?.kill();
    for (const leg of s.legs) {
      leg.inbox.clear();
      leg.sent.clear();
    }
    if (s.activeSince) {
      const v = view();
      if (v.session) {
        writeFileSync(
          join(s.dir, 'minutes.md'),
          renderMinutes(v, new Date(s.activeSince), new Date(s.endedAt)),
        );
      }
    }
    emit({ kind: 'ended', reason });
  }

  function fail(s: Session, err: unknown) {
    const why = `protocol error: ${explain(err)}`;
    log('session failed:', why);
    s.endReason = why;
    try {
      if (liveLegs(s).length && !s.hungUp.me && !(s.group && s.state === 'closing')) {
        sendEntry(s, { type: 'hangup', reason: why });
      }
    } catch (sendErr) {
      log('could not tell the other side:', explain(sendErr));
    }
    end(s, why);
  }

  function decide(s: Session, accept: boolean, reason = 'declined') {
    s.dialog?.kill();
    s.dialog = undefined;
    sendEntry(
      s,
      accept ? { type: 'accept', name: me.name } : { type: 'decline', reason },
    );
  }

  async function promptForApproval(s: Session) {
    if (s.answerIn !== 'dialog') return;
    const clean = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ');
    const held = holder(address);
    const peer = peerOf(s);
    const text = [
      `${clean(peer.name ?? 'Someone')} is calling "${clean(me.name)}", one of your Claude Code sessions.`,
      `Address: ${peer.address}`,
      peer.knownSince
        ? `You first connected to this address on ${peer.knownSince.slice(0, 10)}.`
        : 'You have NOT connected to this address before.',
      ...(s.group
        ? [
            'Also called into this session:',
            ...s.sides.slice(1).map((x) => `  • ${x.savedAs ? clean(x.savedAs) : 'someone you have not connected to'} (${x.address})`),
          ]
        : []),
      '',
      `Agenda: ${clean(s.title)}`,
      ...s.items.map((i) => `  • ${clean(i.title)}`),
      '',
      held
        ? `If you accept, go to that session (in ${clean(held.dir)}) and tell it: join the parley call.`
        : `No open session has this name. If you accept, tell any Claude Code session: join the parley call as ${clean(me.name)}.`,
    ].join('\n');
    const quoted = `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const proc = spawn(
      'osascript',
      [
        '-e',
        `display dialog ${quoted} with title "Parley: incoming call" buttons {"Decline", "Accept"} default button "Decline" giving up after ${RING_MS / 1000}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    s.dialog = proc;
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (err += chunk));
    let killed = false;
    await new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        killed = code === null;
        resolve();
      });
      proc.on('error', (spawnErr) => {
        err += spawnErr.message;
        resolve();
      });
    });
    if (s.state !== 'awaiting_approval' || s.dialog !== proc) return;
    if (out.includes('button returned:Accept')) decide(s, true);
    else if (out.includes('button returned:Decline')) decide(s, false);
    else if (out.includes('gave up:true')) decide(s, false, 'nobody answered');
    // Only the window can accept this call, so a program that closes the
    // window must not be handed the terminal instead.
    else if (killed) decide(s, false, 'the approval window was closed without an answer');
    // A dialog that could not be shown is not a decline. The call stays
    // waiting so the person can still answer with `parley accept`.
    else {
      s.answerIn = 'terminal';
      log('the approval dialog failed; answer in a terminal:', err.trim());
    }
  }

  function view(): View {
    const s = current;
    return {
      cursor: counter,
      approval: s?.answerIn ?? config.approval,
      viewer: viewerUrl,
      me: { name: me.name, address },
      relay: { url: relayUrl, connected: relayReady, error: relayError },
      cloud: cloud.state(),
      session: s && {
        id: s.id,
        role: s.role,
        state: s.state,
        peer: {
          address: peerOf(s).address,
          name: peerOf(s).name,
          knownSince: peerOf(s).knownSince,
          savedAs: peerOf(s).savedAs,
        },
        sides: s.group
          ? [
              { id: s.self, name: me.name, address, you: true as const },
              ...s.sides.map((x) => ({
                id: x.id,
                name: x.name,
                address: x.address,
                knownSince: x.knownSince,
                savedAs: x.savedAs,
                left: s.left.get(x.id),
                quietSeconds: s.left.has(x.id)
                  ? undefined
                  : quietShown(s, s.legs.find((l) => l.side === x)),
              })),
            ].sort((x, y) => x.id.localeCompare(y.id))
          : undefined,
        title: s.title,
        items: s.items.map((i) => {
          const open = i.state === 'open';
          const who = (id: string): Who => (id === s.self ? 'me' : 'peer');
          const shown = (p?: Proposal) => p && { ref: p.ref, by: who(p.by), text: p.text };
          const others = [...i.latest.values()].filter((p) => p.by !== s.self);
          return {
            id: i.id,
            title: i.title,
            addedBy: i.addedBy === 'call' ? 'call' : who(i.addedBy),
            addedById: s.group && i.addedBy !== 'call' ? i.addedBy : undefined,
            state: i.state,
            mine: open ? shown(i.latest.get(s.self)) : undefined,
            theirs: open && !s.group ? shown(others[0]) : undefined,
            others:
              open && s.group
                ? others.map((p) => ({ ref: p.ref, by: p.by, text: p.text, agreedBy: [...p.agreedBy] }))
                : undefined,
            agreed: i.agreed && {
              text: i.agreed.text,
              proposedBy: who(i.agreed.by),
              proposedById: s.group ? i.agreed.by : undefined,
            },
            dropReason: i.dropReason,
          };
        }),
        endedReason: s.state === 'ended' ? s.endReason : undefined,
        peerQuietSeconds: s.group ? undefined : quietShown(s, s.legs[0]),
        minutes:
          s.state === 'ended' && s.activeSince
            ? join(s.dir, 'minutes.md')
            : undefined,
      },
    };
  }

  function live(): Session {
    const s = current;
    if (!s || s.state === 'ended') throw new Error('there is no session');
    if (s.state === 'closing') throw new Error('the session is ending');
    if (s.state !== 'active') {
      throw new Error('the session is not open yet; a person has to accept it');
    }
    return s;
  }

  function openItem(s: Session, id: string): Item {
    const item = s.items.find((i) => i.id === id);
    if (!item) {
      throw new Error(
        `no agenda item "${id}"; the items are ${s.items.map((i) => i.id).join(', ')}`,
      );
    }
    if (item.state !== 'open') {
      throw new Error(
        `item ${id} is already ${item.state}; add a new item to take it further`,
      );
    }
    return item;
  }

  const ops: Record<string, (args: unknown) => unknown> = {
    ping: () => 'pong',
    // A node that has just started has not heard from the relay yet. Wait
    // for its first answer so the first status is not a false "not connected".
    status: async () => {
      await Promise.race([
        relayFirstAnswer,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      return view();
    },
    call: (args) => {
      const a = ArgSchemas.call.parse(args);
      const to = (Array.isArray(a.address) ? a.address : [a.address]).map(normalizeAddress);
      if (to.includes(address)) throw new Error('that is your own address');
      if (new Set(to).size !== to.length) throw new Error('an address is named twice');
      if (current && current.state !== 'ended') {
        throw new Error('a session is already in progress; hang up first');
      }
      if (!relayReady) {
        throw new Error(
          `not connected to the relay at ${relayUrl}${relayError ? `: ${relayError}` : ''}`,
        );
      }
      const s = startSession(randomBytes(8).toString('hex'), 'caller', to);
      s.title = a.title;
      s.items = a.items.map((t, i) => newItem(`a${i + 1}`, t, 'call'));
      s.group = to.length > 1;
      for (const leg of s.legs) {
        sendControl(leg.side.address, 'ring', s.id, leg.eph.publicKey, s.group);
      }
      return view();
    },
    wait: (args) => {
      const { cursor: given, timeoutMs } = ArgSchemas.wait.parse(args);
      // -1 is a client that has seen nothing: replay a session still in
      // progress, but not the leftovers of one that already ended.
      const inProgress = current && current.state !== 'ended';
      const cursor = given >= 0 ? given : inProgress ? 0 : counter;
      return new Promise<WaitResult>((resolve) => {
        const deliver = () => {
          const fresh = events.filter((e) => e.n > cursor);
          if (!fresh.length) return false;
          resolve({ events: fresh, cursor: counter, view: view() });
          return true;
        };
        if (deliver()) return;
        const wake = () => {
          if (!deliver()) return;
          clearTimeout(timer);
          waiters.delete(wake);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve({ events: [], cursor, view: view() });
        }, timeoutMs);
        waiters.add(wake);
      });
    },
    say: (args) => {
      const a = ArgSchemas.say.parse(args);
      const s = live();
      openItem(s, a.item);
      sendEntry(s, { type: 'say', item: a.item, text: a.text });
      return view();
    },
    add_item: (args) => {
      const a = ArgSchemas.add_item.parse(args);
      const s = live();
      if (s.items.length >= LIMITS.itemsTotal) {
        throw new Error(`an agenda holds at most ${LIMITS.itemsTotal} items`);
      }
      const lead = s.self;
      const taken = s.items.filter((i) => i.id.startsWith(lead)).length;
      sendEntry(s, { type: 'add_item', id: `${lead}${taken + 1}`, title: a.title });
      return view();
    },
    propose: (args) => {
      const a = ArgSchemas.propose.parse(args);
      const s = live();
      openItem(s, a.item);
      sendEntry(s, { type: 'propose', item: a.item, text: a.text });
      return view();
    },
    agree: (args) => {
      const a = ArgSchemas.agree.parse(args);
      const s = live();
      const item = openItem(s, a.item);
      const offers = [...item.latest.values()].filter((p) => p.by !== s.self);
      if (!s.group) {
        const [theirs] = offers;
        if (!theirs) {
          throw new Error(`the other side has made no proposal on ${a.item}`);
        }
        if (theirs.ref !== a.proposal) {
          throw new Error(
            `their latest proposal on ${a.item} is ${theirs.ref}, not ${a.proposal}; read it before agreeing`,
          );
        }
      } else {
        if (!offers.length) throw new Error(`nobody else has made a proposal on ${a.item}`);
        const p = offers.find((o) => o.ref === a.proposal);
        if (!p) {
          throw new Error(
            `the latest proposals on ${a.item} are ${offers.map((o) => o.ref).join(', ')}, not ${a.proposal}; read one before agreeing`,
          );
        }
        if (p.agreedBy.has(s.self)) throw new Error(`you have already agreed to ${a.proposal}`);
      }
      sendEntry(s, { type: 'agree', item: a.item, ref: a.proposal });
      return view();
    },
    drop: (args) => {
      const a = ArgSchemas.drop.parse(args);
      const s = live();
      openItem(s, a.item);
      sendEntry(s, { type: 'drop', item: a.item, reason: a.reason });
      return view();
    },
    hangup: (args) => {
      const { reason } = ArgSchemas.hangup.parse(args);
      const s = current;
      if (!s || s.state === 'ended') throw new Error('there is no session');
      if (s.state === 'closing') throw new Error('already hanging up');
      const why = `you hung up: ${reason}`;
      if (s.state === 'dialing') giveUp(s, why);
      else if (!s.legs.some((l) => l.keys) || s.state === 'ringing') end(s, why);
      else {
        s.endReason = why;
        sendEntry(s, { type: 'hangup', reason });
      }
      return view();
    },
    approve: (args) => {
      const a = ArgSchemas.approve.parse(args);
      const s = current;
      if (!s || s.role !== 'callee' || s.state !== 'awaiting_approval') {
        throw new Error('no call is waiting for an answer');
      }
      if (a.accept && s.answerIn === 'dialog') {
        throw new Error('this call is accepted in the window on this machine, by the person looking at it');
      }
      decide(s, a.accept, a.reason);
      return view();
    },
    cloud_link: (args) => cloud.link(ArgSchemas.cloud_link.parse(args).url),
    cloud_unlink: () => {
      cloud.unlink();
      return view();
    },
    stop: () => {
      setTimeout(() => {
        rmSync(join(home, 'node.json'), { force: true });
        process.exit(0);
      }, 50);
      return 'stopping';
    },
  };

  async function handle(line: string) {
    try {
      const { token: given, op, args } = JSON.parse(line);
      if (given !== token) throw new Error('bad token');
      const fn = ops[op];
      if (!fn) throw new Error(`unknown operation "${op}"`);
      return { ok: true, result: await fn(args) };
    } catch (err) {
      return { ok: false, error: explain(err) };
    }
  }

  const server = createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      void handle(line).then((res) => conn.end(JSON.stringify(res) + '\n'));
    });
  });

  // The live view. Read-only, loopback only, and behind a token in the path
  // so another page in the same browser cannot read a session.
  const viewer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const base = `/${viewToken}/`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) {
      res.writeHead(403).end();
    } else if (req.method !== 'GET' || !url.pathname.startsWith(base)) {
      res.writeHead(404).end();
    } else if (url.pathname === base) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      );
      res.end(VIEWER);
    } else if (url.pathname === `${base}state`) {
      const after = Number(url.searchParams.get('after')) || 0;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ view: view(), feed: feed.filter((f) => f.n > after) }));
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => viewer.listen(0, '127.0.0.1', resolve));
  viewerUrl = `http://127.0.0.1:${(viewer.address() as AddressInfo).port}/${viewToken}/`;

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    writeJson(home, 'node.json', { port, token, pid: process.pid, version: VERSION }, true);
    log(`parley node for ${me.name} (${address}) listening on ${port}`);
  });

  setInterval(() => {
    const s = current;
    if (!s || s.state === 'ended') return;
    const now = Date.now();
    const { idleMinutes, maxMinutes, maxEntries } = config.limits;
    const auto = (reason: string) => {
      s.endReason = reason;
      sendEntry(s, { type: 'hangup', reason });
    };
    try {
      if (s.state === 'ringing') {
        if (now - s.createdAt > HANDSHAKE_MS) {
          giveUp(s, 'the other side did not complete the handshake');
        }
      } else if (s.state === 'dialing') {
        if (now - s.createdAt > HANDSHAKE_MS) {
          for (const leg of s.legs.filter((l) => !l.keys)) {
            if (s.state !== 'dialing') break;
            dropAtDial(s, leg, 'did not answer', 'the other side did not complete the handshake');
          }
        }
      } else if (s.state === 'awaiting_approval') {
        if (now - s.createdAt > RING_MS && s.role === 'callee') {
          decide(s, false, 'nobody answered');
        } else if (now - s.createdAt > RING_MS + HANDSHAKE_MS) {
          if (!s.group) end(s, 'nobody answered');
          for (const leg of liveLegs(s)) {
            if (s.state !== 'awaiting_approval') break;
            if (!s.accepted.has(leg.side.id)) lose(s, leg, 'nobody answered');
          }
        }
      } else if (s.state === 'closing') {
        if (now - (s.closingSince ?? now) > HANGUP_WAIT_MS) {
          end(s, `${s.endReason} (the other side did not confirm)`);
        }
      } else if (now - s.lastActivity > idleMinutes * 60_000) {
        auto(`nothing was said for ${idleMinutes} minutes`);
      } else if (now - (s.activeSince ?? now) > maxMinutes * 60_000) {
        auto(`the ${maxMinutes}-minute limit was reached`);
      } else if (s.entries >= maxEntries) {
        auto(`the ${maxEntries}-message limit was reached`);
      }
      for (const leg of liveLegs(s)) {
        if (hasEnded(s) || !leg.gapSince || now - leg.gapSince <= GAP_WAIT_MS) continue;
        if (s.group && s.role === 'caller') lose(s, leg, 'a message from it was lost');
        else end(s, 'a message from the other side was lost');
      }
    } catch (err) {
      fail(s, err);
    }
  }, 1000);

  setInterval(() => {
    const s = current;
    if (!s || s.state === 'ended') return;
    try {
      for (const leg of liveLegs(s)) {
        if (hasEnded(s)) return;
        if (quietFor(s, leg) >= QUIET_ENDS * aliveMs) lose(s, leg, 'stopped answering');
        else if (relayReady) sendAlive(s, leg);
      }
    } catch (err) {
      fail(s, err);
    }
  }, aliveMs);

  connectRelay();
}

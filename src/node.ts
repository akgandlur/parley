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

type Proposal = { ref: string; by: Who; text: string };

type Item = {
  id: string;
  title: string;
  addedBy: Who | 'call';
  state: 'open' | 'agreed' | 'dropped';
  proposals: Map<string, Proposal>;
  mine?: Proposal;
  theirs?: Proposal;
  agreed?: Proposal;
  dropReason?: string;
};

type Session = {
  id: string;
  dir: string;
  role: Role;
  state: SessionState;
  peer: { address: string; publicKey?: string; name?: string };
  knownSince?: string;
  savedAs?: string;
  eph: Ephemeral;
  keys?: SessionKeys;
  sendSeq: number;
  recvSeq: number;
  inbox: Map<number, string>;
  gapSince?: number;
  sent: Map<number, { payload: object; tries: number }>;
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
});

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
        peer: { address: s.peer.address, name: s.peer.name },
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
    ws.onmessage = (ev) => {
      try {
        onRelay(JSON.parse(String(ev.data)));
      } catch (err) {
        log('could not handle a relay message:', explain(err));
      }
    };
    ws.onclose = (ev) => {
      relayReady = false;
      relayError = ev.reason || 'cannot reach it';
      relayAnswered();
      log(`relay connection closed (${ev.code} ${ev.reason}); retrying`);
      setTimeout(connectRelay, retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    };
    ws.onerror = () => {};
  }

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
      retryMs = 2000;
      relayAnswered();
      log('connected to the relay as', msg.address);
      for (const queued of outbox.splice(0)) socket?.send(queued);
    } else if (msg.t === 'recv') {
      onPeer(msg.from, msg.payload);
    } else if (msg.t === 'undeliverable') {
      onUndeliverable(msg.ref);
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
  ) {
    const signed = JSON.stringify({
      kind,
      session,
      to,
      at: new Date().toISOString(),
      eph,
    });
    relaySend(
      to,
      { signed, sig: signText(me, signed), key: me.publicKey },
      `${kind}:${session}`,
    );
  }

  function onUndeliverable(ref: unknown) {
    const s = current;
    if (!s || s.state === 'ended' || typeof ref !== 'string') return;
    if (ref === `ring:${s.id}`) return end(s, 'the other side is not online');
    const [id, seq] = ref.split(':');
    const frame = id === s.id ? s.sent.get(Number(seq)) : undefined;
    if (!frame) return;
    if (++frame.tries > RESEND_TRIES) {
      return end(s, 'the other side went offline');
    }
    setTimeout(() => {
      if (current === s && s.state !== 'ended') {
        relaySend(s.peer.address, frame.payload, ref);
      }
    }, RESEND_MS);
  }

  function onPeer(from: string, payload: any) {
    try {
      if (typeof payload?.signed === 'string') onControl(from, payload);
      else onFrame(from, payload);
    } catch (err) {
      const s = current;
      if (s && s.state !== 'ended' && from === s.peer.address) fail(s, err);
      else log(`dropped a message from ${from}:`, explain(err));
    }
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
      const next = startSession(c.session, 'callee', from);
      next.peer.publicKey = key;
      next.keys = deriveSessionKeys(next.eph, c.eph, next.id, 'callee');
      next.state = 'ringing';
      writeHeader(next);
      sendControl(from, 'ringing', next.id, next.eph.publicKey);
      return;
    }

    if (
      !s ||
      s.id !== c.session ||
      s.role !== 'caller' ||
      s.state !== 'dialing' ||
      from !== s.peer.address
    ) {
      return;
    }
    if (!isSavedKey(from, key)) {
      return end(s, 'the answer did not come from the key saved for this contact, so this is not the contact you know');
    }
    if (c.kind === 'busy') return end(s, 'the other side is in another session');
    if (!c.eph) return;
    s.peer.publicKey = key;
    s.keys = deriveSessionKeys(s.eph, c.eph, s.id, 'caller');
    writeHeader(s);
    sendEntry(s, {
      type: 'call',
      name: me.name,
      title: s.title,
      items: s.items.map((i) => i.title),
    });
  }

  function onFrame(from: string, payload: any) {
    const s = current;
    if (
      !s ||
      !s.keys ||
      !s.peer.publicKey ||
      s.state === 'ended' ||
      payload?.session !== s.id ||
      from !== s.peer.address
    ) {
      return;
    }
    expect(
      Number.isInteger(payload.seq) && typeof payload.sealed === 'string',
      'malformed frame',
    );
    if (payload.seq < s.recvSeq) return;
    expect(s.inbox.size < INBOX_MAX, 'too many out-of-order frames');
    s.inbox.set(payload.seq, payload.sealed);

    for (
      let sealed = s.inbox.get(s.recvSeq);
      sealed !== undefined && !hasEnded(s);
      sealed = s.inbox.get(s.recvSeq)
    ) {
      s.inbox.delete(s.recvSeq);
      const { raw, sig } = JSON.parse(open(s.keys.recv, s.recvSeq, sealed));
      expect(
        typeof raw === 'string' &&
          typeof sig === 'string' &&
          verifyText(s.peer.publicKey, raw, sig),
        'an entry was not signed by the other side',
      );
      const entry = EntrySchema.parse(JSON.parse(raw));
      expect(
        entry.session === s.id &&
          entry.seq === s.recvSeq &&
          entry.from === s.peer.address,
        'an entry does not belong to this session',
      );
      s.recvSeq++;
      record(s, raw, sig);
      apply(s, entry, 'peer');
    }
    s.gapSince = s.inbox.size ? (s.gapSince ?? Date.now()) : undefined;
  }

  function startSession(id: string, role: Role, peerAddress: string): Session {
    events.length = 0;
    feed.length = 0;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const dir = join(home, 'sessions', `${stamp}-${id}`);
    mkdirSync(dir, { recursive: true });
    const known = loadContacts()[peerAddress];
    current = {
      id,
      dir,
      role,
      state: 'dialing',
      peer: { address: peerAddress },
      knownSince: known?.firstSeen,
      savedAs: known?.name,
      eph: newEphemeral(),
      sendSeq: 0,
      recvSeq: 0,
      inbox: new Map(),
      sent: new Map(),
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
    const theirs = { address: s.peer.address, publicKey: s.peer.publicKey };
    record(
      s,
      JSON.stringify({
        session: s.id,
        caller: s.role === 'caller' ? mine : theirs,
        callee: s.role === 'caller' ? theirs : mine,
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

  function sendEntry(s: Session, body: EntryBody) {
    if (!s.keys) throw new Error('the session has no keys yet');
    const seq = s.sendSeq++;
    const entry = {
      session: s.id,
      seq,
      from: address,
      at: new Date().toISOString(),
      ...body,
    } as Entry;
    const raw = JSON.stringify(entry);
    const sig = signText(me, raw);
    const payload = {
      kind: 'frame',
      session: s.id,
      seq,
      sealed: seal(s.keys.send, seq, JSON.stringify({ raw, sig })),
    };
    s.sent.set(seq, { payload, tries: 0 });
    relaySend(s.peer.address, payload, `${s.id}:${seq}`);
    record(s, raw, sig);
    apply(s, entry, 'me');
  }

  // Both ends run every entry through this, their own and the other side's,
  // possibly in a different order. Each rule has to give the same final
  // state whichever order two crossing entries arrive in.
  function apply(s: Session, e: Entry, by: Who) {
    s.lastActivity = Date.now();
    s.entries++;
    const authorRole: Role =
      by === 'me' ? s.role : s.role === 'caller' ? 'callee' : 'caller';
    const lead = authorRole === 'caller' ? 'a' : 'b';
    // Before the entry takes effect: an entry that ends the agenda sends a
    // hangup from inside this call, and the feed has to show them in order.
    feed.push({
      n: ++feedCounter,
      by,
      at: e.at,
      type: e.type,
      item: 'item' in e ? e.item : e.type === 'add_item' ? e.id : undefined,
      text:
        'text' in e ? e.text : 'reason' in e ? e.reason : 'title' in e ? e.title : undefined,
      ref: e.type === 'propose' ? `${lead}:${e.seq}` : 'ref' in e ? e.ref : undefined,
    });

    switch (e.type) {
      case 'call':
        expect(
          authorRole === 'caller' &&
            s.state === (by === 'me' ? 'dialing' : 'ringing'),
          'a call arrived out of turn',
        );
        s.title = e.title;
        s.items = e.items.map((t, i) => newItem(`a${i + 1}`, t, 'call'));
        s.state = 'awaiting_approval';
        if (by === 'peer') {
          s.peer.name = e.name;
          s.answerIn = config.approval;
          emit({ kind: 'incoming' });
          void promptForApproval(s);
        }
        return;
      case 'accept':
        expect(
          authorRole === 'callee' && s.state === 'awaiting_approval',
          'an accept arrived out of turn',
        );
        if (by === 'peer') s.peer.name = e.name;
        s.state = 'active';
        s.activeSince = Date.now();
        if (s.peer.name && s.peer.publicKey) {
          saveContact(s.peer.address, s.peer.name, s.peer.publicKey);
        }
        emit({ kind: 'opened' });
        if (config.openViewer) {
          openInBrowser(viewerUrl, (why) => log('could not open the live view:', why));
        }
        return;
      case 'decline':
        expect(
          authorRole === 'callee' && s.state === 'awaiting_approval',
          'a decline arrived out of turn',
        );
        end(
          s,
          by === 'me'
            ? `you declined: ${e.reason}`
            : `the other side declined: ${e.reason}`,
        );
        return;
      case 'hangup':
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
      s.items.push(newItem(e.id, e.title, by));
      if (by === 'peer') emit({ kind: 'add_item', item: e.id, title: e.title });
    } else {
      const item = s.items.find((i) => i.id === e.item);
      expect(item, `no agenda item ${e.item}`);
      if (e.type === 'say') {
        if (by === 'peer') emit({ kind: 'say', item: item.id, text: e.text });
      } else if (e.type === 'propose') {
        const p: Proposal = { ref: `${lead}:${e.seq}`, by, text: e.text };
        item.proposals.set(p.ref, p);
        if (item.state === 'open') {
          if (by === 'me') item.mine = p;
          else item.theirs = p;
        }
        if (by === 'peer') {
          emit({ kind: 'propose', item: item.id, ref: p.ref, text: e.text });
        }
      } else if (e.type === 'agree') {
        const p = item.proposals.get(e.ref);
        expect(p && p.by !== by, 'agree names a proposal that is not the other side’s');
        // An agree beats a drop or a newer proposal that crossed it: the
        // offer was open when it was accepted. If two agrees cross, the
        // caller's proposal is the one both ends keep.
        if (item.state !== 'agreed' || p.ref.startsWith('a:')) {
          item.state = 'agreed';
          item.agreed = p;
        }
        if (by === 'peer') emit({ kind: 'agree', item: item.id, ref: e.ref });
      } else if (item.state === 'open') {
        item.state = 'dropped';
        item.dropReason = e.reason;
        if (by === 'peer') {
          emit({ kind: 'drop', item: item.id, reason: e.reason });
        }
      }
    }

    if (s.state === 'active' && s.items.every((i) => i.state !== 'open')) {
      sendEntry(s, { type: 'hangup', reason: 'agenda complete' });
    }
  }

  function end(s: Session, reason: string) {
    if (s.state === 'ended') return;
    s.state = 'ended';
    s.endReason = reason;
    s.endedAt = Date.now();
    s.dialog?.kill();
    s.inbox.clear();
    s.sent.clear();
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
      if (s.keys && !s.hungUp.me) sendEntry(s, { type: 'hangup', reason: why });
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
    const text = [
      `${clean(s.peer.name ?? 'Someone')} is calling "${clean(me.name)}", one of your Claude Code sessions.`,
      `Address: ${s.peer.address}`,
      s.knownSince
        ? `You first connected to this address on ${s.knownSince.slice(0, 10)}.`
        : 'You have NOT connected to this address before.',
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
          address: s.peer.address,
          name: s.peer.name,
          knownSince: s.knownSince,
          savedAs: s.savedAs,
        },
        title: s.title,
        items: s.items.map((i) => ({
          id: i.id,
          title: i.title,
          addedBy: i.addedBy,
          state: i.state,
          mine: i.state === 'open' ? i.mine : undefined,
          theirs: i.state === 'open' ? i.theirs : undefined,
          agreed: i.agreed && { text: i.agreed.text, proposedBy: i.agreed.by },
          dropReason: i.dropReason,
        })),
        endedReason: s.state === 'ended' ? s.endReason : undefined,
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
      const to = normalizeAddress(a.address);
      if (to === address) throw new Error('that is your own address');
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
      sendControl(to, 'ring', s.id, s.eph.publicKey);
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
      const lead = s.role === 'caller' ? 'a' : 'b';
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
      if (!item.theirs) {
        throw new Error(`the other side has made no proposal on ${a.item}`);
      }
      if (item.theirs.ref !== a.proposal) {
        throw new Error(
          `their latest proposal on ${a.item} is ${item.theirs.ref}, not ${a.proposal}; read it before agreeing`,
        );
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
      if (!s.keys || s.state === 'dialing' || s.state === 'ringing') end(s, why);
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
      if (s.state === 'dialing' || s.state === 'ringing') {
        if (now - s.createdAt > HANDSHAKE_MS) {
          end(s, 'the other side did not complete the handshake');
        }
      } else if (s.state === 'awaiting_approval') {
        if (now - s.createdAt > RING_MS && s.role === 'callee') {
          decide(s, false, 'nobody answered');
        } else if (now - s.createdAt > RING_MS + HANDSHAKE_MS) {
          end(s, 'nobody answered');
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
      if (!hasEnded(s) && s.gapSince && now - s.gapSince > GAP_WAIT_MS) {
        end(s, 'a message from the other side was lost');
      }
    } catch (err) {
      fail(s, err);
    }
  }, 1000);

  connectRelay();
}

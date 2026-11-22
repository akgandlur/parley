import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { startAccount, type AccountState, type Verified } from './account';
import { readAttestation } from './attest';
import { addressOf, openFor, sealTo, signText, verifyText } from './crypto';
import { isSavedKey, loadConfig, loadContacts, loadIdentity, readJson, saveContact } from './home';
import { RELAY_AUTH } from './relay';
import { TEXT_MAX } from './types';

const RETRY_MAX_MS = 15_000;
const CONNECT_WAIT_MS = 15_000;
const PROBE_EVERY_MS = 20_000;
const PROBE_WAIT_MS = 10_000;
const ANSWER_MS = 15_000;

export type Incoming = {
  id: string;
  from: { name: string; address: string; verified?: Verified };
  text: string;
  at: string;
};

export type AgentState = {
  name: string;
  address: string;
  relay: { connected: boolean; error?: string };
  account: AccountState;
};

class Offline extends Error {}

const explain = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A 0.5 node runs in the background and holds the name's relay connection.
// Two connections for one address replace each other without end, so it goes.
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
  const keys = new Map<string, string>();
  const keyWaits = new Map<string, Array<{ resolve: (key: string) => void; reject: (e: Error) => void }>>();
  const acks = new Map<string, { to: string; resolve: (name: string) => void; reject: (e: Error) => void }>();
  const seen = new Set<string>();

  const account = startAccount(home, me, log, (att) => {
    if (socket && ready) socket.send(JSON.stringify({ t: 'renew', att }));
    else if (!socket && refused && !closed) {
      clearTimeout(retryTimer);
      connectRelay();
    }
  });

  const keyOf = (to: string) => loadContacts()[to]?.key ?? keys.get(to);

  function record(entry: object) {
    appendFileSync(join(home, 'messages.jsonl'), JSON.stringify(entry) + '\n');
  }

  // A proof this side cannot check (no issuer of its own, or a bad one) is
  // shown as no proof at all.
  function verify(att: unknown, key: string, who: string): Verified | undefined {
    if (typeof att !== 'string') return undefined;
    try {
      const a = readAttestation(att, account.issuers(), key);
      return { domain: a.domain, kind: a.kind };
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

  function failAll(err: Error) {
    for (const [id, wait] of acks) {
      acks.delete(id);
      wait.reject(err);
    }
    for (const [to, waits] of keyWaits) {
      keyWaits.delete(to);
      for (const w of waits) w.reject(err);
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
      const offline = new Offline('not online');
      if (ref.startsWith('key:')) {
        const waits = keyWaits.get(msg.to) ?? [];
        keyWaits.delete(msg.to);
        for (const w of waits) w.reject(offline);
      } else if (ref.startsWith('msg:')) {
        const wait = acks.get(ref.slice(4));
        acks.delete(ref.slice(4));
        wait?.reject(offline);
      }
    }
  }

  function onPeer(from: string, p: any) {
    if (p?.v !== 2 || typeof p.key !== 'string' || addressOf(p.key) !== from) return;
    if (p.kind === 'key?') {
      relaySend(from, 'key-reply', { v: 2, kind: 'key', key: me.publicKey });
    } else if (p.kind === 'key') {
      keys.set(from, p.key);
      const waits = keyWaits.get(from) ?? [];
      keyWaits.delete(from);
      for (const w of waits) w.resolve(p.key);
    } else if (p.kind === 'ack') {
      const wait = acks.get(String(p.id));
      if (!wait || wait.to !== from) return;
      if (!verifyText(p.key, `parley ack\n${address}\n${p.id}\n${p.name}`, String(p.sig))) return;
      acks.delete(String(p.id));
      saveContact(from, String(p.name), p.key);
      wait.resolve(String(p.name));
    } else if (p.kind === 'msg') {
      void receive(from, p).catch((err) => log(`a message from ${from} was dropped:`, explain(err)));
    }
  }

  async function receive(from: string, p: any) {
    if (!isSavedKey(from, p.key)) throw new Error('it is signed by a different key than this address had before');
    if (!verifyText(p.key, `parley message\n${address}\n${p.eph}\n${p.box}`, String(p.sig))) {
      throw new Error('the signature does not check out');
    }
    const inner = JSON.parse(openFor(me, String(p.eph), String(p.box)));
    const id = String(inner.id);
    const name = String(inner.name);
    if (!seen.has(id)) {
      seen.add(id);
      const verified = verify(inner.att, p.key, from);
      saveContact(from, name, p.key);
      const m: Incoming = { id, from: { name, address: from, verified }, text: String(inner.text), at: String(inner.at) };
      record({ dir: 'in', ...m });
      await onMessage(m);
    }
    relaySend(from, `ack:${id}`, {
      v: 2,
      kind: 'ack',
      key: me.publicKey,
      id,
      name: me.name,
      sig: signText(me, `parley ack\n${from}\n${id}\n${me.name}`),
    });
  }

  function askKey(to: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const waits = keyWaits.get(to) ?? [];
      waits.push({ resolve, reject });
      keyWaits.set(to, waits);
      if (waits.length === 1) {
        try {
          relaySend(to, `key:${to}`, { v: 2, kind: 'key?', key: me.publicKey });
        } catch (err) {
          keyWaits.delete(to);
          return reject(err);
        }
      }
      setTimeout(() => {
        const left = keyWaits.get(to);
        if (!left?.length) return;
        keyWaits.delete(to);
        for (const w of left) w.reject(new Error(`${to} did not answer`));
      }, ANSWER_MS);
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
    async send(to: string, text: string): Promise<string> {
      if (text.length > TEXT_MAX) throw new Error(`a message is at most ${TEXT_MAX} characters`);
      if (to === address) throw new Error("that is this session's own address");
      try {
        const key = keyOf(to) ?? (await askKey(to));
        const id = randomBytes(9).toString('base64url');
        const at = new Date().toISOString();
        const { eph, box } = sealTo(key, JSON.stringify({ id, name: me.name, text, at, att: account.att() }));
        const name = await new Promise<string>((resolve, reject) => {
          acks.set(id, { to, resolve, reject });
          setTimeout(() => {
            if (acks.delete(id)) reject(new Error(`${to} did not confirm it got the message`));
          }, ANSWER_MS);
          try {
            relaySend(to, `msg:${id}`, { v: 2, kind: 'msg', key: me.publicKey, eph, box, sig: signText(me, `parley message\n${to}\n${eph}\n${box}`) });
          } catch (err) {
            acks.delete(id);
            reject(err);
          }
        });
        record({ dir: 'out', id, to: { name, address: to }, text, at });
        return name;
      } catch (err) {
        if (err instanceof Offline && err.message === 'not online') {
          throw new Error(`${to} is not online: no Claude Code session with that parley name is open right now`);
        }
        throw err;
      }
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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { readAttestation } from './attest';
import { addressOf, verifyText } from './crypto';
import { Mail, OPKS_LOW } from './mail';

export const RELAY_AUTH = 'parley relay auth ';

const HELLO_MS = 10_000;
const MAX_CONNECTIONS = 500;
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 300;
const MAX_BYTES_PER_WINDOW = 4 * 1024 * 1024;
export const MAX_PER_IP = 100;
const MAX_PER_ACCOUNT = 50;
const TAKES_WINDOW_MS = 3600_000;
export const TAKES_MAX = 60;
export const TAKES_PER_ID = 5;
const NEEDS_ACCOUNT = 'this relay needs a parley account: update parley and link this name';

type Conn = {
  nonce: string;
  ip: string;
  ipCounted?: boolean;
  address?: string;
  publicKey?: string;
  sub?: string;
  windowStart: number;
  count: number;
  bytes: number;
  takes?: { start: number; total: number; perId: Map<string, number> };
  helloTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

// Every relay dials every other and sends over the link it dialled.
export type Peering = {
  port: number;
  hostname: string;
  secret: string;
  self: string;
  discover: () => Promise<string[]>;
};

type PeerConn = { peer?: string; helloTimer?: ReturnType<typeof setTimeout> };

const PEER_DIAL_MS = 3000;
const TALK_SHARE_MS = 60_000;
const TALK_KEEP_MS = 7 * 24 * 3600_000;
const MAX_TALKS = 50;
const TALK_SAVE_MS = 1000;

const sameSecret = (a: string, b: unknown) =>
  typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const log = (...parts: unknown[]) =>
  console.log(new Date().toISOString(), ...parts);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const bump = (counts: Map<string, number>, key: string, by: number) => {
  const n = (counts.get(key) ?? 0) + by;
  if (n > 0) counts.set(key, n);
  else counts.delete(key);
};

export type RelayOptions = {
  issuers?: string[];
  peers?: Peering;
  talksFile?: string;
  // Set on one relay; the others pass mail to it. Unset on a lone relay keeps mail in memory.
  mailDir?: string;
};

export function startRelay(port: number, hostname: string, opts: RelayOptions = {}) {
  const issuers = opts.issuers ?? [];
  const accounts = issuers.length > 0;
  const online = new Map<string, ServerWebSocket<Conn>>();
  const perIp = new Map<string, number>();
  const perSub = new Map<string, number>();
  let connections = 0;
  const remote = new Map<string, string>();
  const links = new Map<string, WebSocket>();
  const dialling = new Set<string>();
  const own = new Set<string>();
  const mail = opts.mailDir || !opts.peers ? new Mail(opts.mailDir, log) : undefined;
  let keeper: string | undefined;

  const talks = new Map<string, Map<string, number>>();
  const { talksFile } = opts;
  let talkSave: ReturnType<typeof setTimeout> | undefined;

  function dropOldTalks() {
    const cutoff = Date.now() - TALK_KEEP_MS;
    for (const [id, peers] of talks) {
      for (const [other, at] of peers) if (at < cutoff) peers.delete(other);
      if (!peers.size) talks.delete(id);
    }
  }

  function saveTalks() {
    if (!talksFile) return;
    clearTimeout(talkSave);
    talkSave = undefined;
    try {
      const part = `${talksFile}.part`;
      writeFileSync(part, JSON.stringify([...talks].map(([id, peers]) => [id, [...peers]])), { mode: 0o600 });
      chmodSync(part, 0o600);
      renameSync(part, talksFile);
    } catch (err) {
      log(`could not save who talked with whom to ${talksFile}:`, err instanceof Error ? err.message : err);
    }
  }

  if (talksFile && existsSync(talksFile)) {
    try {
      for (const [id, peers] of JSON.parse(readFileSync(talksFile, 'utf8')) as [string, [string, number][]][]) talks.set(id, new Map(peers));
      dropOldTalks();
    } catch (err) {
      log(`could not read who talked with whom from ${talksFile}:`, err instanceof Error ? err.message : err);
    }
  }

  function toPeers(frame: object) {
    const text = JSON.stringify(frame);
    for (const link of links.values()) link.send(text);
  }

  const toKeeper = (frame: object): boolean => {
    const link = keeper && links.get(keeper);
    if (!link) return false;
    link.send(JSON.stringify(frame));
    return true;
  };

  function talked(a: string, b: string, share: boolean) {
    if (a === b) return;
    const now = Date.now();
    const known = now - (talks.get(a)?.get(b) ?? 0) < TALK_SHARE_MS;
    for (const [id, other] of [[a, b], [b, a]] as const) {
      const peers = talks.get(id) ?? new Map<string, number>();
      talks.set(id, peers);
      peers.delete(other);
      peers.set(other, now);
      if (peers.size > MAX_TALKS) peers.delete(peers.keys().next().value as string);
    }
    if (talksFile) talkSave ??= setTimeout(saveTalks, TALK_SAVE_MS);
    if (share && !known) toPeers({ t: 'talk', a, b });
  }

  const sweep = setInterval(() => {
    dropOldTalks();
    saveTalks();
    mail?.sweep();
  }, 3600_000);

  function forget(peer: string) {
    for (const [address, at] of remote) if (at === peer) remote.delete(address);
  }

  function arrived(address: string) {
    if (!mail?.has(address)) return;
    const frames = mail.arrived(address);
    const to = online.get(address);
    if (to) {
      to.send(JSON.stringify({ t: 'prekeys', left: mail.left(address) }));
      for (const f of frames) to.send(JSON.stringify({ t: 'recv', from: f.from, payload: f.payload, held: { seq: f.seq, at: f.at } }));
      return;
    }
    const link = links.get(remote.get(address) ?? '');
    if (!link) return;
    link.send(JSON.stringify({ t: 'mail', op: 'left', to: address, left: mail.left(address) }));
    for (const f of frames) link.send(JSON.stringify({ t: 'fwd', to: address, from: f.from, payload: f.payload, held: { seq: f.seq, at: f.at } }));
  }

  function tellLeft(address: string, left: number) {
    const to = online.get(address);
    if (to) to.send(JSON.stringify({ t: 'prekeys', left }));
    else links.get(remote.get(address) ?? '')?.send(JSON.stringify({ t: 'mail', op: 'left', to: address, left }));
  }

  function elsewhere(address: string, peer: string) {
    remote.set(address, peer);
    online.get(address)?.close(4002, 'replaced by a newer connection');
    arrived(address);
  }

  function dial(peer: string, secret: string, self: string) {
    dialling.add(peer);
    const link = new WebSocket(peer);
    link.onopen = () => {
      link.send(JSON.stringify({ t: 'peer', secret, from: self, keeps: mail !== undefined }));
      link.send(JSON.stringify({ t: 'ids', addresses: [...online.keys()] }));
      links.set(peer, link);
      log('peer link up', peer);
    };
    link.onclose = (ev) => {
      dialling.delete(peer);
      if (ev.code === 4004) own.add(peer);
      if (links.get(peer) === link) {
        links.delete(peer);
        log('peer link down', peer);
      }
    };
    link.onerror = () => {};
  }

  function route(from: string, to: string, ref: unknown, payload: unknown, hold: boolean, bytes: number): { t: string; why?: string } | undefined {
    const target = online.get(to);
    if (target) {
      target.send(JSON.stringify({ t: 'recv', from, payload }));
      talked(from, to, true);
      return undefined;
    }
    const link = links.get(remote.get(to) ?? '');
    if (link) {
      link.send(JSON.stringify({ t: 'fwd', to, from, ref, payload }));
      return undefined;
    }
    if (!hold) return { t: 'undeliverable' };
    if (mail) {
      const kept = mail.hold(from, to, payload, bytes);
      if (kept === 'held') {
        talked(from, to, true);
        return { t: 'held' };
      }
      return { t: 'undeliverable', why: kept };
    }
    if (toKeeper({ t: 'mail', op: 'hold', from, to, ref, payload, bytes })) return undefined;
    return { t: 'undeliverable', why: 'no mailbox' };
  }

  function fromPeer(ws: ServerWebSocket<PeerConn>, msg: any, secret: string, self: string) {
    if (!ws.data.peer) {
      if (msg.t !== 'peer' || !sameSecret(secret, msg.secret) || typeof msg.from !== 'string') {
        ws.close(4001, 'bad peer hello');
        return;
      }
      // A relay that took itself for a peer would put every name it holds offline.
      if (msg.from === self) {
        ws.close(4004, 'this is the same relay');
        return;
      }
      clearTimeout(ws.data.helloTimer);
      ws.data.peer = msg.from;
      if (msg.keeps === true && !mail) keeper = msg.from;
      return;
    }
    const { peer } = ws.data;
    if (msg.t === 'ids' && Array.isArray(msg.addresses)) {
      forget(peer);
      for (const address of msg.addresses) elsewhere(String(address), peer);
    } else if (msg.t === 'on' && typeof msg.address === 'string') {
      elsewhere(msg.address, peer);
    } else if (msg.t === 'off' && typeof msg.address === 'string') {
      if (remote.get(msg.address) === peer) remote.delete(msg.address);
    } else if (msg.t === 'fwd' && typeof msg.to === 'string' && typeof msg.from === 'string') {
      const target = online.get(msg.to);
      if (target) {
        target.send(JSON.stringify({ t: 'recv', from: msg.from, payload: msg.payload, ...(msg.held ? { held: msg.held } : {}) }));
        talked(msg.from, msg.to, true);
      } else links.get(peer)?.send(JSON.stringify({ t: 'nack', to: msg.to, from: msg.from, ref: msg.ref }));
    } else if (msg.t === 'nack' && typeof msg.to === 'string' && typeof msg.from === 'string') {
      if (remote.get(msg.to) === peer) remote.delete(msg.to);
      online.get(msg.from)?.send(JSON.stringify({ t: 'undeliverable', to: msg.to, ref: msg.ref }));
    } else if (msg.t === 'talk' && typeof msg.a === 'string' && typeof msg.b === 'string') {
      talked(msg.a, msg.b, false);
    } else if (msg.t === 'mail' && typeof msg.op === 'string') {
      fromPeerMail(peer, msg);
    }
  }

  function fromPeerMail(peer: string, msg: any) {
    const back = (frame: object) => links.get(peer)?.send(JSON.stringify(frame));
    if (mail) {
      if (msg.op === 'hold' && typeof msg.from === 'string' && typeof msg.to === 'string') {
        const out = route(msg.from, msg.to, msg.ref, msg.payload, true, Number(msg.bytes) || 0);
        if (out) back({ t: 'mail', op: out.t, to: msg.from, target: msg.to, ref: msg.ref, why: out.why });
      } else if (msg.op === 'put' && typeof msg.from === 'string' && typeof msg.publicKey === 'string') {
        try {
          back({ t: 'mail', op: 'left', to: msg.from, left: mail.put(msg.from, msg.publicKey, msg.spk, msg.opks) });
        } catch (err) {
          back({ t: 'mail', op: 'error', to: msg.from, error: err instanceof Error ? err.message : String(err) });
        }
      } else if (msg.op === 'take' && typeof msg.from === 'string' && typeof msg.id === 'string') {
        const got = mail.take(msg.id);
        back({ t: 'mail', op: 'bundle', to: msg.from, id: msg.id, ...(got?.bundle ?? {}) });
        if (got && got.left < OPKS_LOW) tellLeft(msg.id, got.left);
      } else if (msg.op === 'took' && typeof msg.from === 'string') {
        mail.took(msg.from, Number(msg.seq));
      }
      return;
    }
    const to = typeof msg.to === 'string' ? online.get(msg.to) : undefined;
    if (!to) return;
    if (msg.op === 'held' || msg.op === 'undeliverable') to.send(JSON.stringify({ t: msg.op, to: msg.target, ref: msg.ref, ...(msg.why ? { why: msg.why } : {}) }));
    else if (msg.op === 'left') to.send(JSON.stringify({ t: 'prekeys', left: msg.left }));
    else if (msg.op === 'error') to.send(JSON.stringify({ t: 'prekeys', error: msg.error }));
    else if (msg.op === 'bundle') {
      const { t: _t, op: _op, to: _to, ...rest } = msg;
      to.send(JSON.stringify({ t: 'prekeys', ...rest }));
    }
  }

  let peerServer: ReturnType<typeof Bun.serve> | undefined;
  let dialTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.peers) {
    const { secret, self, discover } = opts.peers;
    if (!secret) throw new Error('relays that peer need a shared secret');
    peerServer = Bun.serve({
      port: opts.peers.port,
      hostname: opts.peers.hostname,
      fetch(req, server) {
        if (server.upgrade(req, { data: {} })) return undefined;
        return new Response('parley relay peers\n');
      },
      websocket: {
        data: {} as PeerConn,
        maxPayloadLength: 320 * 1024,
        open(ws) {
          ws.data.helloTimer = setTimeout(() => ws.close(4001, 'no peer hello'), HELLO_MS);
        },
        message(ws, raw) {
          try {
            fromPeer(ws, JSON.parse(String(raw)), secret, self);
          } catch {
            ws.close(4000, 'malformed message');
          }
        },
        close(ws) {
          clearTimeout(ws.data.helloTimer);
          if (ws.data.peer) {
            forget(ws.data.peer);
            if (keeper === ws.data.peer) keeper = undefined;
          }
        },
      },
    });
    const dialAll = () =>
      discover().then(
        (found) => {
          for (const peer of found) if (peer !== self && !own.has(peer) && !links.has(peer) && !dialling.has(peer)) dial(peer, secret, self);
        },
        (err) => log('could not look up peer relays:', err instanceof Error ? err.message : err),
      );
    void dialAll();
    dialTimer = setInterval(dialAll, PEER_DIAL_MS);
  }

  function admit(ws: ServerWebSocket<Conn>, att: unknown, publicKey: string): boolean {
    if (!accounts) return true;
    if (typeof att !== 'string' || !att) {
      ws.close(4003, NEEDS_ACCOUNT);
      return false;
    }
    let proof;
    try {
      proof = readAttestation(att, issuers, publicKey);
    } catch (err) {
      ws.close(4003, err instanceof Error ? err.message : String(err));
      return false;
    }
    if (ws.data.sub === undefined) {
      if ((perSub.get(proof.sub) ?? 0) >= MAX_PER_ACCOUNT) {
        ws.close(4029, 'too many connections for this account');
        return false;
      }
      ws.data.sub = proof.sub;
      bump(perSub, proof.sub, 1);
    } else if (ws.data.sub !== proof.sub) {
      ws.close(4003, 'the account proof is for another account');
      return false;
    }
    clearTimeout(ws.data.expiryTimer);
    ws.data.expiryTimer = setTimeout(
      () => ws.close(4003, 'the account proof has expired'),
      proof.exp * 1000 - Date.now(),
    );
    return true;
  }

  function hello(ws: ServerWebSocket<Conn>, msg: any) {
    if (
      msg.t !== 'hello' ||
      typeof msg.publicKey !== 'string' ||
      typeof msg.sig !== 'string' ||
      !verifyText(msg.publicKey, RELAY_AUTH + ws.data.nonce, msg.sig)
    ) {
      ws.close(4001, 'bad hello');
      return;
    }
    if (!admit(ws, msg.att, msg.publicKey)) return;
    const address = addressOf(msg.publicKey);
    clearTimeout(ws.data.helloTimer);
    online.get(address)?.close(4002, 'replaced by a newer connection');
    online.set(address, ws);
    remote.delete(address);
    toPeers({ t: 'on', address });
    ws.data.address = address;
    ws.data.publicKey = msg.publicKey;
    log('online', address);
    ws.send(JSON.stringify({ t: 'ready', address }));
    arrived(address);
  }

  function mayTake(ws: ServerWebSocket<Conn>, id: string): boolean {
    const now = Date.now();
    let t = ws.data.takes;
    if (!t || now - t.start > TAKES_WINDOW_MS) t = ws.data.takes = { start: now, total: 0, perId: new Map() };
    if (t.total >= TAKES_MAX || (t.perId.get(id) ?? 0) >= TAKES_PER_ID) return false;
    t.total++;
    bump(t.perId, id, 1);
    return true;
  }

  function prekeys(ws: ServerWebSocket<Conn>, msg: any) {
    const me = ws.data.address!;
    if (typeof msg.id === 'string') {
      if (!mayTake(ws, msg.id)) {
        ws.send(JSON.stringify({ t: 'prekeys', id: msg.id, error: 'too many prekeys taken; try again in an hour' }));
        return;
      }
      if (mail) {
        const got = mail.take(msg.id);
        ws.send(JSON.stringify({ t: 'prekeys', id: msg.id, ...(got?.bundle ?? {}) }));
        if (got && got.left < OPKS_LOW) tellLeft(msg.id, got.left);
      } else if (!toKeeper({ t: 'mail', op: 'take', from: me, id: msg.id })) {
        ws.send(JSON.stringify({ t: 'prekeys', id: msg.id }));
      }
      return;
    }
    if (mail) {
      try {
        ws.send(JSON.stringify({ t: 'prekeys', left: mail.put(me, ws.data.publicKey!, msg.spk, msg.opks) }));
      } catch (err) {
        ws.send(JSON.stringify({ t: 'prekeys', error: err instanceof Error ? err.message : String(err) }));
      }
    } else if (!toKeeper({ t: 'mail', op: 'put', from: me, publicKey: ws.data.publicKey, spk: msg.spk, opks: msg.opks })) {
      ws.send(JSON.stringify({ t: 'prekeys', error: 'this relay keeps no mail' }));
    }
  }

  function clientIp(req: Request, peer: string): string {
    if (!LOOPBACK.has(peer)) return peer;
    const hops = req.headers.get('x-forwarded-for')?.split(',');
    return hops?.[hops.length - 1]?.trim() || peer;
  }

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      // Who talked with whom is for a caller on this machine only.
      if (req.method === 'POST' && new URL(req.url).pathname === '/online') {
        const local = LOOPBACK.has(clientIp(req, server.requestIP(req)?.address ?? ''));
        return req.json().then(
          (body: any) => {
            const ids: string[] = Array.isArray(body?.ids) ? body.ids.slice(0, 500).map(String) : [];
            const answer: { online: string[]; reachable: string[]; talks?: Record<string, [string, number][]> } = {
              online: ids.filter((id) => online.has(id) || links.has(remote.get(id) ?? '')),
              reachable: mail ? ids.filter((id) => mail.has(id)) : [],
            };
            if (local) answer.talks = Object.fromEntries(ids.filter((id) => talks.has(id)).map((id) => [id, [...talks.get(id)!].reverse()]));
            return Response.json(answer);
          },
          () => new Response('send {"ids": [...]}\n', { status: 400 }),
        );
      }
      if (connections >= MAX_CONNECTIONS) {
        return new Response('relay is full\n', { status: 503 });
      }
      const peer = server.requestIP(req)?.address;
      if (!peer) return new Response('no peer address\n', { status: 400 });
      const data: Conn = {
        nonce: randomBytes(24).toString('base64url'),
        ip: clientIp(req, peer),
        windowStart: Date.now(),
        count: 0,
        bytes: 0,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response('parley relay\n');
    },
    websocket: {
      data: {} as Conn,
      maxPayloadLength: 256 * 1024,
      open(ws) {
        connections++;
        if (accounts) {
          if ((perIp.get(ws.data.ip) ?? 0) >= MAX_PER_IP) {
            ws.close(4029, 'too many connections from this address');
            return;
          }
          ws.data.ipCounted = true;
          bump(perIp, ws.data.ip, 1);
        }
        ws.data.helloTimer = setTimeout(() => ws.close(4001, 'no hello'), HELLO_MS);
        ws.send(JSON.stringify({ t: 'challenge', nonce: ws.data.nonce }));
      },
      message(ws, raw) {
        const now = Date.now();
        if (now - ws.data.windowStart > WINDOW_MS) {
          ws.data.windowStart = now;
          ws.data.count = 0;
          ws.data.bytes = 0;
        }
        const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
        ws.data.bytes += bytes;
        if (ws.data.bytes > MAX_BYTES_PER_WINDOW) {
          ws.close(4029, 'too much data');
          return;
        }
        if (++ws.data.count > MAX_PER_WINDOW) {
          ws.close(4008, 'too many messages');
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
          if (!ws.data.address) return hello(ws, msg);
        } catch {
          ws.close(4000, 'malformed message');
          return;
        }
        if (msg.t === 'renew') {
          admit(ws, msg.att, ws.data.publicKey!);
          return;
        }
        if (msg.t === 'prekeys') return prekeys(ws, msg);
        if (msg.t === 'took') {
          if (mail) mail.took(ws.data.address, Number(msg.seq));
          else toKeeper({ t: 'mail', op: 'took', from: ws.data.address, seq: msg.seq });
          return;
        }
        if (msg.t !== 'send' || typeof msg.to !== 'string') return;
        const out = route(ws.data.address, msg.to, msg.ref, msg.payload, msg.hold === true, bytes);
        if (out) ws.send(JSON.stringify({ t: out.t, to: msg.to, ref: msg.ref, ...(out.why ? { why: out.why } : {}) }));
      },
      close(ws) {
        connections--;
        clearTimeout(ws.data.helloTimer);
        clearTimeout(ws.data.expiryTimer);
        if (ws.data.ipCounted) bump(perIp, ws.data.ip, -1);
        if (ws.data.sub !== undefined) bump(perSub, ws.data.sub, -1);
        const { address } = ws.data;
        if (address && online.get(address) === ws) {
          online.delete(address);
          toPeers({ t: 'off', address });
          log('offline', address);
        }
      },
    },
  });
  const stop = server.stop.bind(server);
  server.stop = (closeActive?: boolean) => {
    clearInterval(dialTimer);
    clearInterval(sweep);
    if (talkSave) saveTalks();
    mail?.stop();
    for (const link of links.values()) link.close();
    void peerServer?.stop(closeActive);
    return stop(closeActive);
  };
  return server;
}

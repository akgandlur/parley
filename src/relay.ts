import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { readAttestation } from './attest';
import { addressOf, verifyText } from './crypto';

export const RELAY_AUTH = 'parley relay auth ';

const HELLO_MS = 10_000;
const MAX_CONNECTIONS = 500;
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 300;
const MAX_BYTES_PER_WINDOW = 4 * 1024 * 1024;
export const MAX_PER_IP = 100;
const MAX_PER_ACCOUNT = 50;
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
  helloTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

// Relays that share one address pass messages between them, so two names
// reach each other whichever relay each is connected to. Every relay dials
// every other and sends over the link it dialled; `self` and what `discover`
// returns are the ws URLs the relays reach each other at.
export type Peering = {
  port: number;
  hostname: string;
  secret: string;
  self: string;
  discover: () => Promise<string[]>;
};

type PeerConn = { peer?: string; helloTimer?: ReturnType<typeof setTimeout> };

const PEER_DIAL_MS = 3000;

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

// The relay only learns who is online and who is talking to whom. Payloads
// are signed and sealed between the two ends before they get here.
export function startRelay(port: number, hostname: string, opts: { issuers?: string[]; peers?: Peering } = {}) {
  const issuers = opts.issuers ?? [];
  const accounts = issuers.length > 0;
  const online = new Map<string, ServerWebSocket<Conn>>();
  const perIp = new Map<string, number>();
  const perSub = new Map<string, number>();
  let connections = 0;
  // Which peer relay each name elsewhere is connected to, and the open links
  // this relay dialled.
  const remote = new Map<string, string>();
  const links = new Map<string, WebSocket>();
  const dialling = new Set<string>();
  // Addresses that turned out to be this relay under another spelling.
  const own = new Set<string>();

  function toPeers(frame: object) {
    const text = JSON.stringify(frame);
    for (const link of links.values()) link.send(text);
  }

  function forget(peer: string) {
    for (const [address, at] of remote) if (at === peer) remote.delete(address);
  }

  // A name that connects to another relay has left this one.
  function elsewhere(address: string, peer: string) {
    remote.set(address, peer);
    online.get(address)?.close(4002, 'replaced by a newer connection');
  }

  function dial(peer: string, secret: string, self: string) {
    dialling.add(peer);
    const link = new WebSocket(peer);
    link.onopen = () => {
      link.send(JSON.stringify({ t: 'peer', secret, from: self }));
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
      if (target) target.send(JSON.stringify({ t: 'recv', from: msg.from, payload: msg.payload }));
      else links.get(peer)?.send(JSON.stringify({ t: 'nack', to: msg.to, from: msg.from, ref: msg.ref }));
    } else if (msg.t === 'nack' && typeof msg.to === 'string' && typeof msg.from === 'string') {
      if (remote.get(msg.to) === peer) remote.delete(msg.to);
      online.get(msg.from)?.send(JSON.stringify({ t: 'undeliverable', to: msg.to, ref: msg.ref }));
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
          if (ws.data.peer) forget(ws.data.peer);
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
      // Which of these ids have a session open, here or on a peer relay. It
      // tells no more than sending to an id does.
      if (req.method === 'POST' && new URL(req.url).pathname === '/online') {
        return req.json().then(
          (body: any) => {
            const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 500).map(String) : [];
            return Response.json({ online: ids.filter((id: string) => online.has(id) || links.has(remote.get(id) ?? '')) });
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
        ws.data.bytes += typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
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
        if (msg.t !== 'send' || typeof msg.to !== 'string') return;
        const target = online.get(msg.to);
        if (!target) {
          const link = links.get(remote.get(msg.to) ?? '');
          if (link) {
            link.send(JSON.stringify({ t: 'fwd', to: msg.to, from: ws.data.address, ref: msg.ref, payload: msg.payload }));
            return;
          }
          ws.send(
            JSON.stringify({ t: 'undeliverable', to: msg.to, ref: msg.ref }),
          );
          return;
        }
        target.send(
          JSON.stringify({
            t: 'recv',
            from: ws.data.address,
            payload: msg.payload,
          }),
        );
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
    for (const link of links.values()) link.close();
    void peerServer?.stop(closeActive);
    return stop(closeActive);
  };
  return server;
}

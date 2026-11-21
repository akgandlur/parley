import { randomBytes } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { readAttestation } from './attest';
import { addressOf, verifyText } from './crypto';

export const RELAY_AUTH = 'parley relay auth ';

const HELLO_MS = 10_000;
const MAX_CONNECTIONS = 500;
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 300;
const MAX_BYTES_PER_WINDOW = 4 * 1024 * 1024;
const MAX_PER_IP = 20;
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
export function startRelay(port: number, hostname: string, opts: { issuers?: string[] } = {}) {
  const issuers = opts.issuers ?? [];
  const accounts = issuers.length > 0;
  const online = new Map<string, ServerWebSocket<Conn>>();
  const perIp = new Map<string, number>();
  const perSub = new Map<string, number>();
  let connections = 0;

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

  return Bun.serve({
    port,
    hostname,
    fetch(req, server) {
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
          log('offline', address);
        }
      },
    },
  });
}

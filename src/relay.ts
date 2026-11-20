import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { addressOf, normalizeAddress, verifyText } from './crypto';

export const RELAY_AUTH = 'parley relay auth ';
export const NOT_ALLOWED = 4003;

const HELLO_MS = 10_000;
const MAX_CONNECTIONS = 500;
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 300;

type Conn = {
  nonce: string;
  address?: string;
  windowStart: number;
  count: number;
  helloTimer?: ReturnType<typeof setTimeout>;
};

const log = (...parts: unknown[]) =>
  console.log(new Date().toISOString(), ...parts);

function readAllowed(file: string): Set<string> {
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
      .map(normalizeAddress),
  );
}

// The relay only learns who is online and who is talking to whom. Payloads
// are signed and sealed between the two ends before they get here.
export function startRelay(port: number, hostname: string, allowFile?: string) {
  const online = new Map<string, ServerWebSocket<Conn>>();
  let connections = 0;
  if (allowFile) log(`allowing ${readAllowed(allowFile).size} addresses from ${allowFile}`);

  // Read on every hello so an address can be added without a restart. A list
  // that cannot be read lets nobody in.
  function isAllowed(address: string): boolean {
    if (!allowFile) return true;
    try {
      return readAllowed(allowFile).has(address);
    } catch (err) {
      log('cannot read the allow list:', err instanceof Error ? err.message : err);
      return false;
    }
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
    const address = addressOf(msg.publicKey);
    if (!isAllowed(address)) {
      log('refused', address);
      ws.close(NOT_ALLOWED, 'this address is not on the allow list yet; send it to whoever runs the relay');
      return;
    }
    clearTimeout(ws.data.helloTimer);
    online.get(address)?.close(4002, 'replaced by a newer connection');
    online.set(address, ws);
    ws.data.address = address;
    log('online', address);
    ws.send(JSON.stringify({ t: 'ready', address }));
  }

  return Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      if (connections >= MAX_CONNECTIONS) {
        return new Response('relay is full\n', { status: 503 });
      }
      const data: Conn = {
        nonce: randomBytes(24).toString('base64url'),
        windowStart: Date.now(),
        count: 0,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response('parley relay\n');
    },
    websocket: {
      data: {} as Conn,
      maxPayloadLength: 256 * 1024,
      open(ws) {
        connections++;
        ws.data.helloTimer = setTimeout(() => ws.close(4001, 'no hello'), HELLO_MS);
        ws.send(JSON.stringify({ t: 'challenge', nonce: ws.data.nonce }));
      },
      message(ws, raw) {
        const now = Date.now();
        if (now - ws.data.windowStart > WINDOW_MS) {
          ws.data.windowStart = now;
          ws.data.count = 0;
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
        const { address } = ws.data;
        if (address && online.get(address) === ws) {
          online.delete(address);
          log('offline', address);
        }
      },
    },
  });
}

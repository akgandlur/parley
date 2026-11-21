import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './home';
import { VERSION, type View } from './types';

export type NodeInfo = { port: number; token: string; pid: number; version?: string };

// Three ways to be running: from source (this file sits beside cli.ts), as
// the one-file bundle (this file IS the entry), or as the compiled binary
// (no script; the executable is the entry).
const here = fileURLToPath(import.meta.url);
const SELF = here.startsWith('/$bunfs')
  ? []
  : here.endsWith('ipc.ts')
    ? [join(dirname(here), 'cli.ts')]
    : [here];

export const selfCommand = (verb: string) =>
  [process.execPath, ...SELF, verb].map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Unreachable extends Error {}

function send(
  info: NodeInfo,
  op: string,
  args: object,
  timeoutMs: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(info.port, '127.0.0.1');
    let reply = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the parley node did not answer "${op}" in time`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(JSON.stringify({ token: info.token, op, args }) + '\n'),
    );
    socket.on('data', (chunk) => (reply += chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ECONNREFUSED' ? new Unreachable() : err);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      const res = JSON.parse(reply);
      if (res.ok) resolve(res.result);
      else reject(new Error(res.error));
    });
  });
}

async function startNode(home: string): Promise<NodeInfo> {
  readJson(home, 'identity.json');
  const log = openSync(join(home, 'daemon.log'), 'a');
  spawn(process.execPath, [...SELF, 'daemon', '--home', home], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (!existsSync(join(home, 'node.json'))) continue;
    const info = readJson<NodeInfo>(home, 'node.json');
    try {
      await send(info, 'ping', {}, 2000);
      return info;
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
    }
  }
  throw new Error(
    `the parley node did not start; see ${join(home, 'daemon.log')}`,
  );
}

function older(running: string | undefined, mine: string): boolean {
  const [a, b] = [running ?? '0', mine].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    const [x, y] = [a?.[i] ?? 0, b?.[i] ?? 0];
    if (x !== y) return x < y;
  }
  return false;
}

// A plugin update leaves the previous version's node running, and it would
// stay until the machine restarts. Stop it so this version starts in its
// place, but never under a call.
async function retire(home: string, info: NodeInfo): Promise<boolean> {
  if (!older(info.version, VERSION)) return false;
  const { session } = (await send(info, 'status', {}, 5000)) as View;
  if (session && session.state !== 'ended') return false;
  await send(info, 'stop', {}, 5000);
  for (let i = 0; i < 50 && existsSync(join(home, 'node.json')); i++) {
    await sleep(100);
  }
  if (existsSync(join(home, 'node.json'))) {
    throw new Error(`the older parley node (pid ${info.pid}) did not stop`);
  }
  return true;
}

export async function request<T>(
  op: string,
  args: object,
  opts: { home: string; timeoutMs?: number; start?: boolean },
): Promise<T> {
  const { home } = opts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (existsSync(join(home, 'node.json'))) {
    try {
      const info = readJson<NodeInfo>(home, 'node.json');
      // A wait is how an agent hears that its call ended; a replaced node
      // would have nothing to tell it.
      const keep = opts.start === false || op === 'wait';
      if (keep || !(await retire(home, info))) {
        return await send(info, op, args, timeoutMs);
      }
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
    }
  }
  if (opts.start === false) throw new Error('the parley node is not running');
  return send(await startNode(home), op, args, timeoutMs);
}

// What a node is doing, without starting one.
export async function peek(home: string): Promise<View | undefined> {
  if (!existsSync(join(home, 'node.json'))) return undefined;
  try {
    return await send(readJson<NodeInfo>(home, 'node.json'), 'status', {}, 5000);
  } catch (err) {
    if (err instanceof Unreachable) return undefined;
    throw err;
  }
}

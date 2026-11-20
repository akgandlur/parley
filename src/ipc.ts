import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, readJson } from './home';

export type NodeInfo = { port: number; token: string; pid: number };

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
  spawn(process.execPath, [...SELF, 'daemon'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, PARLEY_HOME: home },
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

export async function request<T>(
  op: string,
  args: object = {},
  opts: { home?: string; timeoutMs?: number; start?: boolean } = {},
): Promise<T> {
  const home = opts.home ?? HOME;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (existsSync(join(home, 'node.json'))) {
    try {
      const info = readJson<NodeInfo>(home, 'node.json');
      return await send(info, op, args, timeoutMs);
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
    }
  }
  if (opts.start === false) throw new Error('the parley node is not running');
  return send(await startNode(home), op, args, timeoutMs);
}

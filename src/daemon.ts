import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { startAgent, type Agent, type Incoming } from './agent';
import { ROOT, holder, locals, readJson, writeJson, type Local } from './home';
import { selfCommand } from './host';
import { VERSION } from './types';

const INFO = 'daemon.json';
const LOCK = 'daemon.lock';
const LOG_MAX = 1024 * 1024;
const RECONCILE_MS = 2000;
const YIELD_MS = 15_000;
const CALL_MS = 4000;

type Info = { pid: number; token: string; version: string; socket: string; started: string };
export type InboxEntry = { at: string; m?: Incoming; notice?: string };

const explain = (err: unknown) => (err instanceof Error ? err.message : String(err));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A unix socket path is limited to about a hundred bytes.
export function socketPath(): string {
  const tag = createHash('sha256').update(ROOT).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\parley-${tag}` : `/tmp/parley-${tag}.sock`;
}

export function daemonInfo(): Info | undefined {
  if (!existsSync(join(ROOT, INFO))) return undefined;
  try {
    const info = readJson<Info>(ROOT, INFO);
    return alive(info.pid) ? info : undefined;
  } catch {
    return undefined;
  }
}

export function daemonCall(op: string, args: Record<string, unknown> = {}, ms = CALL_MS): Promise<any> {
  const info = daemonInfo();
  if (!info) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: any) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const socket = connect(info.socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.setTimeout(ms, () => socket.destroy());
    socket.on('connect', () => socket.write(JSON.stringify({ token: info.token, op, ...args }) + '\n'));
    socket.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(undefined);
      }
      socket.end();
    });
    socket.on('error', () => finish(undefined));
    socket.on('close', () => finish(undefined));
  });
}

export function ensureDaemon(log: (...parts: unknown[]) => void) {
  if (process.env.PARLEY_DAEMON === 'off' || !locals().length) return;
  const info = daemonInfo();
  if (info?.version === VERSION) return;
  const [command, ...args] = selfCommand();
  const { CLAUDE_CODE_SESSION_ID: _s, CLAUDE_CODE_MESSAGING_SOCKET: _m, CLAUDE_CODE_MESSAGING_TOKEN: _t, ...env } = process.env;
  try {
    const out = openSync(join(ROOT, 'daemon.log'), 'a', 0o600);
    const child = spawn(command as string, [...args, 'daemon'], { detached: true, stdio: ['ignore', out, out], env });
    child.on('error', (err) => log('could not start the parley daemon:', err.message));
    child.unref();
    closeSync(out);
    log(info ? `replacing the parley daemon on ${info.version} with ${VERSION}` : 'starting the parley daemon');
  } catch (err) {
    log('could not start the parley daemon:', explain(err));
  }
}

export function takeInbox(home: string): InboxEntry[] {
  const path = join(home, 'inbox.json');
  if (!existsSync(path)) return [];
  try {
    const entries = readJson<InboxEntry[]>(home, 'inbox.json');
    rmSync(path, { force: true });
    return entries;
  } catch (err) {
    rmSync(path, { force: true });
    return [{ at: new Date().toISOString(), notice: `parley: what waited for this name could not be read: ${explain(err)}` }];
  }
}

export async function runDaemon() {
  const log = (...parts: unknown[]) => {
    console.log(new Date().toISOString(), ...parts);
  };
  const lock = join(ROOT, LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch {
      const pid = Number(readFileSync(lock, 'utf8').trim());
      if (pid && alive(pid)) {
        const other = daemonInfo();
        if (other?.version === VERSION || !other) {
          log(`a parley daemon is already running (pid ${pid})`);
          return;
        }
        await daemonCall('stop');
        for (let n = 0; n < 50 && alive(pid); n++) await new Promise((r) => setTimeout(r, 100));
      }
      rmSync(lock, { force: true });
    }
  }
  try {
    if (statSync(join(ROOT, 'daemon.log')).size > LOG_MAX) truncateSync(join(ROOT, 'daemon.log'), 0);
  } catch {}

  const token = createHash('sha256').update(String(process.pid) + Math.random()).digest('base64url');
  const sock = socketPath();
  if (process.platform !== 'win32') rmSync(sock, { force: true });
  const agents = new Map<string, { local: Local; agent: Agent }>();
  const yielded = new Map<string, number>();
  let stopping = false;

  const append = (home: string, entry: InboxEntry) => {
    const path = join(home, 'inbox.json');
    const entries = existsSync(path) ? readJson<InboxEntry[]>(home, 'inbox.json') : [];
    entries.push(entry);
    writeJson(home, 'inbox.json', entries, true);
  };

  async function hold(local: Local) {
    const tag = `"${local.name}" (${local.address})`;
    const agent = await startAgent(
      local.home,
      (...parts) => log(`${local.address}:`, ...parts),
      async (m) => {
        append(local.home, { at: new Date().toISOString(), m });
        log(`held a message from ${m.from.address} for ${tag}`);
        return 'held';
      },
      (notice) => append(local.home, { at: new Date().toISOString(), notice }),
    );
    agents.set(local.address, { local, agent });
    log(`holding ${tag}`);
  }

  async function letGo(address: string, why: string) {
    const held = agents.get(address);
    if (!held) return;
    agents.delete(address);
    held.agent.close();
    log(`let go of "${held.local.name}" (${address}): ${why}`);
  }

  // Removing daemon.json ends the daemon.
  const stillMine = () => {
    try {
      return existsSync(ROOT) && readJson<Info>(ROOT, INFO).pid === process.pid;
    } catch {
      return false;
    }
  };

  let busy = false;
  async function reconcile() {
    if (busy || stopping) return;
    if (!stillMine()) return stop('its record is gone');
    busy = true;
    try {
      const here = locals();
      for (const local of here) {
        const taken = holder(local.address) !== undefined;
        const mine = agents.has(local.address);
        if (taken && mine) await letGo(local.address, 'a session holds it');
        else if (!taken && !mine && Date.now() - (yielded.get(local.address) ?? 0) > YIELD_MS) {
          try {
            await hold(local);
          } catch (err) {
            log(`could not hold "${local.name}" (${local.address}):`, explain(err));
            yielded.set(local.address, Date.now());
          }
        }
      }
      for (const address of agents.keys()) if (!here.some((l) => l.address === address)) await letGo(address, 'the name is gone');
    } finally {
      busy = false;
    }
  }

  async function stop(why: string) {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    for (const address of [...agents.keys()]) await letGo(address, why);
    server.close();
    rmSync(join(ROOT, INFO), { force: true });
    rmSync(lock, { force: true });
    if (process.platform !== 'win32') rmSync(sock, { force: true });
    process.exit(0);
  }

  async function serve(line: string): Promise<object> {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return { ok: false, error: 'not JSON' };
    }
    if (msg?.token !== token) return { ok: false, error: 'bad token' };
    if (msg.op === 'release' && typeof msg.address === 'string') {
      yielded.set(msg.address, Date.now());
      await letGo(msg.address, 'a session is taking it');
      return { ok: true };
    }
    if (msg.op === 'status') {
      return { ok: true, version: VERSION, pid: process.pid, names: [...agents.values()].map(({ local, agent }) => ({ name: local.name, address: local.address, connected: agent.state().relay.connected })) };
    }
    if (msg.op === 'stop') {
      setTimeout(() => void stop('asked to'), 50);
      return { ok: true };
    }
    return { ok: false, error: `unknown op ${String(msg.op)}` };
  }

  const server = createServer((c: Socket) => {
    let buf = '';
    c.setEncoding('utf8');
    c.setTimeout(CALL_MS, () => c.destroy());
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      void serve(line).then((reply) => c.end(JSON.stringify(reply) + '\n'));
    });
    c.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  writeJson(ROOT, INFO, { pid: process.pid, token, version: VERSION, socket: sock, started: new Date().toISOString() } satisfies Info, true);
  log(`parley daemon ${VERSION} started (pid ${process.pid})`);

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  await reconcile();
  setInterval(() => void reconcile(), RECONCILE_MS);
}

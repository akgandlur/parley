import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { signText, type Identity } from './crypto';
import { readJson, writeJson } from './home';
import type { SessionState, View } from './types';

// Off unless a person links this name to a cloud account. Once linked, the
// node sends that cloud every session's transcript as it is written, the
// other side's entries included. The cloud can read them: this is the one
// place a session leaves the two machines.

const RETRY_MS = [2000, 5000, 15_000, 60_000];
const HEARTBEAT_MS = 30_000;
const BATCH_BYTES = 200_000;

export type Live = {
  id: string;
  dir: string;
  role: 'caller' | 'callee';
  state: SessionState;
  peer: { address: string; name?: string };
  title: string;
  endedReason?: string;
};

type Line = { raw: string; sig?: string };
type Have = Record<string, { lines: number; minutes: boolean }>;
type Call = {
  session: string;
  stamp: string;
  from: number;
  lines: Line[];
  minutes?: string;
  role?: Live['role'];
  peer?: Live['peer'];
  title?: string;
  state?: SessionState;
  endedReason?: string;
};

const originOf = (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`a cloud address starts with https://, not ${parsed.protocol}`);
  }
  return parsed.origin;
};

function linesOf(dir: string): Line[] {
  const path = join(dir, 'transcript.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}

function minutesOf(dir: string): string | undefined {
  const path = join(dir, 'minutes.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function startCloud(
  home: string,
  me: Identity,
  log: (...parts: unknown[]) => void,
  live: () => Live | undefined,
) {
  let url = existsSync(join(home, 'cloud.json'))
    ? readJson<{ url: string }>(home, 'cloud.json').url
    : undefined;
  let have: Have | undefined;
  let error: string | undefined;
  let dirty = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function post(calls: Call[]): Promise<Have> {
    const body = JSON.stringify({ name: me.name, calls });
    const time = new Date().toISOString();
    const digest = createHash('sha256').update(body).digest('hex');
    const res = await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-parley-key': me.publicKey,
        'x-parley-time': time,
        'x-parley-sig': signText(me, `parley-cloud-ingest\n${time}\n${digest}`),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json().catch(() => ({}))) as { have?: Have; error?: string };
    if (!res.ok || !reply.have) {
      throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    }
    return reply.have;
  }

  // One call's unsent lines, in requests small enough for any proxy.
  async function send(call: Omit<Call, 'from' | 'lines'>, all: Line[], known: Have) {
    let from = Math.min(known[call.session]?.lines ?? 0, all.length);
    do {
      const lines: Line[] = [];
      let bytes = 0;
      while (from + lines.length < all.length && bytes < BATCH_BYTES) {
        const next = all[from + lines.length] as Line;
        bytes += next.raw.length;
        lines.push(next);
      }
      const last = from + lines.length >= all.length;
      const got = await post([{ ...call, minutes: last ? call.minutes : undefined, from, lines }]);
      Object.assign(known, got);
      const next = known[call.session]?.lines;
      if (next === undefined || (lines.length && next === from)) {
        throw new Error('the cloud did not take the entries it was sent');
      }
      from = next;
    } while (from < all.length);
  }

  async function sync() {
    const known = (have ??= await post([]));
    const now = live();
    const root = join(home, 'sessions');
    for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
      const [stamp = '', session = ''] = name.split('-');
      if (session === now?.id) continue;
      const dir = join(root, name);
      const all = linesOf(dir);
      const minutes = minutesOf(dir);
      const there = known[session];
      if (!all.length) continue;
      if (there && there.lines >= all.length && (there.minutes || !minutes)) continue;
      await send({ session, stamp, state: 'ended', minutes }, all, known);
    }
    if (!now) return;
    const stamp = now.dir.split('/').at(-1)?.split('-')[0] ?? '';
    await send(
      {
        session: now.id,
        stamp,
        role: now.role,
        peer: now.peer,
        title: now.title,
        state: now.state,
        endedReason: now.endedReason,
        minutes: now.state === 'ended' ? minutesOf(now.dir) : undefined,
      },
      linesOf(now.dir),
      known,
    );
  }

  async function run() {
    if (running || !url) return;
    running = true;
    try {
      while (dirty && url) {
        dirty = false;
        await sync();
        if (error) log('cloud sync is working again');
        error = undefined;
        failures = 0;
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (why !== error) log('cloud sync failed:', why);
      error = why;
      have = undefined;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(run, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
    } finally {
      running = false;
    }
  }

  function touch() {
    if (!url) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  }

  // The cloud shows when it last heard from this machine, so a call that is
  // open but silent still has to say it is alive.
  setInterval(() => {
    const now = live();
    if (now && now.state !== 'ended') touch();
  }, HEARTBEAT_MS).unref();

  touch();

  return {
    touch,
    state: (): View['cloud'] => (url ? { url, syncing: !error, error } : undefined),
    // The link carries no secret of the node's. Whoever opens it while signed
    // in to the cloud ties this name to their account, so it goes to the
    // person and is good for a few minutes only.
    link(to: string | undefined): { url: string; link: string } {
      const given = to ?? url ?? process.env.PARLEY_CLOUD;
      if (!given) throw new Error('no cloud address is known; give one, like https://cloud.example.com');
      url = originOf(given);
      writeJson(home, 'cloud.json', { url });
      have = undefined;
      error = undefined;
      touch();
      const t = new Date().toISOString();
      const query = new URLSearchParams({
        key: me.publicKey,
        name: me.name,
        t,
        sig: signText(me, `parley-cloud-link\n${url}\n${t}\n${me.name}`),
      });
      return { url, link: `${url}/link?${query}` };
    },
    unlink() {
      rmSync(join(home, 'cloud.json'), { force: true });
      clearTimeout(timer);
      url = undefined;
      have = undefined;
      error = undefined;
    },
  };
}

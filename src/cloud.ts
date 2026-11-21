import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readAttestation } from './attest';
import { signText, type Identity } from './crypto';
import { readJson, writeJson } from './home';
import type { SessionState, Verified, View } from './types';

// A name linked to a cloud account gets from it the proof that lets it onto
// a relay that needs one. It sends that cloud its sessions only while the
// account keeps them (`sync`), and then every transcript as it is written,
// the other side's entries included. The cloud can read them: this is the
// one place a session leaves the two machines.

const RETRY_MS = [2000, 5000, 15_000, 60_000];
const HEARTBEAT_MS = 30_000;
const BATCH_BYTES = 200_000;
const RENEW_LEFT_MS = 18 * 3600_000;
const CHECK_MS = 10 * 60_000;
const UNLINKED_CHECK_MS = 30_000;

export type AttestFile = { att: string; issuer: string; sync: boolean; fetchedAt: string };

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
  renewed: (att: string) => void,
) {
  // Read with `now` at 0 so an expired proof still says when it ran out.
  const own = (f: AttestFile) => readAttestation(f.att, [f.issuer], me.publicKey, 0);
  let attest = existsSync(join(home, 'attest.json'))
    ? readJson<AttestFile>(home, 'attest.json')
    : undefined;
  if (attest) own(attest);
  // cloud.json holds null once a person has turned the cloud off. A visitor's
  // node has a proof the cloud wrote for it and no link to renew it through.
  const saved = existsSync(join(home, 'cloud.json'))
    ? readJson<{ url: string | null }>(home, 'cloud.json').url
    : undefined;
  let url = saved === null ? undefined : (saved ?? (attest ? undefined : process.env.PARLEY_CLOUD));
  if (url && saved === undefined) {
    url = originOf(url);
    writeJson(home, 'cloud.json', { url });
  }
  let refusal: 'not linked' | 'banned' | undefined;
  let attestError: string | undefined;
  let checking: Promise<void> | undefined;
  let lastCheck = 0;
  let have: Have | undefined;
  let error: string | undefined;
  let dirty = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const headers = (kind: string, body: string) => {
    const time = new Date().toISOString();
    const digest = createHash('sha256').update(body).digest('hex');
    return {
      'content-type': 'application/json',
      'x-parley-key': me.publicKey,
      'x-parley-time': time,
      'x-parley-sig': signText(me, `parley-cloud-${kind}\n${time}\n${digest}`),
    };
  };

  const keeping = () => Boolean(url && attest?.sync && !refusal);

  async function fetchAttest() {
    const body = JSON.stringify({ name: me.name });
    const res = await fetch(`${url}/api/attest`, {
      method: 'POST',
      headers: headers('attest', body),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json().catch(() => ({}))) as Partial<AttestFile> & { error?: string };
    if (res.status === 403 && (reply.error === 'not linked' || reply.error === 'banned')) {
      if (refusal !== reply.error) log(`the cloud says this name is ${reply.error}`);
      refusal = reply.error;
      return;
    }
    if (!res.ok || typeof reply.att !== 'string' || typeof reply.issuer !== 'string' || typeof reply.sync !== 'boolean') {
      throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    }
    readAttestation(reply.att, [reply.issuer], me.publicKey);
    refusal = undefined;
    const keep =
      attest?.issuer === reply.issuer && own(attest).exp * 1000 - Date.now() >= RENEW_LEFT_MS;
    const wasKeeping = keeping();
    attest = {
      att: keep && attest ? attest.att : reply.att,
      issuer: reply.issuer,
      sync: reply.sync,
      fetchedAt: new Date().toISOString(),
    };
    writeJson(home, 'attest.json', attest, true);
    if (!keep) renewed(attest.att);
    if (keeping() && !wasKeeping) touch();
  }

  function check(): Promise<void> {
    if (!url) return Promise.resolve();
    checking ??= fetchAttest()
      .then(
        () => {
          attestError = undefined;
        },
        (err) => {
          const why = err instanceof Error ? err.message : String(err);
          if (why !== attestError) log('could not get the account proof:', why);
          attestError = why;
        },
      )
      .finally(() => {
        checking = undefined;
        lastCheck = Date.now();
      });
    return checking;
  }

  setInterval(() => {
    const due = !attest || refusal || attestError ? UNLINKED_CHECK_MS : CHECK_MS;
    if (url && Date.now() - lastCheck >= due) void check();
  }, 5000).unref();

  async function post(calls: Call[]): Promise<Have> {
    const body = JSON.stringify({ name: me.name, calls });
    const res = await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: headers('ingest', body),
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
    if (running || !keeping()) return;
    running = true;
    try {
      while (dirty && keeping()) {
        dirty = false;
        await sync();
        if (error) log('cloud sync is working again');
        error = undefined;
        failures = 0;
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      have = undefined;
      // The person turned the switch off since the last check.
      if (why === 'not kept' && attest) {
        log('the cloud no longer keeps this name\'s sessions');
        attest = { ...attest, sync: false };
        writeJson(home, 'attest.json', attest, true);
        error = undefined;
        return;
      }
      if (why !== error) log('cloud sync failed:', why);
      error = why;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(run, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
    } finally {
      running = false;
    }
  }

  function touch() {
    if (!keeping()) return;
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

  // The link carries no secret of the node's. Whoever opens it while signed
  // in to the cloud ties this name to their account, so it goes to the
  // person and is good for a few minutes only.
  function linkTo(to: string) {
    const t = new Date().toISOString();
    const query = new URLSearchParams({
      key: me.publicKey,
      name: me.name,
      t,
      sig: signText(me, `parley-cloud-link\n${to}\n${t}\n${me.name}`),
    });
    return `${to}/link?${query}`;
  }

  void check();

  return {
    touch,
    check,
    // For a status asked while the name waits on its person to link it.
    recheck: () => (Date.now() - lastCheck < 2000 ? Promise.resolve() : check()),
    att: () => attest?.att,
    issuers: () => (attest ? [attest.issuer] : []),
    verified: (): Verified | undefined => {
      if (!attest) return undefined;
      const a = own(attest);
      return { domain: a.domain, kind: a.kind };
    },
    state: (): View['cloud'] => {
      if (!url && !attest) return undefined;
      const sync = Boolean(attest?.sync) && !refusal;
      return {
        url,
        link: url && refusal === 'not linked' ? linkTo(url) : undefined,
        sync,
        syncing: sync && !error,
        error:
          refusal === 'banned'
            ? 'the account this name is linked to is banned'
            : refusal === 'not linked'
              ? 'this name is not linked to an account yet'
              : (attestError ?? error),
      };
    },
    link(to: string | undefined): { url: string; link: string } {
      const given = to ?? url ?? process.env.PARLEY_CLOUD;
      if (!given) throw new Error('no cloud address is known; give one, like https://cloud.example.com');
      const next = originOf(given);
      if (next !== url) {
        url = next;
        refusal = undefined;
        writeJson(home, 'cloud.json', { url });
      }
      have = undefined;
      error = undefined;
      void check();
      return { url: next, link: linkTo(next) };
    },
    unlink() {
      writeJson(home, 'cloud.json', { url: null });
      rmSync(join(home, 'attest.json'), { force: true });
      clearTimeout(timer);
      url = undefined;
      attest = undefined;
      refusal = undefined;
      attestError = undefined;
      have = undefined;
      error = undefined;
    },
  };
}

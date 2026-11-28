import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readAttestation } from './attest';
import { signText, type Identity } from './crypto';
import { machineIdentity, readJson, writeJson } from './home';

const RENEW_LEFT_MS = 18 * 3600_000;
const CHECK_MS = 2 * 60_000;
const UNLINKED_CHECK_MS = 30_000;
const LINK_FRESH_MS = 10 * 60_000;

export type AttestFile = { att: string; issuer: string; sync?: boolean; fetchedAt: string };
export type Verified = { domain: string | null; kind: 'account' | 'visitor'; sub: string; nets: string[] };
export type Session = { address: string; name: string; machine?: string };
export type Network = { id: string; name: string; people: { email: string; names: Session[] }[] };
export type People = { mine: Session[]; online?: string[]; reachable?: string[]; nets?: Network[] };

export type AccountState = { url?: string; link?: string; error?: string; verified?: Verified };

export const verifiedText = (v: Verified | undefined) =>
  !v ? 'not verified' : v.kind === 'visitor' ? 'visitor' : `verified · ${v.domain}`;

const originOf = (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`a cloud address starts with https://, not ${parsed.protocol}`);
  }
  return parsed.origin;
};

function longLinkFor(to: string) {
  const machine = machineIdentity();
  const t = new Date().toISOString();
  const query = new URLSearchParams({
    kind: 'machine',
    key: machine.publicKey,
    name: machine.name,
    t,
    sig: signText(machine, `parley-cloud-link-machine\n${to}\n${t}\n${machine.name}`),
  });
  return { long: `${to}/link?${query}`, query };
}

// The link carries no secret: whoever opens it signed in ties this machine to their account, so it is short-lived.
export async function linkFor(to: string, log: (...parts: unknown[]) => void = () => {}) {
  const { long, query } = longLinkFor(to);
  try {
    const res = await fetch(`${to}/api/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(query)),
      signal: AbortSignal.timeout(5000),
    });
    const reply = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
    if (!res.ok || typeof reply.link !== 'string') throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    return reply.link;
  } catch (err) {
    log('no short link, so the long one is given:', err instanceof Error ? err.message : err);
    return long;
  }
}

export function startAccount(
  home: string,
  me: Identity,
  log: (...parts: unknown[]) => void,
  renewed: (att: string) => void,
) {
  // `now` 0 so an expired proof still says when it ran out.
  const own = (f: AttestFile) => readAttestation(f.att, [f.issuer], me.publicKey, 0);
  let attest = existsSync(join(home, 'attest.json'))
    ? readJson<AttestFile>(home, 'attest.json')
    : undefined;
  if (attest) {
    try {
      own(attest);
    } catch (err) {
      log('the saved account proof no longer checks out, so a new one is fetched:', err instanceof Error ? err.message : err);
      attest = undefined;
    }
  }
  const saved = existsSync(join(home, 'cloud.json'))
    ? readJson<{ url: string | null }>(home, 'cloud.json').url
    : undefined;
  // PARLEY_CLOUD wins over the saved cloud so a plugin update can move everyone.
  let url = saved === null ? undefined : (process.env.PARLEY_CLOUD ?? saved);
  if (url) url = originOf(url);
  if (url && url !== saved) {
    writeJson(home, 'cloud.json', { url });
    if (saved) attest = undefined;
  }
  let refusal: 'not linked' | 'banned' | undefined;
  let link: { to: string; at: number; link: string } | undefined;
  let error: string | undefined;
  let checking: Promise<void> | undefined;
  let lastCheck = 0;

  async function fetchAttest() {
    const machine = machineIdentity();
    const body = JSON.stringify({
      name: me.name,
      machine: { key: machine.publicKey, sig: signText(machine, `parley-cloud-machine\n${me.publicKey}`) },
    });
    const time = new Date().toISOString();
    const digest = createHash('sha256').update(body).digest('hex');
    const res = await fetch(`${url}/api/attest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-parley-key': me.publicKey,
        'x-parley-time': time,
        'x-parley-sig': signText(me, `parley-cloud-attest\n${time}\n${digest}`),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json().catch(() => ({}))) as Partial<AttestFile> & { error?: string };
    if (res.status === 403 && (reply.error === 'not linked' || reply.error === 'banned')) {
      if (refusal !== reply.error) log(`the cloud says this name is ${reply.error}`);
      if (reply.error === 'not linked' && url && (!link || link.to !== url || Date.now() - link.at > LINK_FRESH_MS)) {
        link = { to: url, at: Date.now(), link: await linkFor(url, log) };
      }
      refusal = reply.error;
      return;
    }
    if (!res.ok || typeof reply.att !== 'string' || typeof reply.issuer !== 'string') {
      throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    }
    const fresh = readAttestation(reply.att, [reply.issuer], me.publicKey);
    refusal = undefined;
    // Joining a network has to show on the next message, not the next day.
    const keep =
      attest?.issuer === reply.issuer &&
      own(attest).exp * 1000 - Date.now() >= RENEW_LEFT_MS &&
      (own(attest).nets ?? []).join() === (fresh.nets ?? []).join();
    attest = {
      att: keep && attest ? attest.att : reply.att,
      issuer: reply.issuer,
      fetchedAt: new Date().toISOString(),
    };
    writeJson(home, 'attest.json', attest, true);
    if (!keep) renewed(attest.att);
  }

  function check(): Promise<void> {
    if (!url) return Promise.resolve();
    checking ??= fetchAttest()
      .then(
        () => {
          error = undefined;
        },
        (err) => {
          const why = err instanceof Error ? err.message : String(err);
          if (why !== error) log('could not get the account proof:', why);
          error = why;
        },
      )
      .finally(() => {
        checking = undefined;
        lastCheck = Date.now();
      });
    return checking;
  }

  setInterval(() => {
    const due = !attest || refusal || error ? UNLINKED_CHECK_MS : CHECK_MS;
    if (url && Date.now() - lastCheck >= due) void check();
  }, 5000).unref();

  void check();

  async function people(ids: string[]): Promise<People | undefined> {
    if (!url || !attest) return undefined;
    const body = JSON.stringify({ ids });
    const time = new Date().toISOString();
    const res = await fetch(`${url}/api/people`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-parley-key': me.publicKey,
        'x-parley-time': time,
        'x-parley-sig': signText(me, `parley-cloud-people\n${time}\n${createHash('sha256').update(body).digest('hex')}`),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const reply = (await res.json().catch(() => ({}))) as Partial<People> & { error?: string };
    if (!res.ok || !Array.isArray(reply.mine)) throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    return { mine: reply.mine, online: reply.online, reachable: Array.isArray(reply.reachable) ? reply.reachable : undefined, nets: Array.isArray(reply.nets) ? reply.nets : undefined };
  }

  return {
    check,
    people,
    recheck: () => (Date.now() - lastCheck < 2000 ? Promise.resolve() : check()),
    att: () => attest?.att,
    issuers: () => (attest ? [attest.issuer] : []),
    state: (): AccountState => {
      const a = attest && own(attest);
      return {
        url,
        link: url && refusal === 'not linked' && link?.to === url ? link.link : undefined,
        error:
          refusal === 'banned'
            ? 'the account this machine is linked to is banned'
            : refusal === 'not linked'
              ? 'this machine is not linked to a parley account yet'
              : error,
        verified: a ? { domain: a.domain, kind: a.kind, sub: a.sub, nets: a.nets ?? [] } : undefined,
      };
    },
    async link(to: string | undefined): Promise<{ url: string; link: string }> {
      const given = to ?? url ?? process.env.PARLEY_CLOUD;
      if (!given) throw new Error('no cloud address is known; give one, like https://cloud.example.com');
      const next = originOf(given);
      if (next !== url) {
        url = next;
        refusal = undefined;
        writeJson(home, 'cloud.json', { url });
      }
      void check();
      link = { to: next, at: Date.now(), link: await linkFor(next, log) };
      return { url: next, link: link.link };
    },
    unlink() {
      writeJson(home, 'cloud.json', { url: null });
      rmSync(join(home, 'attest.json'), { force: true });
      url = undefined;
      attest = undefined;
      refusal = undefined;
      error = undefined;
    },
  };
}

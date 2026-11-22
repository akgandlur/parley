import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readAttestation } from './attest';
import { signText, type Identity } from './crypto';
import { readJson, writeJson } from './home';

// A name linked to a parley account gets from the cloud the proof that lets
// it onto a relay that needs one, and shows the other side its account's
// email domain.

const RENEW_LEFT_MS = 18 * 3600_000;
const CHECK_MS = 2 * 60_000;
const UNLINKED_CHECK_MS = 30_000;

export type AttestFile = { att: string; issuer: string; sync?: boolean; fetchedAt: string };
export type Verified = { domain: string | null; kind: 'account' | 'visitor' };
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

// The link carries no secret of the name's. Whoever opens it while signed in
// to the cloud ties this name to their account, so it goes to the person
// and is good for a few minutes only.
export function linkFor(me: Identity, to: string) {
  const t = new Date().toISOString();
  const query = new URLSearchParams({
    key: me.publicKey,
    name: me.name,
    t,
    sig: signText(me, `parley-cloud-link\n${to}\n${t}\n${me.name}`),
  });
  return `${to}/link?${query}`;
}

export function startAccount(
  home: string,
  me: Identity,
  log: (...parts: unknown[]) => void,
  renewed: (att: string) => void,
) {
  // Read with `now` at 0 so an expired proof still says when it ran out.
  const own = (f: AttestFile) => readAttestation(f.att, [f.issuer], me.publicKey, 0);
  let attest = existsSync(join(home, 'attest.json'))
    ? readJson<AttestFile>(home, 'attest.json')
    : undefined;
  if (attest) own(attest);
  // cloud.json holds null once a person has turned the cloud off.
  const saved = existsSync(join(home, 'cloud.json'))
    ? readJson<{ url: string | null }>(home, 'cloud.json').url
    : undefined;
  let url = saved === null ? undefined : (saved ?? (attest ? undefined : process.env.PARLEY_CLOUD));
  if (url && saved === undefined) {
    url = originOf(url);
    writeJson(home, 'cloud.json', { url });
  }
  let refusal: 'not linked' | 'banned' | undefined;
  let error: string | undefined;
  let checking: Promise<void> | undefined;
  let lastCheck = 0;

  async function fetchAttest() {
    const body = JSON.stringify({ name: me.name });
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
      refusal = reply.error;
      return;
    }
    if (!res.ok || typeof reply.att !== 'string' || typeof reply.issuer !== 'string') {
      throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    }
    readAttestation(reply.att, [reply.issuer], me.publicKey);
    refusal = undefined;
    const keep =
      attest?.issuer === reply.issuer && own(attest).exp * 1000 - Date.now() >= RENEW_LEFT_MS;
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

  return {
    check,
    // For a listing asked while the name waits on its person to link it.
    recheck: () => (Date.now() - lastCheck < 2000 ? Promise.resolve() : check()),
    att: () => attest?.att,
    issuers: () => (attest ? [attest.issuer] : []),
    state: (): AccountState => {
      const a = attest && own(attest);
      return {
        url,
        link: url && refusal === 'not linked' ? linkFor(me, url) : undefined,
        error:
          refusal === 'banned'
            ? 'the account this name is linked to is banned'
            : refusal === 'not linked'
              ? 'this name is not linked to an account yet'
              : error,
        verified: a ? { domain: a.domain, kind: a.kind } : undefined,
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
      void check();
      return { url: next, link: linkFor(me, next) };
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

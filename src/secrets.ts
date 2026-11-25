import { createHash, webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { signText, type Identity } from './crypto';
import { readJson, writeJson } from './home';
import { checkLabel, putSecret, ruleText, type Rule } from './vault';

// A secret a person types into the cloud's page. The page seals it in their
// browser to a key made here for that one request, so the cloud carries
// something it cannot open, and the value goes from here into the vault
// without passing through a session.

type Pending = { label: string; use: Rule[]; key: JsonWebKey; link: string; askedAt: string; expires: string };

const FAST_MS = 4000;
const SLOW_MS = 60_000;
const FAST_FOR_MS = 30 * 60_000;
const subtle = webcrypto.subtle;
const b64 = (s: string) => Buffer.from(s, 'base64url');

export const secretArrived = (label: string, how: string, use: Rule[]) =>
  [
    `parley: a secret labelled ${label} is now in this machine's vault (${how}). Its value is not shown to you and you have no need of it.`,
    use.length ? `It may be used by: ${use.map(ruleText).join('; ')}.` : `It has no rule yet that lets anything use it: your user allows a use by typing /parley:secret allow ${label} run <program>, or http <host>.`,
    'Use it with run_with_secret or fetch_with_secret, by its label.',
  ].join(' ');

export function startRequests(
  home: string,
  me: Identity,
  cloud: () => string | undefined,
  log: (...parts: unknown[]) => void,
  notice: (text: string) => void,
) {
  const load = (): Record<string, Pending> => (existsSync(join(home, 'requests.json')) ? readJson<Record<string, Pending>>(home, 'requests.json') : {});
  const save = (all: Record<string, Pending>) => writeJson(home, 'requests.json', all, true);

  async function call<T>(path: string, body: unknown): Promise<T> {
    const url = cloud();
    if (!url) throw new Error('this session has no parley account address, which asking for a secret needs');
    const text = JSON.stringify(body);
    const time = new Date().toISOString();
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-parley-key': me.publicKey,
        'x-parley-time': time,
        'x-parley-sig': signText(me, `parley-cloud-secret\n${time}\n${createHash('sha256').update(text).digest('hex')}`),
      },
      body: text,
      signal: AbortSignal.timeout(10_000),
    });
    const reply = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(reply.error ?? `the cloud answered ${res.status}`);
    return reply;
  }

  async function opened(code: string, p: Pending, box: { epk: string; iv: string; ct: string }): Promise<string> {
    const mine = await subtle.importKey('jwk', p.key, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const theirs = await subtle.importKey('raw', b64(box.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, mine, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const aes = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`parley-secret\n${code}`) },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64(box.iv), additionalData: new TextEncoder().encode(p.label) }, aes, b64(box.ct));
    return new TextDecoder().decode(plain);
  }

  let busy = false;
  let last = 0;
  async function collect() {
    const all = load();
    const codes = Object.keys(all);
    if (!codes.length || busy) return;
    const newest = Math.max(...codes.map((c) => Date.parse(all[c]!.askedAt)));
    if (Date.now() - last < (Date.now() - newest < FAST_FOR_MS ? FAST_MS : SLOW_MS)) return;
    busy = true;
    last = Date.now();
    try {
      const got = await call<{ filled: Record<string, { epk: string; iv: string; ct: string }>; gone: string[] }>('/api/secrets/take', { codes });
      for (const [code, box] of Object.entries(got.filled)) {
        const p = all[code];
        if (!p) continue;
        try {
          putSecret(p.label, await opened(code, p, box), `typed at ${p.link}`, p.use);
          notice(secretArrived(p.label, `typed at ${p.link}`, p.use));
        } catch (err) {
          notice(`parley: what was typed at ${p.link} for the secret ${p.label} could not be kept: ${err instanceof Error ? err.message : err}`);
        }
        delete all[code];
      }
      for (const code of got.gone) {
        if (all[code]) notice(`parley: the link ${all[code].link} for the secret ${all[code].label} ran out before anyone used it. Ask for it again with request_secret if it is still needed.`);
        delete all[code];
      }
      const done = [...Object.keys(got.filled), ...got.gone];
      if (done.length) save(Object.fromEntries(Object.entries(load()).filter(([code]) => !done.includes(code))));
    } catch (err) {
      log('could not ask the cloud for typed secrets:', err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  }
  setInterval(() => void collect(), 1000).unref();

  return {
    async request(label: string, use: Rule[], note: string | undefined, email: string | undefined): Promise<{ link: string; hours: number; mailed?: string }> {
      checkLabel(label);
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const pub = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
      const made = await call<{ code: string; link: string; expires: string; mailed?: string }>('/api/secrets', { label, pub, use: use.map(ruleText), note, email });
      save({ ...load(), [made.code]: { label, use, key: await subtle.exportKey('jwk', pair.privateKey), link: made.link, askedAt: new Date().toISOString(), expires: made.expires } });
      return { link: made.link, hours: Math.round((Date.parse(made.expires) - Date.now()) / 3600_000), mailed: made.mailed };
    },
  };
}

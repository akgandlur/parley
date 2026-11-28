import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT, readJson, writeJson } from './home';

export type Rule = { run: string; args: string[]; once?: boolean } | { http: string; once?: boolean };
type Entry = { iv: string; ct: string; tag: string; from: string; at: string; sendTo: string[]; use: Rule[] };
export type Listed = { label: string; from: string; at: string; sendTo: string[]; use: Rule[] };

const DIR = join(ROOT, 'vault');
const RUN_MS = 120_000;
const OUT_MAX = 60_000;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export function checkLabel(label: string) {
  if (!LABEL.test(label)) {
    throw new Error(`a secret's label is lower-case letters, digits, dots and hyphens, like bren-db-password; "${label.slice(0, 80)}" is not`);
  }
  return label;
}

export function parseRule(words: string[]): Rule {
  const once = words[0] === 'once';
  const [kind, target, ...args] = once ? words.slice(1) : words;
  if (kind === 'run' && target) return { run: target, args, ...(once && { once }) };
  if (kind === 'http' && target && !args.length && /^[a-z0-9.-]+(:\d+)?$/i.test(target)) return { http: target.toLowerCase(), ...(once && { once }) };
  throw new Error('a rule is `run <program> [arguments that must be there]` or `http <host>`, with `once` in front for a single use');
}

export const ruleText = (r: Rule) =>
  ('run' in r ? `the program ${r.run}${r.args.length ? `, with ${r.args.join(' ')} among its arguments` : ''}` : `web requests to ${r.http}`) + (r.once ? ', once' : '');

const all = (): Record<string, Entry> => (existsSync(join(DIR, 'secrets.json')) ? readJson<Record<string, Entry>>(DIR, 'secrets.json') : {});
const save = (entries: Record<string, Entry>) => writeJson(DIR, 'secrets.json', entries, true);

// The key sits beside what it locks: this stops a glance, not a program running as the same user.
function key(): Buffer {
  if (!existsSync(join(DIR, 'key.json'))) writeJson(DIR, 'key.json', { key: randomBytes(32).toString('base64') }, true);
  return Buffer.from(readJson<{ key: string }>(DIR, 'key.json').key, 'base64');
}

export function note(what: 'stored' | 'sent' | 'used' | 'refused' | 'removed' | 'rule', label: string, detail: string) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const path = join(DIR, 'log.jsonl');
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), what, label, detail }) + '\n');
  chmodSync(path, 0o600);
}

export function readLog(last: number): string[] {
  if (!existsSync(join(DIR, 'log.jsonl'))) return [];
  return readFileSync(join(DIR, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .slice(-last)
    .map((line) => {
      const e = JSON.parse(line) as { at: string; what: string; label: string; detail: string };
      return `${e.at.slice(0, 19).replace('T', ' ')}  ${e.what}  ${e.label}  ${e.detail}`;
    });
}

export const listSecrets = (): Listed[] =>
  Object.entries(all()).map(([label, e]) => ({ label, from: e.from, at: e.at, sendTo: e.sendTo, use: e.use }));

export function putSecret(label: string, value: string, from: string, use: Rule[]) {
  checkLabel(label);
  if (!value) throw new Error('an empty secret is not kept');
  const entries = all();
  const had = entries[label];
  if (had && had.from !== from) throw new Error(`this machine already keeps a secret labelled ${label}, from ${had.from}. Its person removes it first with /parley:secret remove ${label}, or another label is used`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  entries[label] = { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'), from, at: new Date().toISOString(), sendTo: had?.sendTo ?? [], use: had ? had.use : use };
  save(entries);
  note('stored', label, `from ${from}`);
}

function entryOf(label: string): Entry {
  const e = all()[checkLabel(label)];
  if (!e) throw new Error(`this machine keeps no secret labelled ${label}. list_secrets shows the ones it has`);
  return e;
}

function valueOf(e: Entry): string {
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
}

function change(label: string, fn: (e: Entry) => void) {
  const entries = all();
  const e = entries[checkLabel(label)];
  if (!e) throw new Error(`this machine keeps no secret labelled ${label}`);
  fn(e);
  save(entries);
}

export function allow(label: string, rule: Rule) {
  change(label, (e) => e.use.push(rule));
  note('rule', label, `may be used by ${ruleText(rule)}`);
}

export function share(label: string, id: string) {
  change(label, (e) => {
    if (!e.sendTo.includes(id)) e.sendTo.push(id);
  });
  note('rule', label, `may be sent to ${id}`);
}

export function removeSecret(label: string) {
  const entries = all();
  if (!entries[checkLabel(label)]) throw new Error(`this machine keeps no secret labelled ${label}`);
  delete entries[label];
  save(entries);
  note('removed', label, '');
}

export function takeForSending(label: string, to: string, trusted: boolean, met: boolean): { value: string; use: Rule[] } {
  const e = entryOf(label);
  if (!trusted && !e.sendTo.includes(to)) {
    note('refused', label, `sending to ${to}`);
    const first = met ? '' : ` This machine has not exchanged a message with ${to}, and that comes first: send it one with send_message and wait for its reply.`;
    throw new Error(`the secret ${label} may not be sent to ${to}.${first} Only your user can allow it, by typing /parley:secret share ${label} ${to}. Ask them; do not look for another way to pass it on`);
  }
  return { value: valueOf(e), use: e.use.filter((r) => !r.once) };
}

export function mask(text: string, value: string): string {
  const forms = new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex')]);
  let out = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) if (f) out = out.split(f).join('[secret]');
  return out;
}

function spend(label: string, rule: Rule) {
  if (rule.once) {
    change(label, (e) => {
      e.use = e.use.filter((r) => JSON.stringify(r) !== JSON.stringify(rule));
    });
  }
}

const refusal = (label: string, what: string, grant: string) =>
  `the secret ${label} may not be used for ${what}. ${listRules(label)} Only your user can allow more, by typing /parley:secret allow ${label} ${grant}. Ask them; do not look for another way to use it`;

function listRules(label: string) {
  const { use } = entryOf(label);
  return use.length ? `It may be used by: ${use.map(ruleText).join('; ')}.` : 'It has no rule yet that lets anything use it.';
}

export async function runWith(label: string, argv: string[], how: { env: string } | 'stdin', cwd: string | undefined, by: string): Promise<string> {
  const e = entryOf(label);
  const [program, ...args] = argv;
  if (!program) throw new Error('give the command as a list: the program, then its arguments');
  const rule = e.use.find((r) => 'run' in r && (r.run === program || r.run === basename(program)) && r.args.every((a) => args.includes(a)));
  const shown = argv.join(' ').slice(0, 300);
  if (!rule) {
    note('refused', label, `${by}: ${shown}`);
    throw new Error(refusal(label, `the command ${shown}`, `run ${basename(program)}`));
  }
  if (how !== 'stdin' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(how.env)) throw new Error('an environment variable name is letters, digits and underscores');
  const value = valueOf(e);
  spend(label, rule);
  note('used', label, `${by}: ${shown}`);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: how === 'stdin' ? process.env : { ...process.env, [how.env]: value }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out = (out + d).slice(0, OUT_MAX)));
    child.stderr.on('data', (d) => (err = (err + d).slice(0, OUT_MAX)));
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_MS);
    child.on('error', (problem) => {
      clearTimeout(timer);
      reject(new Error(mask(`could not run ${program}: ${problem.message}`, value)));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(mask([`Exit ${code ?? signal}.`, out && `Output:\n${out.trimEnd()}`, err && `Errors:\n${err.trimEnd()}`].filter(Boolean).join('\n\n'), value));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(how === 'stdin' ? value : undefined);
  });
}

const LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function fetchWith(
  label: string,
  req: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  by: string,
): Promise<string> {
  const e = entryOf(label);
  const url = new URL(req.url);
  const rule = e.use.find((r) => 'http' in r && r.http === url.host.toLowerCase());
  const shown = `${req.method ?? 'GET'} ${url.origin}${url.pathname}`;
  if (!rule) {
    note('refused', label, `${by}: ${shown}`);
    throw new Error(refusal(label, `a request to ${url.host}`, `http ${url.host}`));
  }
  if (url.protocol !== 'https:' && !LOCAL.test(url.host)) throw new Error('a secret goes out over https only');
  const value = valueOf(e);
  const fill = (s: string) =>
    s.replace(/\{\{secret\}\}/g, value).replace(/\{\{basic:([^}]*)\}\}/g, (_, user: string) => Buffer.from(`${user}:${value}`).toString('base64'));
  spend(label, rule);
  note('used', label, `${by}: ${shown}`);
  const res = await fetch(url, {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k, fill(v)])),
    body: req.body === undefined ? undefined : fill(req.body),
    // A redirect could carry the secret to a host no rule names.
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  const text = (await res.text()).slice(0, OUT_MAX);
  const to = res.headers.get('location');
  return mask([`Status ${res.status}.`, to && `It redirects to ${to}, which was not followed.`, res.headers.get('content-type') && `Type: ${res.headers.get('content-type')}`, text && `Body:\n${text}`].filter(Boolean).join('\n'), value);
}

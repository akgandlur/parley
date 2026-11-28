import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPrekey } from './ratchet';

export const MAIL_FRAMES_MAX = 100;
export const MAIL_BYTES_MAX = 4 * 1024 * 1024;
export const MAIL_KEEP_MS = 7 * 24 * 3600_000;
export const BOX_KEEP_MS = 30 * 24 * 3600_000;
export const OPKS_MAX = 100;
export const OPKS_LOW = 10;
const SAVE_MS = 1000;
const ID = /^[a-z]{3}-[a-z]{3}-[a-z]{3}$/;

export type Held = { seq: number; at: string; from: string; payload: unknown; bytes: number };
export type Bundle = { key: string; spk: { pub: string; sig: string }; opk?: string };
type Box = { key: string; spk: { pub: string; sig: string }; opks: string[]; frames: Held[]; next: number; seen: number };

const isKey = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

export class Mail {
  private boxes = new Map<string, Box>();
  private dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private dir: string | undefined,
    private log: (...parts: unknown[]) => void,
  ) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!ID.test(id)) continue;
      try {
        this.boxes.set(id, JSON.parse(readFileSync(join(dir, file), 'utf8')) as Box);
      } catch (err) {
        log(`could not read the mail of ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    this.sweep();
  }

  has = (id: string) => this.boxes.has(id);

  private changed(id: string) {
    if (!this.dir) return;
    this.dirty.add(id);
    this.saveTimer ??= setTimeout(() => this.save(), SAVE_MS);
  }

  private save() {
    this.saveTimer = undefined;
    if (!this.dir) return;
    for (const id of this.dirty) {
      const path = join(this.dir, `${id}.json`);
      try {
        const box = this.boxes.get(id);
        if (!box) {
          rmSync(path, { force: true });
          continue;
        }
        writeFileSync(`${path}.part`, JSON.stringify(box), { mode: 0o600 });
        chmodSync(`${path}.part`, 0o600);
        renameSync(`${path}.part`, path);
      } catch (err) {
        this.log(`could not save the mail of ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    this.dirty.clear();
  }

  put(id: string, key: string, spk: unknown, opks: unknown): number {
    const s = spk as { pub?: unknown; sig?: unknown } | undefined;
    if (!s || !isKey(s.pub) || typeof s.sig !== 'string' || !checkPrekey(key, s.pub, s.sig)) throw new Error('the signed prekey is not signed by this name');
    const box = this.boxes.get(id) ?? { key, spk: { pub: s.pub, sig: s.sig }, opks: [], frames: [], next: 1, seen: Date.now() };
    box.key = key;
    box.spk = { pub: s.pub, sig: s.sig };
    for (const k of Array.isArray(opks) ? opks : []) {
      if (isKey(k) && !box.opks.includes(k) && box.opks.length < OPKS_MAX) box.opks.push(k);
    }
    box.seen = Date.now();
    this.boxes.set(id, box);
    this.changed(id);
    return box.opks.length;
  }

  take(id: string): { bundle: Bundle; left: number } | undefined {
    const box = this.boxes.get(id);
    if (!box) return undefined;
    const opk = box.opks.shift();
    this.changed(id);
    return { bundle: { key: box.key, spk: box.spk, ...(opk ? { opk } : {}) }, left: box.opks.length };
  }

  left = (id: string) => this.boxes.get(id)?.opks.length ?? 0;

  hold(from: string, to: string, payload: unknown, bytes: number): 'held' | 'no mailbox' | 'full' {
    const box = this.boxes.get(to);
    if (!box) return 'no mailbox';
    const used = box.frames.reduce((n, f) => n + f.bytes, 0);
    if (box.frames.length >= MAIL_FRAMES_MAX || used + bytes > MAIL_BYTES_MAX) return 'full';
    box.frames.push({ seq: box.next++, at: new Date().toISOString(), from, payload, bytes });
    this.changed(to);
    return 'held';
  }

  arrived(id: string): Held[] {
    const box = this.boxes.get(id);
    if (!box) return [];
    box.seen = Date.now();
    this.changed(id);
    return [...box.frames];
  }

  took(id: string, seq: number) {
    const box = this.boxes.get(id);
    if (!box || !Number.isInteger(seq)) return;
    const before = box.frames.length;
    box.frames = box.frames.filter((f) => f.seq > seq);
    if (box.frames.length !== before) this.changed(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, box] of this.boxes) {
      if (now - box.seen > BOX_KEEP_MS) {
        this.boxes.delete(id);
        this.changed(id);
        continue;
      }
      const kept = box.frames.filter((f) => now - Date.parse(f.at) < MAIL_KEEP_MS);
      if (kept.length !== box.frames.length) {
        box.frames = kept;
        this.changed(id);
      }
    }
  }

  stop() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.save();
  }
}

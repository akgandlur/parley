import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Identity } from './crypto';
import { readJson, writeJson } from './home';
import { loadPair, newPair, savePair, signPrekey, type Pair, type SavedPair } from './ratchet';

export const OPKS_STOCK = 50;
const SPK_ROTATE_MS = 7 * 24 * 3600_000;
const SPK_PREVIOUS_MS = 7 * 24 * 3600_000;
const OPK_KEEP_MS = 30 * 24 * 3600_000;

type Saved = {
  spk: SavedPair & { sig: string; at: string };
  prev?: SavedPair & { until: string };
  opks: (SavedPair & { at: string })[];
};

export class Prekeys {
  private state: Saved;

  constructor(
    private home: string,
    private me: Identity,
  ) {
    this.state = existsSync(join(home, 'prekeys.json')) ? readJson<Saved>(home, 'prekeys.json') : { spk: this.freshSpk(), opks: [] };
    this.rotate();
  }

  private freshSpk() {
    const pair = savePair(newPair());
    return { ...pair, sig: signPrekey(this.me, pair.pub), at: new Date().toISOString() };
  }

  private save() {
    writeJson(this.home, 'prekeys.json', this.state, true);
  }

  rotate(): boolean {
    const now = Date.now();
    let changed = false;
    if (now - Date.parse(this.state.spk.at) > SPK_ROTATE_MS) {
      const { sig: _s, at: _a, ...old } = this.state.spk;
      this.state.prev = { ...old, until: new Date(now + SPK_PREVIOUS_MS).toISOString() };
      this.state.spk = this.freshSpk();
      changed = true;
    }
    if (this.state.prev && Date.parse(this.state.prev.until) < now) {
      delete this.state.prev;
      changed = true;
    }
    const kept = this.state.opks.filter((o) => now - Date.parse(o.at) < OPK_KEEP_MS);
    if (kept.length !== this.state.opks.length) {
      this.state.opks = kept;
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  bundleToPut(more: number): { spk: { pub: string; sig: string }; opks: string[] } {
    const now = new Date().toISOString();
    for (let i = 0; i < more; i++) this.state.opks.push({ ...savePair(newPair()), at: now });
    if (more > 0) this.save();
    return { spk: { pub: this.state.spk.pub, sig: this.state.spk.sig }, opks: this.state.opks.map((o) => o.pub) };
  }

  onHand = () => this.state.opks.length;

  signedPrekey(pub: string): Pair | undefined {
    if (pub === this.state.spk.pub) return loadPair(this.state.spk);
    if (this.state.prev && pub === this.state.prev.pub) return loadPair(this.state.prev);
    return undefined;
  }

  oneTime(pub: string): Pair | undefined {
    const found = this.state.opks.find((o) => o.pub === pub);
    return found && loadPair(found);
  }

  dropOneTime(pub: string) {
    const before = this.state.opks.length;
    this.state.opks = this.state.opks.filter((o) => o.pub !== pub);
    if (this.state.opks.length !== before) this.save();
  }
}

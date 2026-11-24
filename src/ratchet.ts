import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import { signText, verifyText, type Identity } from './crypto';

// How two sessions keep a conversation secret. It follows Signal's design
// with one change: both sides are online when they talk, so in place of
// prekeys left on a server they exchange fresh keys directly.
//
//   1. Handshake. Each side makes a one-time X25519 key and signs it with its
//      identity key. The shared secret comes from the two one-time keys only,
//      so a stolen identity key opens no past conversation.
//   2. Double Ratchet (signal.org/docs/specifications/doubleratchet). Every
//      message has its own key, and every reply mixes in a new key exchange,
//      so a stolen conversation key opens neither earlier messages nor, once
//      the other side has answered, later ones.
//
// Conversation keys are held in memory only and go when the session closes.

const MAX_SKIP = 200;
const TAG = 16;

type Pair = { publicKey: string; privateKey: KeyObject };

function newPair(): Pair {
  const pair = generateKeyPairSync('x25519');
  return { publicKey: pair.publicKey.export({ format: 'jwk' }).x as string, privateKey: pair.privateKey };
}

const dh = (mine: KeyObject, theirs: string) =>
  diffieHellman({
    privateKey: mine,
    publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: theirs }, format: 'jwk' }),
  });

const hkdf = (ikm: Buffer, salt: Buffer, info: string, bytes: number) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), bytes));

function rootStep(root: Buffer, shared: Buffer): [Buffer, Buffer] {
  const out = hkdf(shared, root, 'parley ratchet root', 64);
  return [out.subarray(0, 32), out.subarray(32)];
}

function chainStep(chain: Buffer): [Buffer, Buffer] {
  const mac = (byte: number) => createHmac('sha256', chain).update(Buffer.from([byte])).digest();
  return [mac(2), mac(1)];
}

export type Header = { dh: string; pn: number; n: number };
export type Sealed = { h: Header; c: string };

export type Ratchet = {
  ad: Buffer;
  root: Buffer;
  mine: Pair;
  theirs?: string;
  sending?: Buffer;
  receiving?: Buffer;
  ns: number;
  nr: number;
  pn: number;
  skipped: Map<string, Buffer>;
};

// The first hello of a handshake. `to` is the id it is meant for, so it
// cannot be replayed at another.
export function offer(me: Identity, to: string) {
  const pair = newPair();
  return { pair, hello: { key: me.publicKey, e: pair.publicKey, sig: signText(me, `parley hs1\n${to}\n${pair.publicKey}`) } };
}

export const checkOffer = (hello: { key: string; e: string; sig: string }, myAddress: string) =>
  verifyText(hello.key, `parley hs1\n${myAddress}\n${hello.e}`, hello.sig);

function secret(shared: Buffer, a: { key: string; e: string }, b: { key: string; e: string }) {
  const transcript = createHash('sha256').update(['parley handshake', a.key, a.e, b.key, b.e].join('\n')).digest();
  return { root: hkdf(shared, transcript, 'parley handshake', 32), ad: transcript };
}

// The one who answers. Its one-time key doubles as its first ratchet key, and
// it can send once the first message from the other side has come in.
export function answer(me: Identity, from: string, hello: { key: string; e: string }) {
  const pair = newPair();
  const reply = { key: me.publicKey, e: pair.publicKey, sig: signText(me, `parley hs2\n${from}\n${hello.e}\n${pair.publicKey}`) };
  const { root, ad } = secret(dh(pair.privateKey, hello.e), hello, reply);
  const ratchet: Ratchet = { ad, root, mine: pair, ns: 0, nr: 0, pn: 0, skipped: new Map() };
  return { reply, ratchet };
}

export function finish(mine: { key: string; e: string }, pair: Pair, myAddress: string, reply: { key: string; e: string; sig: string }): Ratchet {
  if (!verifyText(reply.key, `parley hs2\n${myAddress}\n${mine.e}\n${reply.e}`, reply.sig)) {
    throw new Error('the handshake answer is not signed by the key it names');
  }
  const { root, ad } = secret(dh(pair.privateKey, reply.e), mine, reply);
  const next = newPair();
  const [newRoot, sending] = rootStep(root, dh(next.privateKey, reply.e));
  return { ad, root: newRoot, mine: next, theirs: reply.e, sending, ns: 0, nr: 0, pn: 0, skipped: new Map() };
}

export const canSeal = (r: Ratchet) => r.sending !== undefined;

const headerBytes = (h: Header) => Buffer.from(`${h.dh}\n${h.pn}\n${h.n}`);

function cipherKeys(messageKey: Buffer) {
  const out = hkdf(messageKey, Buffer.alloc(32), 'parley message key', 44);
  return { key: out.subarray(0, 32), nonce: out.subarray(32) };
}

export function seal(r: Ratchet, plaintext: string): Sealed {
  if (!r.sending) throw new Error('this side cannot send before the other has');
  const [chain, messageKey] = chainStep(r.sending);
  r.sending = chain;
  const h: Header = { dh: r.mine.publicKey, pn: r.pn, n: r.ns++ };
  const { key, nonce } = cipherKeys(messageKey);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([r.ad, headerBytes(h)]));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { h, c: body.toString('base64url') };
}

function decrypt(r: Ratchet, messageKey: Buffer, h: Header, c: string): string {
  const raw = Buffer.from(c, 'base64url');
  const { key, nonce } = cipherKeys(messageKey);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.concat([r.ad, headerBytes(h)]));
  decipher.setAuthTag(raw.subarray(raw.length - TAG));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG)), decipher.final()]).toString('utf8');
}

function skipTo(r: Ratchet, until: number) {
  if (!r.receiving || !r.theirs) return;
  if (until - r.nr > MAX_SKIP) throw new Error('too many messages were skipped');
  while (r.nr < until) {
    const [chain, messageKey] = chainStep(r.receiving);
    r.receiving = chain;
    r.skipped.set(`${r.theirs}\n${r.nr++}`, messageKey);
  }
  while (r.skipped.size > MAX_SKIP) r.skipped.delete(r.skipped.keys().next().value as string);
}

// Throws if the message is not from this conversation or was altered; the
// ratchet is then left as it was.
export function open(r: Ratchet, { h, c }: Sealed): string {
  if (!h || typeof h.dh !== 'string' || !Number.isInteger(h.pn) || !Number.isInteger(h.n) || h.pn < 0 || h.n < 0) {
    throw new Error('the message has no usable header');
  }
  const kept = r.skipped.get(`${h.dh}\n${h.n}`);
  if (kept) {
    const text = decrypt(r, kept, h, c);
    r.skipped.delete(`${h.dh}\n${h.n}`);
    return text;
  }
  const next: Ratchet = { ...r, skipped: new Map(r.skipped) };
  if (h.dh !== next.theirs) {
    skipTo(next, h.pn);
    next.pn = next.ns;
    next.ns = 0;
    next.nr = 0;
    next.theirs = h.dh;
    [next.root, next.receiving] = rootStep(next.root, dh(next.mine.privateKey, h.dh));
    next.mine = newPair();
    [next.root, next.sending] = rootStep(next.root, dh(next.mine.privateKey, h.dh));
  }
  skipTo(next, h.n);
  if (!next.receiving) throw new Error('the message is from before this conversation');
  const [chain, messageKey] = chainStep(next.receiving);
  next.receiving = chain;
  next.nr++;
  const text = decrypt(next, messageKey, h, c);
  Object.assign(r, next);
  return text;
}

// What two people read to each other to rule out anyone in the middle: the
// same on both sides, and different if either key is not the one the other sees.
export function safetyNumber(a: string, b: string): string {
  const digest = createHash('sha512').update(['parley safety number', ...[a, b].sort()].join('\n')).digest();
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) groups.push(String(digest.readUIntBE(i * 5, 5) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

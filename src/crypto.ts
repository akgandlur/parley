import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export type Identity = { name: string; publicKey: string; privateKey: string };

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const TAG_BYTES = 16;

function jwkField(key: KeyObject, field: 'x' | 'd'): string {
  const value = key.export({ format: 'jwk' })[field];
  if (!value) throw new Error(`key has no ${field} component`);
  return value;
}

export function newIdentity(name: string): Identity {
  const pair = generateKeyPairSync('ed25519');
  return {
    name,
    publicKey: jwkField(pair.publicKey, 'x'),
    privateKey: jwkField(pair.privateKey, 'd'),
  };
}

// The address is a hash of the key, so a relay cannot hand out someone
// else's key for an address without the mismatch showing.
export function addressOf(publicKey: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest();
  let bits = digest.readBigUInt64BE(0) >> 4n;
  let out = '';
  for (let i = 0; i < 12; i++) {
    out = ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

export function normalizeAddress(input: string): string {
  const bare = input.toLowerCase().replace(/[^0-9a-z]/g, '');
  if (bare.length !== 12 || [...bare].some((c) => !ALPHABET.includes(c))) {
    throw new Error(
      `"${input}" is not a parley address (12 characters, like k7fq-m2xa-9tzp)`,
    );
  }
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8)}`;
}

const ADDRESS = new RegExp(
  `^[${ALPHABET}]{4}[- ]?[${ALPHABET}]{4}[- ]?[${ALPHABET}]{4}$`,
  'i',
);

export const isAddress = (input: string) => ADDRESS.test(input.trim());

export function signText(id: Identity, text: string): string {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: id.publicKey, d: id.privateKey },
    format: 'jwk',
  });
  return sign(null, Buffer.from(text), key).toString('base64url');
}

export function verifyText(
  publicKey: string,
  text: string,
  sig: string,
): boolean {
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
    format: 'jwk',
  });
  return verify(null, Buffer.from(text), key, Buffer.from(sig, 'base64url'));
}

// Each name's ed25519 key also serves as its X25519 key, by the standard map
// between the two curves, so a message can be sealed to an address's key
// with nothing exchanged first.
const P = 2n ** 255n - 19n;

const littleEndian = (buf: Buffer) => buf.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);

function power(base: bigint, exp: bigint): bigint {
  let out = 1n;
  base %= P;
  for (; exp > 0n; exp >>= 1n) {
    if (exp & 1n) out = (out * base) % P;
    base = (base * base) % P;
  }
  return out;
}

function exchangeKeyOf(publicKey: string): KeyObject {
  const raw = Buffer.from(publicKey, 'base64url');
  raw[31] = raw[31]! & 0x7f;
  const y = littleEndian(raw);
  let u = ((1n + y) * power((1n - y + P) % P, P - 2n)) % P;
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++, u >>= 8n) out[i] = Number(u & 255n);
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: out.toString('base64url') }, format: 'jwk' });
}

function exchangePrivateOf(id: Identity): KeyObject {
  const d = createHash('sha512').update(Buffer.from(id.privateKey, 'base64url')).digest().subarray(0, 32);
  const x = exchangeKeyOf(id.publicKey).export({ format: 'jwk' }).x;
  return createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: d.toString('base64url'), x }, format: 'jwk' });
}

// A fresh key pair for every message, so the zero nonce never repeats under a key.
function messageKey(shared: Buffer, eph: string, to: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(`${eph}\n${to}`), Buffer.from('parley message'), 32));
}

const NONCE = Buffer.alloc(12);

export function sealTo(theirKey: string, plaintext: string): { eph: string; box: string } {
  const pair = generateKeyPairSync('x25519');
  const eph = jwkField(pair.publicKey, 'x');
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: exchangeKeyOf(theirKey) });
  const cipher = createCipheriv('aes-256-gcm', messageKey(shared, eph, theirKey), NONCE);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { eph, box: body.toString('base64url') };
}

export function openFor(me: Identity, eph: string, box: string): string {
  const shared = diffieHellman({
    privateKey: exchangePrivateOf(me),
    publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: eph }, format: 'jwk' }),
  });
  const raw = Buffer.from(box, 'base64url');
  const split = raw.length - TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', messageKey(shared, eph, me.publicKey), NONCE);
  decipher.setAuthTag(raw.subarray(split));
  return Buffer.concat([decipher.update(raw.subarray(0, split)), decipher.final()]).toString('utf8');
}

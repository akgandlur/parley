import {
  createCipheriv,
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

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

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

// The id is a hash of the key, so a relay cannot hand out someone else's
// key for an id without the mismatch showing.
export function addressOf(publicKey: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest();
  let n = digest.readBigUInt64BE(0);
  let out = '';
  for (let i = 0; i < 9; i++) {
    out = LETTERS[Number(n % 26n)] + out;
    n /= 26n;
  }
  return `${out.slice(0, 3)}-${out.slice(3, 6)}-${out.slice(6)}`;
}

// The hyphens are required: without them any nine-letter name would read as an id.
const ADDRESS = /^[a-z]{3}-[a-z]{3}-[a-z]{3}$/i;

export const isAddress = (input: string) => ADDRESS.test(input.trim());

export function normalizeAddress(input: string): string {
  if (!isAddress(input)) {
    throw new Error(`"${input}" is not a parley id (nine letters, like kfq-mxa-tzp)`);
  }
  return input.trim().toLowerCase();
}

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

// What parley before 0.9 seals a message with: the name's ed25519 key serves
// as its X25519 key, by the standard map between the two curves. Kept only so
// a session on 0.8 can be told, in a message it can read, that it has to update.
const P = 2n ** 255n - 19n;

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
  const y = raw.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
  let u = ((1n + y) * power((1n - y + P) % P, P - 2n)) % P;
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++, u >>= 8n) out[i] = Number(u & 255n);
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: out.toString('base64url') }, format: 'jwk' });
}

export function sealTo08(theirKey: string, plaintext: string): { eph: string; box: string } {
  const pair = generateKeyPairSync('x25519');
  const eph = jwkField(pair.publicKey, 'x');
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: exchangeKeyOf(theirKey) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(`${eph}\n${theirKey}`), Buffer.from('parley message'), 32));
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(12));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { eph, box: body.toString('base64url') };
}

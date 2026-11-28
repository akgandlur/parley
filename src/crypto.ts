import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
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

// Without the hyphens any nine-letter name would read as an id.
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

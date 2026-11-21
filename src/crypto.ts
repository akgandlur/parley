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
export type Ephemeral = { publicKey: string; privateKey: KeyObject };
export type SessionKeys = { send: Buffer; recv: Buffer };
export type Role = 'caller' | 'callee';

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

export function newEphemeral(): Ephemeral {
  const pair = generateKeyPairSync('x25519');
  return {
    publicKey: jwkField(pair.publicKey, 'x'),
    privateKey: pair.privateKey,
  };
}

export function deriveSessionKeys(
  mine: Ephemeral,
  theirs: string,
  session: string,
  role: Role,
): SessionKeys {
  const shared = diffieHellman({
    privateKey: mine.privateKey,
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: theirs },
      format: 'jwk',
    }),
  });
  const key = (label: string) =>
    Buffer.from(
      hkdfSync('sha256', shared, Buffer.from(session), Buffer.from(label), 32),
    );
  const fromCaller = key('parley caller to callee');
  const fromCallee = key('parley callee to caller');
  return role === 'caller'
    ? { send: fromCaller, recv: fromCallee }
    : { send: fromCallee, recv: fromCaller };
}

// seq is the nonce. It must never repeat under one key, which holds because
// each direction has its own key and its own counter.
function nonceFor(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(seq, 8);
  return nonce;
}

export function seal(key: Buffer, seq: number, plaintext: string): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(seq));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]).toString('base64url');
}

export function open(key: Buffer, seq: number, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  const split = raw.length - TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(seq));
  decipher.setAuthTag(raw.subarray(split));
  return Buffer.concat([
    decipher.update(raw.subarray(0, split)),
    decipher.final(),
  ]).toString('utf8');
}

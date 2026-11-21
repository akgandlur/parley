import { addressOf, signText, verifyText, type Identity } from './crypto';

// Proof, signed by a parley cloud, that a key belongs to an account whose
// email was verified (or to a visitor the cloud let in through an invite).
export type Attestation = {
  v: 1;
  key: string;
  address: string;
  sub: string;
  domain: string | null;
  kind: 'account' | 'visitor';
  via?: string;
  iat: number;
  exp: number;
};

const SIGNED_AS = 'parley-attest\n';

export function makeAttestation(
  issuer: Identity,
  a: Omit<Attestation, 'v' | 'address'>,
): string {
  const body = JSON.stringify({
    v: 1,
    key: a.key,
    address: addressOf(a.key),
    sub: a.sub,
    domain: a.domain,
    kind: a.kind,
    ...(a.via ? { via: a.via } : {}),
    iat: a.iat,
    exp: a.exp,
  });
  return `${Buffer.from(body).toString('base64url')}.${signText(issuer, SIGNED_AS + body)}`;
}

const signedBy = (issuer: string, body: string, sig: string) => {
  try {
    return verifyText(issuer, SIGNED_AS + body, sig);
  } catch {
    return false;
  }
};

// The relay sends these messages as a WebSocket close reason, which is cut
// off at 123 bytes: keep every one of them short.
export function readAttestation(
  token: string,
  issuers: string[],
  key: string,
  now = Date.now(),
): Attestation {
  const [head, sig, extra] = token.split('.');
  if (!head || !sig || extra !== undefined) throw new Error('the account proof is malformed');
  const body = Buffer.from(head, 'base64url').toString();
  if (!issuers.some((issuer) => signedBy(issuer, body, sig))) {
    throw new Error('the account proof is not from a known parley cloud');
  }
  const a = JSON.parse(body) as Attestation;
  if (a.v !== 1) throw new Error('the account proof is of an unknown version');
  if (a.key !== key || a.address !== addressOf(key)) {
    throw new Error('the account proof is for another key');
  }
  if (a.exp * 1000 <= now) throw new Error('the account proof has expired');
  return a;
}

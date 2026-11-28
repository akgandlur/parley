import { addressOf, signText, verifyText, type Identity } from './crypto';

export type Attestation = {
  v: 1;
  key: string;
  address: string;
  sub: string;
  domain: string | null;
  kind: 'account' | 'visitor';
  via?: string;
  nets?: string[];
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
    ...(a.nets?.length ? { nets: [...a.nets].sort() } : {}),
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

// The relay sends these as a WebSocket close reason, cut at 123 bytes.
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

# Security

## What parley protects

- **Only the two sessions can read a message.** It is encrypted end to end,
  sealed to the other session's key, not to the relay or the cloud.
- **Past messages stay sealed if a key leaks later.** Each message has its
  own key and every reply mixes in a fresh key exchange, so a key taken today
  does not open earlier messages, nor later ones once the other side replies.
- **You can check who is on the other end.** Each id is a hash of that
  session's public key, so the relay cannot swap in a different key without
  the id changing. Two people can read a safety number aloud to confirm no
  one is in the middle.

## What it does not protect

- **Your own machine.** An agent with a shell runs as you and can read your
  keys. parley is about the wire between machines, not the machine.
- **Who talks to whom.** The relay sees which sessions exchange messages and
  when, and holds mail for an offline session. It never sees the contents.
- **Mail at rest.** A message to an offline session waits sealed to keys that
  sit on that machine's disk until it is read. Someone who copies that disk
  before it is read could read that message. A per-use key limits this to
  messages not yet read.

## The cryptography

parley uses a handshake modelled on Signal's X3DH and the Signal Double
Ratchet for messages. The primitives under it, X25519, Ed25519, HKDF, HMAC,
SHA-2 and AES-256-GCM, come from Node's `crypto`, which is OpenSSL. parley
does not implement any of those itself.

The handshake and ratchet construction on top of them is parley's own code,
in `src/ratchet.ts`. It has not been independently audited. `test/vectors.json`
pins the key derivations to fixed inputs and outputs so another
implementation, or a reviewer, can check them exactly; `scripts/e2e.ts`
verifies the full exchange against the reference on every run. The wire
format is written out in `SPEC.md`.

If that is not a bar you are willing to trust for your use, run your own
relay, read the code, or wait for an audit. Review of `src/ratchet.ts` is
welcome.

## What the relay and the cloud can see

- **The relay** learns which ids are online, which exchange messages and
  when, and it stores sealed mail for an offline id. It cannot open any of
  it. You can run your own.
- **The cloud** (parley.codes) verifies an email to issue an account, links
  machines, and keeps network membership. It never holds a session's private
  key and never sees a message.

## Reporting a problem

Email security@parley.codes rather than opening a public issue. Please give
steps to reproduce. A second pair of eyes on `src/ratchet.ts` is the most
useful thing you can send.

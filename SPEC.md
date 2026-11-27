# The parley protocol

What two parley sessions and a relay say to each other, so that another
implementation can talk with this one. `scripts/e2e.ts` checks every rule
here against the reference, and is the conformance suite. Version 3 of the
wire format, as of parley 0.11.

Everything on the wire is JSON. Keys and signatures are base64url with no
padding. Times are ISO 8601 in UTC.

## 1. Identities and ids

A **name** is an Ed25519 key pair with a display name. Its public key is the
`x` of its JWK (32 bytes, base64url). Signatures are Ed25519 over the UTF-8
bytes of the text named below, base64url.

An **id** is derived from the public key: SHA-256 of the raw 32 key bytes,
the first 64 bits read big-endian as an unsigned integer, written in base 26
with the letters `a`–`z` as nine digits (most significant first), and
hyphenated `xxx-xxx-xxx`. Ids are compared lower-case. A name cannot be
shaped like an id.

A **machine** has an Ed25519 key of its own in the same form.

## 2. Relay

A relay is a WebSocket server. It learns who is online and who sends to
whom; it never sees plaintext.

```
relay → client   {"t":"challenge","nonce":<24 random bytes, base64url>}
client → relay   {"t":"hello","publicKey":<key>,"sig":<sig>,"att":<proof or absent>}
                 sig is over "parley relay auth " + nonce
relay → client   {"t":"ready","address":<id>}
client → relay   {"t":"send","to":<id>,"ref":<string>,"payload":<object>}
relay → client   {"t":"recv","from":<id>,"payload":<object>}
relay → client   {"t":"undeliverable","to":<id>,"ref":<ref>}
client → relay   {"t":"renew","att":<proof>}
```

A client has 10 seconds to say hello. A newer connection for an id replaces
the older, which is closed with code 4002. A relay started with issuer keys
admits only a hello whose `att` is a valid account proof (section 6) for
that key, and closes with 4003 otherwise; the proof's expiry closes the
connection unless renewed. Limits: a frame is at most 256 KB; a connection
may send 300 frames and 4 MB in any 10 seconds; the hosted relay allows 100
connections per IP and 50 per account.

A `send` to an id that is not online here or on a peer relay is answered
with `undeliverable` carrying the same `ref`. A client sends to its own id
every 20 seconds as a liveness probe; `undeliverable` for a probe means the
relay lost the connection.

`POST /online` with `{"ids":[…]}` answers `{"online":[…]}`; a caller on the
relay's own machine also gets `talks`, who each id exchanged messages with
and when.

**Peering.** Relays behind one address dial each other on a private port
with a shared secret (`{"t":"peer","secret","from"}`), announce the ids
they hold (`ids`, `on`, `off`), and forward frames (`fwd`, `nack`, `talk`).

## 3. Payloads

Every payload a session sends carries `v: 3`. A session that gets `v` other
than 3 does not read the payload; it may send a note the older version can
read (section 8). Kinds:

| kind | fields | |
|---|---|---|
| `hs1` | `key`, `e`, `sig` | handshake offer |
| `hs2` | `key`, `e`, `sig` | handshake answer |
| `reset` | | the receiver has no conversation with the sender |
| `m` | `h`, `c` | a sealed message (section 5) |

## 4. Handshake

Two sessions that have not talked since either started make a conversation.
It follows Signal's X3DH in spirit, with both sides online, so one-time
keys are exchanged directly rather than left on a server.

The offerer A makes an X25519 pair `ea` and sends `hs1` with
`key` = A's identity key, `e` = `ea.pub`, `sig` over
`"parley hs1\n" + <B's id> + "\n" + ea.pub`.

B checks the signature and that `key` hashes to A's id (and, if B has heard
from that id before, that it is the same key). B makes `eb` and answers
`hs2` with `sig` over `"parley hs2\n" + <A's id> + "\n" + ea.pub + "\n" + eb.pub`.
If both sides offered at once, the handshake from the lower id wins.

Both compute:

```
shared     = X25519(ea, eb)
transcript = SHA-256("parley handshake\n" + A.key + "\n" + ea.pub + "\n" + B.key + "\n" + eb.pub)
root       = HKDF-SHA256(ikm = shared, salt = transcript, info = "parley handshake", 32 bytes)
ad         = transcript
```

Identity keys sign but do not enter the secret, so a stolen identity key
opens no past conversation. B's `eb` doubles as B's first ratchet key. A then
makes a fresh ratchet pair and does one root step with it against `eb`
(section 5), and can send; B can send once it has received.

A handshake unanswered for 15 seconds fails. `reset` from the other side, or
a message from it that does not open, means the conversation is gone and a
new handshake starts.

## 5. Messages: the Double Ratchet

Signal's Double Ratchet with these constants:

```
rootStep(root, dh)      = HKDF-SHA256(ikm = dh, salt = root, info = "parley ratchet root", 64 bytes)
                          → new root (first 32), new chain key (last 32)
chainStep(chain)        = HMAC-SHA256(chain, 0x02) → new chain key
                          HMAC-SHA256(chain, 0x01) → message key
cipherKeys(messageKey)  = HKDF-SHA256(ikm = messageKey, salt = 32 zero bytes, info = "parley message key", 44 bytes)
                          → AES-256-GCM key (32), nonce (12)
```

A sealed message is `{"h":{"dh":<sender's ratchet public key>,"pn":<n>,"n":<n>},"c":<base64url>}`.
`c` is AES-256-GCM over the UTF-8 plaintext with the associated data
`ad || UTF-8(dh + "\n" + pn + "\n" + n)` and the 16-byte tag appended. A
header's `dh` that differs from the last seen triggers a DH ratchet step
(receive, then a new sending pair). Up to 200 message keys may be skipped and
kept for out-of-order delivery. A message that does not open leaves the
ratchet unchanged.

Ratchet state lives in memory only. Closing the session ends the
conversation; nothing is written to disk.

## 6. What is inside a message

The plaintext of `m` is JSON:

| `t` | fields | |
|---|---|---|
| `msg` | `id`, `name`, `at`, `att`, `text`, `urgent?` | a message for the session |
| `ack` | `id`, `name`, `error?` | the receiver has the message with that id |
| `secret` | `id`, `name`, `at`, `att`, `label`, `value`, `use` | a secret for the receiver's vault |

`id` is 9 random bytes, base64url, and a receiver drops an `id` it has seen.
`name` is the sender's display name as it is now. `att` is the sender's
account proof, or absent. A sender waits 15 seconds for `ack` and reports
failure otherwise. `text` is at most 150,000 characters.

## 7. Account proofs

A cloud (parley-cloud) vouches that a key belongs to an account. A proof is
`base64url(body) + "." + sig`, `sig` the issuer's Ed25519 signature over
`"parley-attest\n" + body`, and `body` the JSON:

```
{"v":1,"key":<key>,"address":<id of key>,"sub":<account id>,"domain":<email domain or null>,
 "kind":"account","nets":[<network id>…]?,"iat":<unix s>,"exp":<unix s>}
```

Field order is as written; `nets` is present only when non-empty and is
sorted. A receiver checks the signature against the issuers it trusts (its
own cloud's key), that `key` and `address` match the sender, and `exp`. A
proof lasts 24 hours and a session renews it when under 18 hours remain, or
at once when its networks change.

The cloud's API, all signed by the name's key with headers `x-parley-key`,
`x-parley-time` and `x-parley-sig` over
`"parley-cloud-<purpose>\n" + time + "\n" + SHA-256-hex(body)`, time within 5
minutes:

| | purpose | body | answer |
|---|---|---|---|
| `POST /api/attest` | `attest` | `{"name","machine":{"key","sig"}}` | `{"att","issuer"}`, or 403 `not linked` / `banned` |
| `POST /api/people` | `people` | `{"ids":[…]}` | `{"mine":[…],"nets":[…],"online":[…]}` |
| `POST /api/secrets` | `secret` | a request for a secret | a one-time link |

`machine.sig` is the machine key's signature over `"parley-cloud-machine\n" + <name's key>`,
by which a linked machine vouches for a new name on it. A machine is linked
by its person opening `/link?kind=machine&key&name&t&sig` while signed in,
`sig` over `"parley-cloud-link-machine\n" + <origin> + "\n" + t + "\n" + name`,
good for 15 minutes. `GET /api/issuer` gives the issuer key.

## 8. Networks

A network is a set of accounts on one cloud, with an id of 8 letters. The
cloud lists an account's networks in its proofs (`nets`). Two sessions whose
proofs come from the same issuer and name a common network id are
**teammates**: the receiver presents the message as its user's own request.
Membership is the cloud's record; the relay and the message format do not
change. `/api/people` lists every member of each network with their
sessions, so teammates can be addressed by name before any message.

## 9. Version notes

A session that receives a payload with `v < 3` and a `key` that hashes to the
sender's id sends one note the old version can read (kind `msg`, `v: 2`,
sealed with NaCl-box-style X25519 from the Ed25519 keys), telling it to
update, at most once in ten minutes per id. A payload with `v > 3` makes the
receiver tell its user to update.

## 10. Safety number

`safetyNumber(a, b)`: SHA-512 over `"parley safety number\n" + min(a,b) + "\n" + max(a,b)`;
six groups of five digits, group *i* being bytes `5i..5i+5` read as an
integer modulo 100,000, zero-padded.

## Not yet specified

Store-and-forward for a session that is not open (which needs prekeys), a
per-machine daemon, and delivery into agents other than Claude Code. Each
will be a numbered section here before it ships.

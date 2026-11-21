import { z } from 'zod';

export const VERSION = '0.3.0';

export type Who = 'me' | 'peer';

export const LIMITS = {
  name: 60,
  title: 200,
  reason: 500,
  text: 20_000,
  itemsAtCall: 20,
  itemsTotal: 50,
};

const name = z.string().min(1).max(LIMITS.name);
const title = z.string().min(1).max(LIMITS.title);
const reason = z.string().max(LIMITS.reason);
const text = z.string().min(1).max(LIMITS.text);
const item = z.string().min(1).max(12);

const signedBase = {
  session: z.string(),
  seq: z.number().int().nonnegative(),
  from: z.string(),
  at: z.string(),
};

export const EntrySchema = z.discriminatedUnion('type', [
  z.object({
    ...signedBase,
    type: z.literal('call'),
    name,
    title,
    items: z.array(title).min(1).max(LIMITS.itemsAtCall),
  }),
  z.object({ ...signedBase, type: z.literal('accept'), name }),
  z.object({ ...signedBase, type: z.literal('decline'), reason }),
  z.object({ ...signedBase, type: z.literal('say'), item, text }),
  z.object({ ...signedBase, type: z.literal('add_item'), id: item, title }),
  z.object({ ...signedBase, type: z.literal('propose'), item, text }),
  z.object({ ...signedBase, type: z.literal('agree'), item, ref: z.string() }),
  z.object({ ...signedBase, type: z.literal('drop'), item, reason }),
  z.object({ ...signedBase, type: z.literal('hangup'), reason }),
]);

export type Entry = z.infer<typeof EntrySchema>;
export type EntryBody = Entry extends infer E
  ? E extends Entry
    ? Omit<E, keyof typeof signedBase>
    : never
  : never;

export const ControlSchema = z.object({
  kind: z.enum(['ring', 'ringing', 'busy']),
  // The id names a directory on the receiving side, so only hex gets in.
  session: z.string().regex(/^[0-9a-f]{16}$/),
  to: z.string(),
  at: z.string(),
  eph: z.string().optional(),
});

export type Control = z.infer<typeof ControlSchema>;

export const ArgSchemas = {
  call: z.object({
    address: z.string(),
    title,
    items: z.array(title).min(1).max(LIMITS.itemsAtCall),
  }),
  wait: z.object({
    cursor: z.number().int().min(-1),
    timeoutMs: z.number().int().min(0).max(600_000),
  }),
  say: z.object({ item, text }),
  add_item: z.object({ title }),
  propose: z.object({ item, text }),
  agree: z.object({ item, proposal: z.string() }),
  drop: z.object({ item, reason }),
  hangup: z.object({ reason }),
  approve: z.object({ accept: z.boolean(), reason: reason.optional() }),
  cloud_link: z.object({ url: z.string().max(500).optional() }),
};

export type SessionState =
  | 'dialing'
  | 'ringing'
  | 'awaiting_approval'
  | 'active'
  | 'closing'
  | 'ended';

export type ProposalView = { ref: string; text: string };

export type ItemView = {
  id: string;
  title: string;
  addedBy: Who | 'call';
  state: 'open' | 'agreed' | 'dropped';
  mine?: ProposalView;
  theirs?: ProposalView;
  agreed?: { text: string; proposedBy: Who };
  dropReason?: string;
};

export type SessionView = {
  id: string;
  role: 'caller' | 'callee';
  state: SessionState;
  peer: { address: string; name?: string; knownSince?: string; savedAs?: string };
  // Set on the copy an agent is given of a call nobody has accepted yet.
  withheld?: true;
  title: string;
  items: ItemView[];
  endedReason?: string;
  minutes?: string;
  peerQuietSeconds?: number;
};

export type FeedEntry = {
  n: number;
  by: Who;
  at: string;
  type: Entry['type'];
  item?: string;
  text?: string;
  ref?: string;
};

export type View = {
  cursor: number;
  approval: 'dialog' | 'terminal';
  viewer: string;
  me: { name: string; address: string };
  relay: { url: string; connected: boolean; error?: string };
  cloud?: { url: string; syncing: boolean; error?: string };
  session?: SessionView;
};

export type Ev = { n: number } & (
  | { kind: 'incoming' }
  | { kind: 'opened' }
  | { kind: 'ended'; reason: string }
  | { kind: 'impostor'; address: string }
  | { kind: 'say'; item: string; text: string }
  | { kind: 'add_item'; item: string; title: string }
  | { kind: 'propose'; item: string; ref: string; text: string }
  | { kind: 'agree'; item: string; ref: string }
  | { kind: 'drop'; item: string; reason: string }
);

export type EvBody = Ev extends infer E
  ? E extends Ev
    ? Omit<E, 'n'>
    : never
  : never;

export type WaitResult = { events: Ev[]; cursor: number; view: View };

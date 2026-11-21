import type { Ev, ItemView, SessionView, SideView, Verified, View } from './types';

const STATE_TEXT: Record<SessionView['state'], string> = {
  dialing: 'calling',
  ringing: 'being called',
  awaiting_approval: 'waiting for a person to accept',
  active: 'open',
  closing: 'ending',
  ended: 'ended',
};

export const verifiedText = (v: Verified | undefined) =>
  !v
    ? 'not verified'
    : v.kind === 'visitor'
      ? 'visitor · through an invite link'
      : v.domain
        ? `verified · ${v.domain}`
        : 'verified';

const label = (x: SideView) =>
  `${x.name ? `"${x.name}"` : 'an unnamed side'} (${x.id}, ${x.address}) [${verifiedText(x.verified)}]${x.left ? `, who left: ${x.left}` : ''}`;

const who = (s: SessionView) =>
  s.sides
    ? s.sides.filter((x) => !x.you).map(label).join(', ')
    : `${s.peer.name ? `"${s.peer.name}"` : s.withheld ? 'a new caller' : 'an unnamed caller'} (${s.peer.address}) [${verifiedText(s.peer.verified)}]`;

const sideName = (s: SessionView, id: string) => {
  const x = s.sides?.find((y) => y.id === id);
  return x?.you ? 'you' : `${x?.name ?? x?.address ?? 'unknown'} (${id})`;
};

// Until a person accepts, the caller's name and agenda are a stranger's
// words: anyone who has the address can ring. The person is shown them
// where they answer. The agent gets the address and, for a contact, the
// name saved when an earlier call was accepted.
export function forAgent(v: View): View {
  const s = v.session;
  if (s?.role !== 'callee' || (s.state !== 'ringing' && s.state !== 'awaiting_approval')) {
    return v;
  }
  return {
    ...v,
    session: {
      ...s,
      withheld: true,
      title: '',
      items: [],
      peer: { ...s.peer, name: s.peer.savedAs },
      sides: s.sides?.map((x) => (x.you ? x : { ...x, name: x.savedAs })),
    },
  };
}

function renderItem(i: ItemView, s: SessionView): string {
  const lines = [`  ${i.id} [${i.state}] ${i.title}`];
  if (i.agreed) lines.push(`      agreed: ${i.agreed.text}`);
  for (const o of i.others ?? []) {
    const agreed = o.agreedBy.map((id) => sideName(s, id));
    lines.push(
      `      ${sideName(s, o.by)} proposes (${o.ref}): ${o.text}${agreed.length ? ` [agreed by ${agreed.join(', ')}]` : ''}`,
    );
  }
  if (i.state === 'dropped') lines.push(`      dropped: ${i.dropReason}`);
  if (i.theirs) {
    lines.push(`      they propose (${i.theirs.ref}): ${i.theirs.text}`);
  }
  if (i.mine) lines.push(`      you proposed (${i.mine.ref}): ${i.mine.text}`);
  return lines.join('\n');
}

export const renderCall = (s: SessionView | undefined) =>
  !s || s.state === 'ended'
    ? 'no call'
    : `session with ${who(s)}, ${STATE_TEXT[s.state]}`;

export function renderView(v: View): string {
  const lines = [
    `You are "${v.me.name}" at ${v.me.address} [${verifiedText(v.me.verified)}]. Relay ${v.relay.connected ? 'connected' : `NOT connected${v.relay.error ? `: ${v.relay.error}` : ''}`} (${v.relay.url}).`,
  ];
  // A node from before the live view existed can still be finishing a call.
  if (v.viewer) lines.push(`Live view for your user: ${v.viewer}`);
  const c = v.cloud;
  if (c?.link) {
    lines.push(
      `This name is not linked to a parley account yet${v.relay.refused ? ', so the relay will not let it on' : ''}. Ask your user to open this link while signed in to ${c.url}; it works for 15 minutes:`,
      c.link,
    );
  } else if (v.relay.refused) {
    lines.push(
      c?.url
        ? `The relay needs this name linked to a parley account. Waiting on ${c.url}${c.error ? `: ${c.error}` : ''}.`
        : 'The relay needs this name linked to a parley account. Ask your user for their parley cloud address, then link this name with cloud_link (or `parley cloud link --url <address>`).',
    );
  } else if (c?.url) {
    lines.push(
      c.error
        ? `Cloud: NOT reaching ${c.url}: ${c.error}`
        : c.sync
          ? `Cloud: this name's sessions are sent to ${c.url}.`
          : `Cloud: linked to ${c.url}, which keeps none of this name's sessions.`,
    );
  }
  const s = v.session;
  if (!s) return [...lines, 'No session.'].join('\n');
  lines.push(
    `Session with ${who(s)}: ${STATE_TEXT[s.state]}${s.endedReason ? ` (${s.endedReason})` : ''}.`,
  );
  if (s.state === 'awaiting_approval' && s.role === 'callee') {
    lines.push(
      s.peer.knownSince
        ? `First connected to this address on ${s.peer.knownSince.slice(0, 10)}.`
        : 'This address has not connected here before.',
    );
  }
  if (s.peerQuietSeconds !== undefined) {
    lines.push(
      `Nothing has been heard from the other side for ${s.peerQuietSeconds} seconds; it may be offline.`,
    );
  }
  for (const x of s.sides ?? []) {
    if (x.quietSeconds === undefined) continue;
    lines.push(
      `Nothing has been heard from ${label(x)} for ${x.quietSeconds} seconds; it may be offline.`,
    );
  }
  if (s.withheld) {
    lines.push(
      'What the caller calls itself and its agenda are shown to your user where they answer. You are given them once your user accepts.',
    );
  }
  if (s.title) lines.push(`Agenda: ${s.title}`, ...s.items.map((i) => renderItem(i, s)));
  if (s.minutes) lines.push(`Minutes: ${s.minutes}`);
  return lines.join('\n');
}

export function renderEvent(e: Ev, v: View): string {
  const s = v.session;
  switch (e.kind) {
    case 'incoming':
      return s
        ? `Incoming call from ${who(s)}. A person has to accept or decline it.`
        : 'Incoming call.';
    case 'opened':
      return 'The session is open.';
    case 'ended':
      return `The session ended: ${e.reason}.`;
    case 'impostor':
      return `A call from ${e.address} was refused. That address is one of your contacts, but the caller did not hold the key saved for it, so it is not that contact. Tell your user.`;
    case 'say':
      return `[${e.item}] ${e.by ?? 'they'} said: ${e.text}`;
    case 'add_item':
      return `[${e.item}] ${e.by ?? 'they'} added an agenda item: ${e.title}`;
    case 'propose':
      return `[${e.item}] ${e.by ?? 'they'} propose${e.by ? 's' : ''} (${e.ref}): ${e.text}`;
    case 'agree':
      return e.by
        ? `[${e.item}] ${e.by} agreed to proposal ${e.ref}.`
        : `[${e.item}] they agreed to your proposal ${e.ref}. The item is closed.`;
    case 'drop':
      return `[${e.item}] ${e.by ?? 'they'} dropped the item: ${e.reason}`;
    case 'left':
      return `${e.who} left the session: ${e.reason}`;
  }
}

export function renderMinutes(v: View, started: Date, ended: Date): string {
  const s = v.session;
  if (!s) throw new Error('no session to write minutes for');
  const mine = `${v.me.name} (${v.me.address}, ${verifiedText(v.me.verified)})`;
  const theirs = `${s.peer.name} (${s.peer.address}) [${verifiedText(s.peer.verified)}]`;
  const named = (id: string) => {
    const x = s.sides?.find((y) => y.id === id);
    return x?.name ?? x?.address;
  };
  const by = (p: 'me' | 'peer', id?: string) =>
    id ? named(id) : p === 'me' ? v.me.name : s.peer.name;
  const of = (state: ItemView['state']) => s.items.filter((i) => i.state === state);
  const added = (i: ItemView) =>
    i.addedBy === 'call' ? '' : ` (added during the session by ${by(i.addedBy, i.addedById)})`;
  const all = s.sides?.map((x) => `${x.name ?? 'unnamed'} (${x.address}, ${verifiedText(x.verified)})`);
  const between = all
    ? `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
    : `${mine} and ${theirs}`;
  const leavers = s.sides?.filter((x) => x.left) ?? [];

  const out = [
    `# ${s.title}`,
    '',
    `- Between: ${between}`,
    `- Called by: ${s.sides ? named('a') : s.role === 'caller' ? v.me.name : s.peer.name}`,
    ...leavers.map((x) => `- Left early: ${x.name ?? x.address}: ${x.left}`),
    `- Started: ${started.toISOString()}`,
    `- Ended: ${ended.toISOString()}`,
    `- How it ended: ${s.endedReason}`,
    '',
    '## Agreed',
    '',
  ];
  for (const i of of('agreed')) {
    out.push(`### ${i.id} · ${i.title}${added(i)}`, '');
    if (i.agreed) {
      out.push(i.agreed.text, '', `Proposed by ${by(i.agreed.proposedBy, i.agreed.proposedById)}.`, '');
    }
  }
  if (!of('agreed').length) out.push('Nothing.', '');
  out.push('## Dropped', '');
  for (const i of of('dropped')) {
    out.push(`- ${i.id} · ${i.title}${added(i)}: ${i.dropReason}`);
  }
  if (!of('dropped').length) out.push('Nothing.');
  out.push('', '## Left open', '');
  for (const i of of('open')) out.push(`- ${i.id} · ${i.title}${added(i)}`);
  if (!of('open').length) out.push('Nothing.');
  out.push(
    '',
    `Every entry ${s.sides ? 'every side' : 'both sides'} sent is in transcript.jsonl beside this file, each one signed by its sender.`,
    '',
  );
  return out.join('\n');
}

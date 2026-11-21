import type { Ev, ItemView, SessionView, View } from './types';

const STATE_TEXT: Record<SessionView['state'], string> = {
  dialing: 'calling',
  ringing: 'being called',
  awaiting_approval: 'waiting for a person to accept',
  active: 'open',
  closing: 'ending',
  ended: 'ended',
};

const who = (s: SessionView) =>
  `${s.peer.name ? `"${s.peer.name}"` : s.withheld ? 'a new caller' : 'an unnamed caller'} (${s.peer.address})`;

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
    },
  };
}

function renderItem(i: ItemView): string {
  const lines = [`  ${i.id} [${i.state}] ${i.title}`];
  if (i.agreed) lines.push(`      agreed: ${i.agreed.text}`);
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
    `You are "${v.me.name}" at ${v.me.address}. Relay ${v.relay.connected ? 'connected' : `NOT connected${v.relay.error ? `: ${v.relay.error}` : ''}`} (${v.relay.url}).`,
  ];
  // A node from before the live view existed can still be finishing a call.
  if (v.viewer) lines.push(`Live view for your user: ${v.viewer}`);
  if (v.cloud) {
    lines.push(
      v.cloud.syncing
        ? `Cloud: this name's sessions are sent to ${v.cloud.url}.`
        : `Cloud: NOT reaching ${v.cloud.url}: ${v.cloud.error}`,
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
  if (s.withheld) {
    lines.push(
      'What the caller calls itself and its agenda are shown to your user where they answer. You are given them once your user accepts.',
    );
  }
  if (s.title) lines.push(`Agenda: ${s.title}`, ...s.items.map(renderItem));
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
      return `[${e.item}] they said: ${e.text}`;
    case 'add_item':
      return `[${e.item}] they added an agenda item: ${e.title}`;
    case 'propose':
      return `[${e.item}] they propose (${e.ref}): ${e.text}`;
    case 'agree':
      return `[${e.item}] they agreed to your proposal ${e.ref}. The item is closed.`;
    case 'drop':
      return `[${e.item}] they dropped the item: ${e.reason}`;
  }
}

export function renderMinutes(v: View, started: Date, ended: Date): string {
  const s = v.session;
  if (!s) throw new Error('no session to write minutes for');
  const mine = `${v.me.name} (${v.me.address})`;
  const theirs = `${s.peer.name} (${s.peer.address})`;
  const by = (p: 'me' | 'peer') => (p === 'me' ? v.me.name : s.peer.name);
  const of = (state: ItemView['state']) => s.items.filter((i) => i.state === state);
  const added = (i: ItemView) =>
    i.addedBy === 'call' ? '' : ` (added during the session by ${by(i.addedBy)})`;

  const out = [
    `# ${s.title}`,
    '',
    `- Between: ${mine} and ${theirs}`,
    `- Called by: ${s.role === 'caller' ? v.me.name : s.peer.name}`,
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
      out.push(i.agreed.text, '', `Proposed by ${by(i.agreed.proposedBy)}.`, '');
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
    'Every entry both sides sent is in transcript.jsonl beside this file, each one signed by its sender.',
    '',
  );
  return out.join('\n');
}

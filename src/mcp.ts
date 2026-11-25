import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { verifiedText, type People } from './account';
import { startAgent, type Agent, type Incoming } from './agent';
import { isAddress, normalizeAddress } from './crypto';
import {
  addressFor,
  callable,
  holder,
  loadConfig,
  loadContacts,
  locals,
  mine,
  sameName,
  take,
  type Local,
} from './home';
import { canInject, inject } from './inject';
import { myName } from './local';
import { setUp } from './setup';
import { NAME_MAX, TEXT_MAX, VERSION } from './types';

const INSTRUCTIONS = `parley lets this Claude Code session message Claude Code sessions on other machines and other people's. It is for other machines only: to message a session on this machine, use SendMessage.

To be reachable, a session takes a parley name with setup; by default that is its Claude Code session name. It also gets an id, like kfq-mxa-tzp: give your user the id when they want someone to reach this session. send_message sends to an id, or to a name list_agents shows. Messages sent to this session arrive in the conversation by themselves, also while it is idle. Reply with send_message to the name on the message.

The hosted relay lets a session on once its machine is linked to a parley account, which is done once per machine. When list_agents shows a link, give it to your user to open while signed in.`;

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), 'parley:', ...parts);

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function unnamed(): string {
  const here = locals();
  if (!here.length) {
    return 'This Claude Code session has no parley name, and this machine has none yet. Use the setup tool: with no name it takes this session\'s Claude Code name.';
  }
  const lines = here.map((l) => {
    const use = holder(l.address) ? 'in use by another Claude Code session' : 'free';
    return `  "${l.name}" (${l.address}): ${use}`;
  });
  return [
    'This Claude Code session has no parley name yet. Names on this machine:',
    ...lines,
    'Use the setup tool with a free name to be it in this session, or with a new name for a separate id. If your user named one, use that. If there is exactly one name and it is free, take it. Otherwise ask your user which name this session should have.',
  ].join('\n');
}

function replyTo(m: Incoming): string {
  const hits = callable('').filter((n) => sameName(n.name, m.from.name));
  return hits.length === 1 && hits[0]?.address === m.from.address ? m.from.name : m.from.address;
}

// What the receiving Claude reads. Claude Code wraps it as a message from
// another of its own sessions, so this says where it came from and how to answer.
const sender = (m: Incoming) => `"${m.from.name}" (${m.from.address}, ${verifiedText(m.from.verified)})`;
const URGENT = 'marked urgent by its sender';

function shown(ms: Incoming[]): string {
  const [m] = ms;
  if (ms.length === 1 && m) {
    return [
      `parley message from ${sender(m)}${m.urgent ? `, ${URGENT}` : ''}:`,
      '',
      m.text,
      '',
      `It came through parley, so reply with parley's send_message to "${replyTo(m)}", not SendMessage.`,
    ].join('\n');
  }
  const bySender = new Map<string, Incoming[]>();
  for (const one of ms) bySender.set(one.from.address, [...(bySender.get(one.from.address) ?? []), one]);
  const lines = [`${ms.length} parley messages came in close together, from ${bySender.size === 1 ? 'one session' : `${bySender.size} sessions`}. They are in the order they arrived, by sender.`];
  for (const group of bySender.values()) {
    const last = group[group.length - 1]!;
    lines.push('', `From ${sender(last)}, to answer with send_message to "${replyTo(last)}":`);
    group.forEach((one, i) => lines.push('', `${i + 1}.${one.urgent ? ` (${URGENT})` : ''} ${one.text}`));
  }
  lines.push('', "They came through parley, so reply with parley's send_message, not SendMessage.");
  return lines.join('\n');
}

// A session many others write to would be interrupted once per message. The
// first goes in at once; what follows within the hold goes in together.
const HOLD_MS = Number(process.env.PARLEY_HOLD_SECONDS ?? 30) * 1000;
if (!(HOLD_MS >= 0)) throw new Error('PARLEY_HOLD_SECONDS has to be a number of seconds, 0 or more');

export async function runMcp() {
  const server = new McpServer({ name: 'parley', version: VERSION }, { instructions: INSTRUCTIONS });
  let agent: Agent | undefined;
  let held: Local | undefined;
  let starting: Promise<void> | undefined;
  const unread: string[] = [];
  let accountNames: { name: string; address: string }[] = [];

  const waiting: Incoming[] = [];
  let holdUntil = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  function release() {
    holdTimer = undefined;
    if (!waiting.length) return;
    holdUntil = Date.now() + HOLD_MS;
    void hand(shown(waiting.splice(0)));
  }

  async function deliver(m: Incoming) {
    if (m.urgent) {
      // With what its sender has waiting, so that sender's messages stay in order.
      const earlier = waiting.filter((w) => w.from.address === m.from.address);
      for (const w of earlier) waiting.splice(waiting.indexOf(w), 1);
      return hand(shown([...earlier, m]));
    }
    if (!waiting.length && Date.now() >= holdUntil) {
      holdUntil = Date.now() + HOLD_MS;
      return hand(shown([m]));
    }
    waiting.push(m);
    holdTimer ??= setTimeout(release, Math.max(0, holdUntil - Date.now()));
  }

  async function hand(content: string) {
    if (canInject()) {
      try {
        return await inject(content);
      } catch (err) {
        log('could not hand a message to the session:', err instanceof Error ? err.message : err);
      }
    }
    unread.push(content);
  }

  async function become(local: Local) {
    agent?.close();
    agent = undefined;
    take(local.address);
    held = local;
    agent = await startAgent(local.home, log, deliver, (text) => void hand(text));
  }

  const reply = async (fn: () => Promise<string>) => {
    try {
      const out = await fn();
      const news = unread.splice(0);
      return text(news.length ? [out, '', 'Messages that came in:', '', ...news].join('\n') : out);
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  };

  const named = (fn: (a: Agent) => Promise<string>) =>
    reply(async () => {
      await starting;
      if (!agent) throw new Error(unnamed());
      return fn(agent);
    });

  server.registerTool(
    'setup',
    {
      description:
        "Give this Claude Code session its parley name, so sessions on other machines can reach it. Without a name it takes this session's Claude Code name. A new name creates an identity with its own id. A free name this machine already has makes this session that name again, with the same id as before. Give your user the id it returns: others need it to reach this session.",
      inputSchema: {
        name: z.string().trim().min(1).max(NAME_MAX).optional().describe("The name others will see; this session's Claude Code name if left out"),
      },
    },
    ({ name: given }) => reply(() => takeName(given)),
  );

  async function takeName(given: string | undefined): Promise<string> {
        const name = given ?? myName();
        if (!name) throw new Error('this Claude Code session has no session name to take; give a name');
        const existing = locals().find((l) => sameName(l.name, name));
        if (held && existing?.address === held.address) {
          return `This session is already "${held.name}" (${held.address}).`;
        }
        if (existing) {
          const other = holder(existing.address);
          if (other) {
            throw new Error(
              `"${existing.name}" is in use by another Claude Code session on this machine (in ${other.dir}). A name belongs to one open session at a time: use that session, close it to free the name, or pick another name.`,
            );
          }
          await become(existing);
          return `This session is now "${existing.name}" (${existing.address}), a name this machine already had.`;
        }
        const [first] = locals();
        const relay = process.env.PARLEY_RELAY ?? (first && loadConfig(first.home).relay);
        if (!relay) throw new Error('no relay is configured: PARLEY_RELAY is not set for this server');
        const made = setUp(name, relay);
        await become(made);
        return `This session is now "${made.name}", a new name. Its id is ${made.address}. Give this id to your user: others need it to reach this session, and can use the name "${made.name}" after you have exchanged a message.`;
  }

  type Row = { name: string; address: string; open?: boolean; note?: string };

  // Whom this session can message, open sessions first in each group.
  async function roster(a: Agent) {
    const self = a.address;
    const contacts = loadContacts();
    const here: Row[] = locals().filter((l) => l.address !== self).map((l) => ({ name: l.name, address: l.address, open: holder(l.address) !== undefined }));
    const others = Object.keys(contacts).filter((id) => id !== self && !here.some((l) => l.address === id));
    let asked: People | undefined;
    let failed: string | undefined;
    try {
      asked = await a.account.people(others);
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    const open = asked?.online && new Set(asked.online);
    const openFirst = (list: Row[]) => [...list].sort((x, y) => Number(y.open ?? false) - Number(x.open ?? false));
    const mine = openFirst(
      (asked?.mine ?? []).filter((m) => !here.some((l) => l.address === m.address)).map((m) => ({ name: m.name, address: m.address, open: open?.has(m.address), note: m.machine && `on ${m.machine}` })),
    );
    accountNames = mine.map(({ name, address }) => ({ name, address }));
    const met = openFirst(
      others.filter((id) => !mine.some((m) => m.address === id)).map((id) => ({ name: contacts[id]!.name, address: id, open: open?.has(id), note: `first heard ${contacts[id]!.firstSeen.slice(0, 10)}` })),
    );
    const row = (r: Row) => `  "${r.name}" (${r.address}): ${[r.open === undefined ? undefined : r.open ? 'open now' : 'not open', r.note].filter(Boolean).join(', ')}`;
    const lines: string[] = [];
    if (failed) lines.push(`Could not ask which sessions are open: ${failed}.`);
    if (mine.length) lines.push('', 'Your sessions on other machines:', ...mine.map(row));
    if (met.length) lines.push('', 'Sessions you have exchanged a message with:', ...met.map(row));
    return { mine, met, here, lines, hereLines: here.length ? ['', 'On this machine, reached with SendMessage, not parley:', ...here.map(row)] : [] };
  }

  const linkText = (url: string | undefined, link: string) =>
    [`This machine is not linked to a parley account yet, so it cannot send or receive. Open this link and sign in at ${url} when it asks; it works for 15 minutes, and is needed once per machine:`, link].join('\n');

  server.registerTool(
    'to',
    {
      description:
        'What the /parley:to command runs, in one call: it gives this session a parley name if it has none, then sends, or says exactly what is missing. `text` is what the user typed after the command: nothing, or an id or name, or an id or name followed by the message. Tell the user what it returns and nothing else.',
      inputSchema: { text: z.string().max(TEXT_MAX + 200).describe('What the user typed after /parley:to, unchanged') },
    },
    ({ text: typed }) =>
      reply(async () => {
        await starting;
        if (!agent) {
          if (!myName() && !locals().length) throw new Error('this Claude Code session has no name for parley to take. Ask the user what to call it, call setup with it, then call this tool again');
          if (!myName()) throw new Error(unnamed());
          await takeName(undefined);
        }
        const a = agent as Agent;
        for (let i = 0; i < 20 && !a.state().relay.connected && !a.state().account.link && !a.state().account.error; i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const s = a.state();
        if (s.account.link) return `${linkText(s.account.url, s.account.link)}\nOnce that is done, the user runs /parley:to again.`;
        if (!s.relay.connected) throw new Error(`parley is not connected, so nothing can be sent: ${s.account.error ?? s.relay.error}`);

        const r = await roster(a);
        const input = typed.trim();
        const [first = ''] = input.split(/\s+/);
        let who: Row | undefined;
        let message = '';
        if (isAddress(first)) {
          const address = normalizeAddress(first);
          if (address === s.address) throw new Error(`${address} is this session's own id`);
          who = [...r.mine, ...r.met, ...r.here].find((x) => x.address === address) ?? { name: address, address };
          message = input.slice(first.length).trim();
        } else if (input) {
          const fits = [...r.mine, ...r.met, ...r.here]
            .filter((x) => input.toLowerCase() === x.name.toLowerCase() || input.toLowerCase().startsWith(`${x.name.toLowerCase()} `))
            .sort((x, y) => y.name.length - x.name.length);
          const best = fits.filter((x) => x.name.length === fits[0]?.name.length);
          if (best.length > 1) return [`More than one session is named "${best[0]!.name}". Ask the user which id they mean:`, ...best.map((x) => `  ${x.address}`)].join('\n');
          who = best[0];
          if (who) message = input.slice(who.name.length).trim();
        }
        if (!who) {
          const head = input ? `Nobody this session can message is named like "${first}".` : undefined;
          if (!r.mine.length && !r.met.length) {
            return [
              head,
              `This session has nobody to message yet. Ask the user for the parley id of the session they want to reach (nine letters like kfq-mxa-tzp; the other person gets it by running /parley:to in their Claude Code), and what to tell it.`,
              `For someone to reach this session instead, the user sends them its id: ${s.address}`,
              ...r.lines,
            ].filter((l) => l !== undefined).join('\n');
          }
          return [head, 'Ask the user who to message, by name or id, and what to say. They can also give an id that is not listed.', ...r.lines, '', `This session is "${s.name}" (${s.address}).`].filter((l) => l !== undefined).join('\n');
        }
        const label = who.name === who.address ? who.address : `"${who.name}" (${who.address})`;
        if (r.here.includes(who)) return `${label} is a session on this machine, which parley is not for. Send it with SendMessage instead.`;
        if (!message) return `${label}${who.open === false ? ' is not open right now, so a message would not arrive; nothing is kept for later.' : ' can be messaged.'} Ask the user what to tell it, then call this tool again with "${who.address}" followed by the message.`;
        const name = await a.send(who.address, message);
        return `Delivered to "${name}" (${who.address}).`;
      }),
  );

  server.registerTool(
    'list_agents',
    {
      description:
        "Show this session's parley name and id, whether it is connected, and the names you can message: your account's sessions on other machines and everyone you have exchanged a message with, each marked open now or not. If this machine is not linked to a parley account yet, it shows the link your user has to open; the hosted relay refuses its sessions until then.",
    },
    () =>
      named(async (a) => {
        if (a.account.state().link || a.account.state().error) await a.account.recheck();
        const s = a.state();
        const lines = [
          `This session is "${s.name}" (${s.address}), ${verifiedText(s.account.verified)}.`,
          s.relay.connected ? 'Connected to the relay.' : `Not connected to the relay: ${s.relay.error}.`,
        ];
        if (s.account.link) {
          lines.push(linkText(s.account.url, s.account.link));
        } else if (s.account.error) {
          lines.push(`Account: ${s.account.error}.`);
        }
        const r = await roster(a);
        lines.push(...r.lines, ...r.hereLines);
        if (!r.mine.length && !r.met.length) lines.push('', 'Nobody to message by name yet. Message an id to start.');
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to a Claude Code session on another machine. It arrives in that conversation by itself, and starts a turn there if the session is idle. When several messages reach a session close together, it gets the first at once and the rest together about half a minute later. Returns once the other side has it, or says why it could not be delivered: most often that no session with that name is open. To reply to a parley message, send to the name it came from. For a session on this machine, use SendMessage.',
      inputSchema: {
        to: z.string().max(100).describe('A parley id like kfq-mxa-tzp, or a name list_agents shows'),
        message: z.string().min(1).max(TEXT_MAX),
        urgent: z
          .boolean()
          .optional()
          .describe('The message goes in at once, not held with others. Only when the other session cannot go on without it, or something is about to go wrong. It is shown as marked urgent by you.'),
      },
    },
    ({ to, message, urgent }) =>
      named(async (a) => {
        const address = addressFor(to, a.address, accountNames);
        const name = await a.send(address, message, urgent === true);
        return `Delivered to "${name}" (${address}).`;
      }),
  );

  server.registerTool(
    'safety_number',
    {
      description:
        "Show the safety number this session shares with a session it has exchanged a message with. The two people compare it over a call or in person: if both see the same number, nobody sits between their sessions. Use it when your user wants to be sure who they are talking to.",
      inputSchema: { with: z.string().max(100).describe('A parley id, or a name list_agents shows') },
    },
    ({ with: who }) =>
      named(async (a) => {
        const address = addressFor(who, a.address, accountNames);
        return `Safety number with ${address}: ${a.safetyNumber(address)}\nIt is the same on their side if nobody is in the middle. Your user compares it with the other person over a call or in person.`;
      }),
  );

  server.registerTool(
    'cloud_link',
    {
      description:
        "Tie this machine to your user's parley account. The hosted relay needs this before a session here can connect, and it is done once per machine: every session on it is then on the account. Returns a link your user opens while signed in there; it works for 15 minutes. Use it when your user asks, or when list_agents says the relay needs an account and gives no link.",
      inputSchema: { url: z.string().max(500).optional().describe('The cloud address, if your user gave one') },
    },
    ({ url }) =>
      named(async (a) => {
        const made = await a.account.link(url ?? process.env.PARLEY_CLOUD);
        return `Give your user this link. They open it while signed in to ${made.url}, and it works for 15 minutes. Use list_agents afterwards to see that the machine is linked:\n${made.link}`;
      }),
  );

  // This process holds the relay connection, so it must not outlive the session.
  // What is still held goes in now: this process ends on a plugin reload too,
  // with the session still there to read it. If the session is gone, the
  // senders were told "Delivered" for something nobody read, so they are told.
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearTimeout(holdTimer);
    const left = waiting.splice(0);
    if (left.length) {
      try {
        await inject(shown(left));
      } catch {
        const a = agent;
        const senders = new Map(left.map((m) => [m.from.address, left.filter((o) => o.from.address === m.from.address).length]));
        const notes = [...senders].map(([to, n]) =>
          a?.send(to, `This is an automatic note from parley, not from the session itself. "${a.name}" closed before reading ${n === 1 ? 'the message' : `the ${n} messages`} you sent it in the last half minute. Send again once it is open.`),
        );
        await Promise.race([Promise.allSettled(notes), new Promise((r) => setTimeout(r, 4000))]);
      }
    }
    process.exit(0);
  }
  process.stdin.on('end', close);
  process.stdin.on('close', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await server.connect(new StdioServerTransport());

  // The server restarts inside one Claude Code session (a plugin reload, a
  // resume): it comes back as the same name, and reachable at once.
  const resumed = mine();
  if (resumed) {
    starting = become(resumed).catch((err) => log(`could not be "${resumed.name}" again:`, err instanceof Error ? err.message : err));
  }
}

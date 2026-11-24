import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { verifiedText } from './account';
import { startAgent, type Agent, type Incoming } from './agent';
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
import { canInject, inject, writeFrame } from './inject';
import { myName, others, peerToken, sessionNamed, type Session } from './local';
import { setUp } from './setup';
import { NAME_MAX, TEXT_MAX, VERSION } from './types';

const INSTRUCTIONS = `parley lets this Claude Code session message any Claude Code session by name: the ones on this machine, the way SendMessage does, and the ones on other machines and other people's.

A session on this machine is reached by its Claude Code session name, with no setup. To be reachable from other machines, a session takes a parley name with setup; by default that is its Claude Code session name. It also gets an id, like kfq-mxa-tzp: give your user the id when they want someone elsewhere to reach this session. send_message sends to a session name, an id, or a name list_agents shows. Messages sent to this session arrive in the conversation by themselves, also while it is idle. Reply with send_message to the name on the message.

The hosted relay lets a session on once its machine is linked to a parley account, which is done once per machine. When list_agents shows a link, give it to your user to open while signed in.`;

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), 'parley:', ...parts);

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function unnamed(): string {
  const here = locals();
  if (!here.length) {
    return 'This Claude Code session has no parley name, and this machine has none yet. It reaches sessions on this machine without one. To reach or be reached from other machines, use the setup tool: with no name it takes this session\'s Claude Code name.';
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
function shown(m: Incoming): string {
  return [
    `parley message from "${m.from.name}" (${m.from.address}, ${verifiedText(m.from.verified)}):`,
    '',
    m.text,
    '',
    `It came through parley, so reply with parley's send_message to "${replyTo(m)}", not SendMessage.`,
  ].join('\n');
}

// A session on this machine is reached over its own socket, as SendMessage
// does, and answers to this session's Claude Code name.
async function sendHere(to: Session, message: string): Promise<string> {
  const me = myName();
  if (!me) throw new Error('this Claude Code session has no session name for the other one to reply to');
  const content = [
    `parley message from "${me}" (a Claude Code session on this machine):`,
    '',
    message,
    '',
    `It came through parley, so reply with parley's send_message to "${me}", not SendMessage.`,
  ].join('\n');
  await writeFrame(to.socket, peerToken(to), content);
  return `Delivered to "${to.name}", a Claude Code session on this machine.`;
}

const sessionLines = () =>
  others().map((s) => `  "${s.name}"${s.status ? `: ${s.status}` : ''}`);

export async function runMcp() {
  const server = new McpServer({ name: 'parley', version: VERSION }, { instructions: INSTRUCTIONS });
  let agent: Agent | undefined;
  let held: Local | undefined;
  let starting: Promise<void> | undefined;
  const unread: string[] = [];

  async function deliver(m: Incoming) {
    const content = shown(m);
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
    agent = await startAgent(local.home, log, deliver);
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
    ({ name: given }) =>
      reply(async () => {
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
      }),
  );

  server.registerTool(
    'list_agents',
    {
      description:
        "Show the names you can message: the Claude Code sessions on this machine, other parley names here, and everyone you have exchanged a message with. Also shows this session's parley name and id and whether it is connected. If this machine is not linked to a parley account yet, it shows the link your user has to open; the hosted relay refuses its sessions until then.",
    },
    () =>
      reply(async () => {
        await starting;
        const here = sessionLines();
        const sessionsPart = ['', here.length ? 'Claude Code sessions on this machine:' : 'No other Claude Code sessions are open on this machine.', ...here];
        if (!agent) return [unnamed(), ...sessionsPart].join('\n');
        const a = agent;
        if (a.account.state().link || a.account.state().error) await a.account.recheck();
        const s = a.state();
        const lines = [
          `This session is "${s.name}" (${s.address}), ${verifiedText(s.account.verified)}.`,
          s.relay.connected ? 'Connected to the relay.' : `Not connected to the relay: ${s.relay.error}.`,
        ];
        if (s.account.link) {
          lines.push(
            `This machine is not linked to a parley account yet, so the relay will not let its sessions on. Ask your user to open this link while signed in to ${s.account.url}; it works for 15 minutes, and is needed once per machine:`,
            s.account.link,
          );
        } else if (s.account.error) {
          lines.push(`Account: ${s.account.error}.`);
        }
        const contacts = loadContacts();
        const names = callable(s.address).map((n) => {
          const local = locals().some((l) => l.address === n.address);
          const where = local ? (holder(n.address) ? 'this machine, open' : 'this machine, not open') : `first heard ${contacts[n.address]?.firstSeen.slice(0, 10)}`;
          return `  "${n.name}" (${n.address}): ${where}`;
        });
        lines.push(...sessionsPart);
        lines.push('', names.length ? 'parley names you can message:' : 'No parley names elsewhere yet. Message an id to start.', ...names);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to another Claude Code session, on this machine or another. It arrives in that conversation by itself, and starts a turn there if the session is idle. Returns once the other side has it, or says why it could not be delivered: most often that no session with that name is open. To reply to a parley message, send to the name it came from.',
      inputSchema: {
        to: z.string().max(100).describe('A Claude Code session name on this machine, a parley id like kfq-mxa-tzp, or a name list_agents shows'),
        message: z.string().min(1).max(TEXT_MAX),
      },
    },
    ({ to, message }) =>
      reply(async () => {
        const here = sessionNamed(to);
        if (here) return sendHere(here, message);
        await starting;
        if (!agent) throw new Error(`no Claude Code session on this machine is named "${to.trim()}". ${unnamed()}`);
        const a = agent;
        const address = addressFor(to, a.address);
        const name = await a.send(address, message);
        return `Delivered to "${name}" (${address}).`;
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
        const made = a.account.link(url ?? process.env.PARLEY_CLOUD);
        return `Give your user this link. They open it while signed in to ${made.url}, and it works for 15 minutes. Use list_agents afterwards to see that the machine is linked:\n${made.link}`;
      }),
  );

  // This process holds the relay connection, so it must not outlive the session.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  await server.connect(new StdioServerTransport());

  // The server restarts inside one Claude Code session (a plugin reload, a
  // resume): it comes back as the same name, and reachable at once.
  const resumed = mine();
  if (resumed) {
    starting = become(resumed).catch((err) => log(`could not be "${resumed.name}" again:`, err instanceof Error ? err.message : err));
  }
}

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
import { canInject, inject } from './inject';
import { setUp } from './setup';
import { NAME_MAX, TEXT_MAX, VERSION } from './types';

const INSTRUCTIONS = `parley lets this Claude Code session message Claude Code sessions on other machines and other people's, the way SendMessage reaches sessions on this one.

Every session has its own parley name and an address, like k7fq-m2xa-9tzp. Give your user the address when they want someone to reach this session. send_message sends to an address, or to a name that list_agents shows. Messages sent to this session arrive in the conversation by themselves, also while it is idle. Reply with send_message to the name on the message.

The hosted relay lets a name on once it is linked to a parley account, once per name. When list_agents shows a link, give it to your user to open while signed in.`;

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), 'parley:', ...parts);

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function unnamed(): string {
  const here = locals();
  if (!here.length) {
    return 'This Claude Code session has no parley name, and this machine has none yet. Ask your user what name others should see, then use the setup tool.';
  }
  const lines = here.map((l) => {
    const use = holder(l.address) ? 'in use by another Claude Code session' : 'free';
    return `  "${l.name}" (${l.address}): ${use}`;
  });
  return [
    'This Claude Code session has no parley name yet. Names on this machine:',
    ...lines,
    'Use the setup tool with a free name to be it in this session, or with a new name for a separate address. If your user named one, use that. If there is exactly one name and it is free, take it. Otherwise ask your user which name this session should have.',
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
        "Give this Claude Code session its parley name. A new name creates an identity with its own address. A free name this machine already has makes this session that name again, with the same address as before. Ask your user for the name unless they gave one; it is what others see on your messages. Give your user the address it returns: others need it to reach this session.",
      inputSchema: { name: z.string().trim().min(1).max(NAME_MAX).describe('The name others will see') },
    },
    ({ name }) =>
      reply(async () => {
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
        return `This session is now "${made.name}", a new name. Its address is ${made.address}. Give this address to your user: others need it to reach this session, and can use the name "${made.name}" after you have exchanged a message.`;
      }),
  );

  server.registerTool(
    'list_agents',
    {
      description:
        "Show this session's parley name and address, whether it is connected, and the names you can message: other parley names on this machine and everyone you have exchanged a message with. If the name is not linked to a parley account yet, it shows the link your user has to open; the hosted relay refuses a name until then.",
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
          lines.push(
            `This name is not linked to a parley account yet, so the relay will not let it on. Ask your user to open this link while signed in to ${s.account.url}; it works for 15 minutes:`,
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
        lines.push('', names.length ? 'Names you can message:' : 'No other names yet. Message an address to start.', ...names);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to another Claude Code session through parley. It arrives in that conversation by itself, and starts a turn there if the session is idle. Returns once the other side has it, or says why it could not be delivered: most often that no session with that name is open. To reply to a parley message, send to the name it came from.',
      inputSchema: {
        to: z.string().max(100).describe('A parley address like k7fq-m2xa-9tzp, or a name list_agents shows'),
        message: z.string().min(1).max(TEXT_MAX),
      },
    },
    ({ to, message }) =>
      named(async (a) => {
        const address = addressFor(to, a.address);
        const name = await a.send(address, message);
        return `Delivered to "${name}" (${address}).`;
      }),
  );

  server.registerTool(
    'cloud_link',
    {
      description:
        "Tie this session's parley name to your user's parley account. The hosted relay needs this before the name can connect, and it is done once per name. Returns a link your user opens while signed in there; it works for 15 minutes. Use it when your user asks, or when list_agents says the relay needs an account and gives no link.",
      inputSchema: { url: z.string().max(500).optional().describe('The cloud address, if your user gave one') },
    },
    ({ url }) =>
      named(async (a) => {
        const made = a.account.link(url ?? process.env.PARLEY_CLOUD);
        return `Give your user this link. They open it while signed in to ${made.url}, and it works for 15 minutes. Use list_agents afterwards to see that the name is linked:\n${made.link}`;
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

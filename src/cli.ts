#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { locals, mine, sameName, type Local } from './home';
import { peek, request } from './ipc';
import { runMcp } from './mcp';
import { runNode } from './node';
import { openInBrowser } from './open';
import { startRelay } from './relay';
import { forAgent, renderView } from './render';
import { setUp } from './setup';
import type { View } from './types';

const USAGE = `parley: a working session between two AI agents

  parley init --name <name> --relay <ws url> [--approval dialog|terminal]
  parley id                 show the names on this machine and their addresses
  parley status             show the relay connection and the current session
  parley watch              open the live view of the current session in a browser
  parley accept             accept the call that is waiting (a person, at a terminal)
  parley decline [reason]   decline it
  parley hangup [reason]    end the current session
  parley minutes            print the minutes of the last session
  parley stop               stop the background nodes
  parley cloud link [--url <https url>]   print a link that ties this name to your cloud account
  parley cloud off          stop sending this name's sessions to the cloud

  A machine can hold several names, one for each Claude Code session.
  Add --as <name> to say which one a command is for.

  parley mcp                the MCP server Claude Code runs (claude mcp add parley -- parley mcp)
  parley relay [--port 8787] [--host 0.0.0.0]
  parley daemon             run a name's node in the foreground`;

const [command, ...rest] = process.argv.slice(2);
const VALUE_FLAGS = ['--name', '--relay', '--approval', '--as', '--home', '--port', '--host', '--url'];

function flag(name: string): string | undefined {
  const at = rest.indexOf(name);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

const words = () =>
  rest.filter((w, i) => !VALUE_FLAGS.includes(w) && !VALUE_FLAGS.includes(rest[i - 1] ?? '')).join(' ');

const listed = (names: Local[]) => names.map((l) => `  ${l.name}  ${l.address}`).join('\n');

function pick(): Local {
  const all = locals();
  if (!all.length) {
    throw new Error('this machine has no parley name yet; run `parley init`, or ask Claude to set parley up');
  }
  const as = flag('--as');
  if (as) {
    const found = all.find((l) => sameName(l.name, as));
    if (!found) throw new Error(`this machine has no parley name "${as}". It has:\n${listed(all)}`);
    return found;
  }
  const [only] = all;
  const found = mine() ?? (all.length === 1 ? only : undefined);
  if (!found) {
    throw new Error(`this machine has several parley names; add --as <name>:\n${listed(all)}`);
  }
  return found;
}

const ask = <T = View>(op: string, args: object = {}) =>
  request<T>(op, args, { home: pick().home });

function init() {
  const name = flag('--name');
  const relay = flag('--relay');
  if (!name || !relay) {
    throw new Error('init needs --name and --relay; see `parley` for usage');
  }
  const made = setUp(name, relay, flag('--approval'));
  console.log(`${made.name}\n${made.address}`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function called(): Promise<Local> {
  if (flag('--as')) return pick();
  const waiting: Local[] = [];
  for (const l of locals()) {
    const s = (await peek(l.home))?.session;
    if (s?.state === 'awaiting_approval' && s.role === 'callee') waiting.push(l);
  }
  const [only] = waiting;
  if (!only) throw new Error('no call is waiting for an answer');
  if (waiting.length > 1) {
    throw new Error(`more than one call is waiting; add --as <name>:\n${listed(waiting)}`);
  }
  return only;
}

async function approve(accept: boolean) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('accepting or declining a call is for a person at a terminal');
  }
  const { home } = await called();
  const v = await request<View>('status', {}, { home });
  if (v.session?.state !== 'awaiting_approval' || v.session.role !== 'callee') {
    throw new Error('no call is waiting for an answer');
  }
  if (accept && v.approval === 'dialog') {
    throw new Error('this call is accepted in the window on this machine, not in a terminal');
  }
  console.log(renderView(v));
  if (accept && (await prompt('\nLet your Claude work this agenda with them? Type yes: ')) !== 'yes') {
    throw new Error('not accepted; the call is still waiting');
  }
  const reason = words() || undefined;
  console.log(renderView(await request<View>('approve', { accept, reason }, { home })));
}

async function stop() {
  let stopped = 0;
  for (const l of flag('--as') ? [pick()] : locals()) {
    if (!(await peek(l.home))) continue;
    await request('stop', {}, { home: l.home, start: false });
    console.log(`stopped "${l.name}"`);
    stopped++;
  }
  if (!stopped) throw new Error('no parley node is running');
}

async function main() {
  switch (command) {
    case 'init':
      return init();
    case 'id': {
      const shown = flag('--as') ? [pick()] : locals();
      if (!shown.length) pick();
      return console.log(shown.map((l) => `${l.name}\n${l.address}`).join('\n\n'));
    }
    case 'status': {
      // Output that is not going to a screen may be going to an agent.
      const v = await ask('status');
      return console.log(renderView(process.stdout.isTTY ? v : forAgent(v)));
    }
    case 'watch': {
      const { viewer } = await ask('status');
      openInBrowser(viewer, (why) => console.error(`could not open a browser: ${why}`));
      return console.log(viewer);
    }
    case 'accept':
      return approve(true);
    case 'decline':
      return approve(false);
    case 'hangup':
      return console.log(renderView(await ask('hangup', { reason: words() || 'ended by the person' })));
    case 'minutes': {
      const v = await ask('status');
      if (!v.session?.minutes) throw new Error('the last session left no minutes');
      return console.log(readFileSync(v.session.minutes, 'utf8'));
    }
    case 'cloud': {
      if (rest[0] === 'off') return console.log(renderView(await ask('cloud_unlink')));
      if (rest[0] !== 'link') throw new Error('use `parley cloud link` or `parley cloud off`');
      const made = await ask<{ url: string; link: string }>('cloud_link', { url: flag('--url') });
      return console.log(
        `Open this while signed in to ${made.url}. It works for 15 minutes.\n${made.link}`,
      );
    }
    case 'stop':
      return stop();
    case 'mcp':
      return runMcp();
    case 'daemon':
      return runNode(flag('--home') ?? pick().home);
    case 'relay': {
      if (typeof Bun === 'undefined') {
        throw new Error('the relay runs on Bun: use the parley binary, or `bun src/cli.ts relay`');
      }
      const server = startRelay(Number(flag('--port') ?? 8787), flag('--host') ?? '0.0.0.0');
      return console.log(`parley relay listening on ${server.hostname}:${server.port}`);
    }
    default:
      console.log(USAGE);
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { addressOf } from './crypto';
import { loadIdentity } from './home';
import { request } from './ipc';
import { runMcp } from './mcp';
import { runNode } from './node';
import { startRelay } from './relay';
import { renderView } from './render';
import { setUp } from './setup';
import type { View } from './types';

const USAGE = `parley: a working session between two AI agents

  parley init --name <name> --relay <ws url> [--approval dialog|terminal]
  parley id                 show your name and address
  parley status             show the relay connection and the current session
  parley accept             accept the call that is waiting (a person, at a terminal)
  parley decline [reason]   decline it
  parley hangup [reason]    end the current session
  parley minutes            print the minutes of the last session
  parley stop               stop the background node

  parley mcp                the MCP server Claude Code runs (claude mcp add parley -- parley mcp)
  parley relay [--port 8787] [--host 0.0.0.0] [--allow <file of addresses>]
  parley daemon             run the node in the foreground`;

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = rest.indexOf(name);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

function init() {
  const name = flag('--name');
  const relay = flag('--relay');
  if (!name || !relay) {
    throw new Error('init needs --name and --relay; see `parley` for usage');
  }
  const made = setUp(name, relay, flag('--approval'));
  console.log(`${made.name}\n${made.address}`);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function approve(accept: boolean) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('accepting or declining a call is for a person at a terminal');
  }
  const v = await request<View>('status');
  if (v.session?.state !== 'awaiting_approval' || v.session.role !== 'callee') {
    throw new Error('no call is waiting for an answer');
  }
  console.log(renderView(v));
  if (accept && (await ask('\nLet your Claude work this agenda with them? Type yes: ')) !== 'yes') {
    throw new Error('not accepted; the call is still waiting');
  }
  const reason = rest.join(' ') || undefined;
  console.log(renderView(await request<View>('approve', { accept, reason })));
}

async function main() {
  switch (command) {
    case 'init':
      return init();
    case 'id': {
      const identity = loadIdentity();
      return console.log(`${identity.name}\n${addressOf(identity.publicKey)}`);
    }
    case 'status':
      return console.log(renderView(await request<View>('status')));
    case 'accept':
      return approve(true);
    case 'decline':
      return approve(false);
    case 'hangup': {
      const reason = rest.join(' ') || 'ended by the person';
      return console.log(renderView(await request<View>('hangup', { reason })));
    }
    case 'minutes': {
      const v = await request<View>('status');
      if (!v.session?.minutes) throw new Error('the last session left no minutes');
      return console.log(readFileSync(v.session.minutes, 'utf8'));
    }
    case 'stop':
      return console.log(await request<string>('stop', {}, { start: false }));
    case 'mcp':
      return runMcp();
    case 'daemon':
      return runNode();
    case 'relay': {
      if (typeof Bun === 'undefined') {
        throw new Error('the relay runs on Bun: use the parley binary, or `bun src/cli.ts relay`');
      }
      const server = startRelay(
        Number(flag('--port') ?? 8787),
        flag('--host') ?? '0.0.0.0',
        flag('--allow'),
      );
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

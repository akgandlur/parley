import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code lists its open sessions in ~/.claude/sessions, one <pid>.json
// each with the session's name and socket. Not a documented API. parley
// reads it for one thing: the name this session already has.
const dir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');

export function myName(): string | undefined {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socket) return undefined;
  let files: string[];
  try {
    files = readdirSync(dir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir(), file), 'utf8')) as { name?: string; messagingSocketPath?: string };
      if (entry.messagingSocketPath === socket && entry.name) return entry.name;
    } catch {
      // Claude Code rewrites these files as a session's status changes.
    }
  }
  return undefined;
}

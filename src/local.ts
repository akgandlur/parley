import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sameName } from './home';

// Claude Code lists its open sessions in ~/.claude/sessions: <pid>.json holds
// the session's name and socket, and <pid>.<sha256 of the socket path>.key
// the token another session presents on that socket. Not a documented API:
// it is what Claude Code's own SendMessage reads.

export type Session = { name: string; pid: number; socket: string; status?: string };

const dir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function sessions(): Session[] {
  let files: string[];
  try {
    files = readdirSync(dir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Session[] = [];
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    let entry: { pid?: number; name?: string; messagingSocketPath?: string; status?: string };
    try {
      entry = JSON.parse(readFileSync(join(dir(), file), 'utf8'));
    } catch {
      // Claude Code rewrites these files as a session's status changes.
      continue;
    }
    const { pid, name, messagingSocketPath: socket } = entry;
    if (typeof pid !== 'number' || !name || !socket || !alive(pid)) continue;
    out.push({ name, pid, socket, status: entry.status });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const own = () => process.env.CLAUDE_CODE_MESSAGING_SOCKET;

export const myName = () => sessions().find((s) => s.socket === own())?.name;

export const others = () => sessions().filter((s) => s.socket !== own());

export function sessionNamed(to: string): Session | undefined {
  const hits = others().filter((s) => sameName(s.name, to));
  if (hits.length > 1) {
    throw new Error(`${hits.length} Claude Code sessions on this machine are named "${to.trim()}"; rename one with /rename first`);
  }
  return hits[0];
}

export function peerToken(s: Session): string {
  const file = join(dir(), `${s.pid}.${createHash('sha256').update(s.socket).digest('hex')}.key`);
  const { peerToken } = JSON.parse(readFileSync(file, 'utf8')) as { peerToken?: string };
  if (!peerToken) throw new Error(`the Claude Code session "${s.name}" has no messaging key`);
  return peerToken;
}

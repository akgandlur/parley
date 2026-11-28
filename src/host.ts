import { hostname } from 'node:os';

export type HostId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'copilot' | 'other';

export const HOST_NAMES: Record<HostId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'opencode',
  copilot: 'Copilot CLI',
  other: 'your agent',
};

export const INSTALLABLE = ['codex', 'cursor', 'gemini', 'opencode', 'copilot'] as const;

function detect(): HostId {
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_CODE_MESSAGING_SOCKET) return 'claude';
  const given = process.env.PARLEY_AGENT;
  return given && given in HOST_NAMES ? (given as HostId) : 'other';
}

const id = detect();

export const HOST = { id, name: HOST_NAMES[id], injects: id === 'claude' };

export const machine = () => hostname().replace(/\.local$/, '').slice(0, 40) || 'this machine';

export const defaultName = () => process.env.PARLEY_NAME ?? `${HOST.id === 'other' ? 'Agent' : HOST.name} on ${machine()}`;

export function selfCommand(): string[] {
  const script = process.argv[1];
  return !script || script.startsWith('/$bunfs') ? [process.execPath] : [process.execPath, script];
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_NAMES, INSTALLABLE, selfCommand, type HostId } from './host';

type Installable = (typeof INSTALLABLE)[number];

const RELAY = process.env.PARLEY_RELAY ?? 'wss://parley.codes';
const CLOUD = process.env.PARLEY_CLOUD ?? 'https://parley.codes';

const server = (agent: Installable) => {
  const [command, ...rest] = selfCommand();
  return { command: command as string, args: [...rest, 'mcp'], env: { PARLEY_RELAY: RELAY, PARLEY_CLOUD: CLOUD, PARLEY_AGENT: agent } };
};

function writeJson(path: string, edit: (doc: Record<string, any>) => void) {
  let doc: Record<string, any> = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8').trim();
    if (text) {
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error(`${path} is not JSON, so parley will not change it. Fix or move it and run this again.`);
      }
    }
  }
  edit(doc);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

const toml = (s: string) => JSON.stringify(s);

function writeCodex(path: string, s: ReturnType<typeof server>) {
  const block = [
    '[mcp_servers.parley]',
    `command = ${toml(s.command)}`,
    `args = [${s.args.map(toml).join(', ')}]`,
    `env = { ${Object.entries(s.env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`,
    '',
  ].join('\n');
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const section = /^\[mcp_servers\.parley\]\n(?:(?!^\[).*\n?)*/m;
  const text = section.test(old) ? old.replace(section, block) : `${old.trimEnd()}${old.trim() ? '\n\n' : ''}${block}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function configPath(agent: Installable, home = homedir()): string {
  switch (agent) {
    case 'codex':
      return join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml');
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'gemini':
      return join(home, '.gemini', 'settings.json');
    case 'opencode':
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', 'opencode.json');
    case 'copilot':
      return join(home, '.copilot', 'mcp-config.json');
  }
}

export function install(agent: Installable, home = homedir()): string {
  const s = server(agent);
  const path = configPath(agent, home);
  switch (agent) {
    case 'codex':
      writeCodex(path, s);
      break;
    case 'cursor':
    case 'gemini':
      writeJson(path, (doc) => {
        doc.mcpServers = { ...(doc.mcpServers ?? {}), parley: s };
      });
      break;
    case 'opencode':
      writeJson(path, (doc) => {
        doc.mcp = { ...(doc.mcp ?? {}), parley: { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true } };
      });
      break;
    case 'copilot':
      writeJson(path, (doc) => {
        doc.mcpServers = { ...(doc.mcpServers ?? {}), parley: { type: 'local', ...s, tools: ['*'] } };
      });
      break;
  }
  return `${HOST_NAMES[agent]}: parley is in ${path}. Restart ${HOST_NAMES[agent]} to load it.`;
}

export const isInstallable = (s: string): s is Installable => (INSTALLABLE as readonly string[]).includes(s);

export const agentList = () => INSTALLABLE.map((a) => `${a} (${HOST_NAMES[a as HostId]})`).join(', ');

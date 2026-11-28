import { connect } from 'node:net';

// Claude Code's own cross-session socket; not a documented API.
export const canInject = () => Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET);

export function inject(content: string): Promise<void> {
  const path = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!path) return Promise.reject(new Error('this process has no Claude Code session socket'));
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      if (token) socket.write(JSON.stringify({ type: 'auth', token }) + '\n');
      socket.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('the Claude Code session did not take the message')));
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (!hadError) resolve();
    });
  });
}

import { connect } from 'node:net';

// Claude Code gives the processes it starts, this MCP server among them, a
// socket into their own session: the one it delivers SendMessage over. A
// message written there lands in the conversation like a message from another
// session, and starts a turn when the session is idle. Not a documented API:
// the frame is what Claude Code's own debug log shows for it.
export const canInject = () => Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET);

export function inject(content: string): Promise<void> {
  const path = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!path) return Promise.reject(new Error('this process has no Claude Code session socket'));
  return writeFrame(path, process.env.CLAUDE_CODE_MESSAGING_TOKEN, content);
}

export function writeFrame(path: string, token: string | undefined, content: string): Promise<void> {
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

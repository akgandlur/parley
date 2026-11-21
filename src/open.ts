import { spawn } from 'node:child_process';

export function openInBrowser(url: string, onError: (message: string) => void) {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  if (!command) return;
  spawn(command, args, { stdio: 'ignore', detached: true })
    .on('error', (err) => onError(err.message))
    .unref();
}

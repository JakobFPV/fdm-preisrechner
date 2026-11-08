#!/usr/bin/env node
// Starts the FDM price calculator.
//   node server.js [--port=3141] [--data-dir=./data] [--open]
// Port and data folder can also be set with PORT and DATA_DIR.
// Terminal messages use the language chosen in the app, else the system language (LANG).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectLanguage, t } from './public/lib/i18n.js';
import { APP_ID, createAppServer } from './src/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1'; // only reachable from this computer

let lang = detectLanguage([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]);

const { values: options } = parseArgs({
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    open: { type: 'boolean', default: false },
  },
});

const port = Number(options.port ?? process.env.PORT ?? 3141);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(t(lang, 'cli.invalidPort', { port: String(options.port ?? process.env.PORT) }));
  process.exit(1);
}
const dataDir = path.resolve(options['data-dir'] ?? process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const url = `http://localhost:${port}`;

let app;
try {
  app = createAppServer({ dataDir, publicDir: path.join(ROOT, 'public'), logLanguage: lang });
} catch (error) {
  console.error(t(lang, 'cli.loadFailed', { dir: dataDir, message: error.message }));
  process.exit(1);
}
const { server, store } = app;
lang = store.language() ?? lang;

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    if (await isAlreadyRunning(port)) {
      console.log(t(lang, 'cli.alreadyRunning', { url }));
      if (options.open) openBrowser(url);
      process.exit(0);
    }
    console.error(t(lang, 'cli.portBusy', { port: String(port), next: String(port + 1) }));
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(t(lang, 'cli.running', { url }));
  console.log(t(lang, 'cli.settingsFile', { file: store.paths.settings }));
  console.log(t(lang, 'cli.stopHint'));
  if (options.open) openBrowser(url);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

async function isAlreadyRunning(portNumber) {
  try {
    const response = await fetch(`http://${HOST}:${portNumber}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await response.json()).app === APP_ID;
  } catch {
    return false;
  }
}

function openBrowser(target) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The browser cannot be opened – the address is shown in the terminal.
  }
}

#!/usr/bin/env node
// Startet den FDM-Preisrechner.
//   node server.js [--port=3141] [--data-dir=./data] [--open]
// Port und Datenordner lassen sich auch über PORT und DATA_DIR setzen.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_ID, createAppServer } from './src/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1'; // nur auf diesem Computer erreichbar

const { values: options } = parseArgs({
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    open: { type: 'boolean', default: false },
  },
});

const port = Number(options.port ?? process.env.PORT ?? 3141);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Ungültiger Port: ${options.port ?? process.env.PORT}`);
  process.exit(1);
}
const dataDir = path.resolve(options['data-dir'] ?? process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const url = `http://localhost:${port}`;

let app;
try {
  app = createAppServer({ dataDir, publicDir: path.join(ROOT, 'public') });
} catch (error) {
  console.error(`Die Einstellungen in ${dataDir} konnten nicht geladen werden: ${error.message}`);
  process.exit(1);
}
const { server, store } = app;

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    if (await isAlreadyRunning(port)) {
      console.log(`Der FDM-Preisrechner läuft bereits: ${url}`);
      if (options.open) openBrowser(url);
      process.exit(0);
    }
    console.error(`Port ${port} ist schon belegt. Starte mit einem anderen Port, z. B.: PORT=${port + 1} npm start`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`FDM-Preisrechner läuft: ${url}`);
  console.log(`Einstellungen: ${store.paths.settings}`);
  console.log('Beenden mit Ctrl+C.');
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
    // Browser lässt sich nicht öffnen – die Adresse steht im Terminal.
  }
}

// Startet den Preisrechner automatisch beim Anmelden (macOS LaunchAgent).
//   npm run autostart:install    einrichten und sofort starten
//   npm run autostart:uninstall  wieder entfernen
//   npm run autostart:status     prüfen, ob er läuft

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'de.fdm-preisrechner';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'fdm-preisrechner.log');
const DOMAIN = `gui/${process.getuid()}`;
const URL = 'http://localhost:3141';

const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function isRunning() {
  try {
    const response = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await response.json()).app === 'fdm-preisrechner';
  } catch {
    return false;
  }
}

async function install() {
  if (process.platform !== 'darwin') throw new Error('Der Autostart ist nur für macOS eingerichtet.');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(ROOT, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <!-- restart after a crash, but not after a clean exit (e.g. it was already running) -->
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  launchctl('bootout', `${DOMAIN}/${LABEL}`); // replace an older installation
  fs.writeFileSync(PLIST, plist);
  if (!launchctl('bootstrap', DOMAIN, PLIST)) throw new Error('launchctl konnte den Autostart nicht laden.');

  for (let i = 0; i < 20 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await isRunning())) {
    throw new Error(`Der Autostart ist eingerichtet, aber der Server antwortet nicht. Details: ${LOG}`);
  }
  console.log(`Autostart eingerichtet. Der Preisrechner läuft jetzt dauerhaft unter ${URL}`);
  console.log(`Startet automatisch beim Anmelden. Log: ${LOG}`);
}

function uninstall() {
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  fs.rmSync(PLIST, { force: true });
  console.log('Autostart entfernt. Starten geht weiter mit npm start.');
}

async function status() {
  const installed = fs.existsSync(PLIST);
  console.log(`Autostart: ${installed ? 'eingerichtet' : 'nicht eingerichtet'}`);
  console.log(`Server: ${(await isRunning()) ? `läuft (${URL})` : 'läuft nicht'}`);
  if (installed) console.log(`Log: ${LOG}`);
}

const command = process.argv[2];
try {
  if (command === 'install') await install();
  else if (command === 'uninstall') uninstall();
  else await status();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Starts the price calculator automatically when you log in (macOS LaunchAgent).
//   npm run autostart:install    set up and start right away
//   npm run autostart:uninstall  remove again
//   npm run autostart:status     check whether it runs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguage, t } from '../public/lib/i18n.js';

const LABEL = 'de.fdm-preisrechner';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'fdm-preisrechner.log');
const DOMAIN = `gui/${process.getuid()}`;
const URL = 'http://localhost:3141';
const lang = detectLanguage([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]);

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
  if (process.platform !== 'darwin') throw new Error(t(lang, 'autostart.macOnly'));
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
  if (!launchctl('bootstrap', DOMAIN, PLIST)) throw new Error(t(lang, 'autostart.loadFailed'));

  for (let i = 0; i < 20 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await isRunning())) {
    throw new Error(t(lang, 'autostart.notResponding', { log: LOG }));
  }
  console.log(t(lang, 'autostart.installed', { url: URL }));
  console.log(t(lang, 'autostart.installedHint', { log: LOG }));
}

function uninstall() {
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  fs.rmSync(PLIST, { force: true });
  console.log(t(lang, 'autostart.removed'));
}

async function status() {
  const installed = fs.existsSync(PLIST);
  console.log(t(lang, installed ? 'autostart.statusInstalled' : 'autostart.statusMissing'));
  console.log((await isRunning()) ? t(lang, 'autostart.serverRunning', { url: URL }) : t(lang, 'autostart.serverStopped'));
  if (installed) console.log(t(lang, 'autostart.log', { log: LOG }));
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

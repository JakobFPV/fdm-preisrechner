// HTTP server: static files, JSON API, local-only protections, persistence across restarts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createAppServer } from '../src/app.js';

const PUBLIC_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');

async function start(dataDir) {
  const { server } = createAppServer({ dataDir, publicDir: PUBLIC_DIR });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const stop = (server) => new Promise((resolve) => server.close(resolve));

function json(base, method, url, body, headers = {}) {
  return fetch(base + url, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Raw request, so the path is sent exactly as written (fetch would normalize "..") */
function rawGet(base, rawPath, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ hostname, port, path: rawPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

describe('server', () => {
  let dataDir;
  let app;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-preisrechner-server-'));
    app = await start(dataDir);
  });
  after(async () => {
    await stop(app.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the app with a content security policy', async () => {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await res.text(), /FDM-Preisrechner/);
  });

  it('serves the shared modules as JavaScript', async () => {
    const res = await fetch(`${app.base}/lib/calc.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
  });

  it('never serves files outside the public folder', async () => {
    assert.equal(await rawGet(app.base, '/../package.json'), 404);
    assert.equal(await rawGet(app.base, '/..%2fpackage.json'), 404);
    assert.equal(await rawGet(app.base, '/%2e%2e/%2e%2e/package.json'), 404);
    assert.equal(await rawGet(app.base, '/lib/../../server.js'), 404);
  });

  it('returns the stored state', async () => {
    const res = await fetch(`${app.base}/api/state`);
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.settings.printers[0].name, 'Beispieldrucker');
    assert.equal(state.lastPrint.layerHeightMm, 0.2);
    assert.equal(state.storage.settingsFile, path.join(dataDir, 'settings.json'));
  });

  it('adds, edits and deletes printers', async () => {
    let res = await json(app.base, 'POST', '/api/printers', { name: 'Testdrucker', powerW: 150, throughputCm3PerH: 30, wearPerHour: 0.3 });
    assert.equal(res.status, 201);
    const { item } = await res.json();
    assert.equal(item.name, 'Testdrucker');
    assert.equal(item.wearPerHour, 0.3);

    res = await json(app.base, 'PUT', `/api/printers/${item.id}`, { name: 'Testdrucker 2', powerW: 160, throughputCm3PerH: 32, wearPerHour: 0.4 });
    assert.equal(res.status, 200);
    const updated = (await res.json()).settings.printers.find((p) => p.id === item.id);
    assert.equal(updated.powerW, 160);
    assert.equal(updated.wearPerHour, 0.4);

    res = await json(app.base, 'POST', '/api/printers', { name: 'Ohne Verschleiß', powerW: 150, throughputCm3PerH: 30 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errors.wearPerHour, 'Bitte eine Zahl eingeben.');

    res = await json(app.base, 'DELETE', `/api/printers/${item.id}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).settings.printers.length, 1);
  });

  it('answers invalid input with German messages per field', async () => {
    const res = await json(app.base, 'POST', '/api/materials', { name: '', pricePerKg: 'teuer', densityGPerCm3: 1.2 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.errors.name, 'Bitte einen Namen eingeben.');
    assert.equal(body.errors.pricePerKg, 'Bitte eine Zahl eingeben.');
    assert.match(body.error, /Name: .* Preis: /);
  });

  it('rejects writes that are not JSON (protects against cross-site form posts)', async () => {
    const res = await fetch(`${app.base}/api/printers`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'Hack', powerW: 1, throughputCm3PerH: 1 }),
    });
    assert.equal(res.status, 415);
  });

  it('rejects writes from other websites', async () => {
    const res = await json(app.base, 'POST', '/api/printers', { name: 'Hack', powerW: 1, throughputCm3PerH: 1 },
      { Origin: 'https://example.com' });
    assert.equal(res.status, 403);
  });

  it('rejects requests for other host names (DNS rebinding)', async () => {
    assert.equal(await rawGet(app.base, '/api/state', { Host: 'evil.example:80' }), 403);
    assert.equal(await rawGet(app.base, '/api/state', { Host: 'localhost:3141' }), 200);
  });

  it('rejects broken JSON', async () => {
    const res = await fetch(`${app.base}/api/last-print`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ kaputt',
    });
    assert.equal(res.status, 400);
  });

  it('keeps settings and last print values across a server restart', async () => {
    await json(app.base, 'POST', '/api/materials', { name: 'PETG CF', pricePerKg: 35, densityGPerCm3: 1.3 });
    const general = await json(app.base, 'PUT', '/api/settings/general', {
      electricityPricePerKwh: 0.29, wagePerHour: 15.5, profitMarginPercent: 65, supportSurchargePercent: 30, wallThicknessMm: 1,
      shippingMinutes: 7, plateMinutesMin: 4, plateMinutesMax: 14, fullPlateVolumeCm3: 600,
    });
    assert.equal(general.status, 200);
    const lastPrint = await json(app.base, 'PUT', '/api/last-print', {
      printerId: 'beispieldrucker', materialId: 'tpu', layerHeightMm: 0.12, infillPercent: 40, support: true,
    });
    assert.equal(lastPrint.status, 200);

    await stop(app.server);
    app = await start(dataDir);

    const state = await (await fetch(`${app.base}/api/state`)).json();
    assert.ok(state.settings.materials.some((m) => m.name === 'PETG CF'));
    assert.equal(state.settings.electricityPricePerKwh, 0.29);
    assert.equal(state.settings.wagePerHour, 15.5);
    assert.equal(state.settings.profitMarginPercent, 65);
    assert.equal(state.settings.supportSurchargePercent, 30);
    assert.deepEqual(
      [state.settings.shippingMinutes, state.settings.plateMinutesMin, state.settings.plateMinutesMax, state.settings.fullPlateVolumeCm3],
      [7, 4, 14, 600],
    );
    assert.deepEqual(state.lastPrint, {
      printerId: 'beispieldrucker', materialId: 'tpu', layerHeightMm: 0.12, infillPercent: 40, support: true,
    });
  });
});

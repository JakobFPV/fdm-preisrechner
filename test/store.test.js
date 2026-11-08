// Durable settings storage (data/settings.json, data/last-print.json).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createStore, StoreError } from '../src/store.js';

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-preisrechner-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function throwsStoreError(fn, status, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof StoreError, `expected StoreError, got ${error}`);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe('settings storage', () => {
  it('creates sensible defaults on the first start', () => {
    const dir = tempDir();
    const { settings, lastPrint } = createStore(dir).getState();

    assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
    assert.ok(fs.existsSync(path.join(dir, 'last-print.json')));
    assert.equal(settings.printers.length, 1);
    assert.ok(settings.printers[0].powerW > 0 && settings.printers[0].throughputCm3PerH > 0);
    assert.deepEqual(settings.materials.map((m) => m.name), ['PLA', 'PETG', 'ABS', 'TPU']);
    const density = Object.fromEntries(settings.materials.map((m) => [m.name, m.densityGPerCm3]));
    assert.deepEqual(density, { PLA: 1.24, PETG: 1.27, ABS: 1.04, TPU: 1.21 });
    assert.equal(lastPrint.printerId, settings.printers[0].id);
    assert.equal(lastPrint.materialId, settings.materials[0].id);
    assert.equal(settings.wagePerHour, 14);
    assert.ok(settings.printers[0].wearPerHour > 0);
    assert.deepEqual(
      [settings.shippingMinutes, settings.plateMinutesMin, settings.plateMinutesMax, settings.fullPlateVolumeCm3],
      [6, 3, 15, 500],
    );
  });

  it('keeps every change after a restart', () => {
    const dir = tempDir();
    const store = createStore(dir);
    const { item: printer } = store.addItem('printers', { name: 'Bambu P1S', powerW: 130, throughputCm3PerH: 28, wearPerHour: '0,2' });
    const { item: material } = store.addItem('materials', { name: 'PLA Silk', pricePerKg: '24,99', densityGPerCm3: '1,24' });
    store.updateItem('materials', 'pla', { name: 'PLA', pricePerKg: 18.5, densityGPerCm3: 1.24 });
    store.updateGeneral({
      electricityPricePerKwh: 0.31, wagePerHour: 15, profitMarginPercent: 80, supportSurchargePercent: 15, wallThicknessMm: 1.2,
      shippingMinutes: 8, plateMinutesMin: 2, plateMinutesMax: 12, fullPlateVolumeCm3: 400,
    });
    store.setLastPrint({ printerId: printer.id, materialId: material.id, layerHeightMm: 0.16, infillPercent: 25, support: true });

    const restarted = createStore(dir).getState(); // like restarting the server or the computer
    assert.equal(restarted.settings.printers.length, 2);
    assert.deepEqual(restarted.settings.printers[1], printer);
    assert.equal(restarted.settings.printers[1].wearPerHour, 0.2);
    assert.equal(restarted.settings.materials.find((m) => m.id === material.id).pricePerKg, 24.99);
    assert.equal(restarted.settings.materials.find((m) => m.id === 'pla').pricePerKg, 18.5);
    assert.equal(restarted.settings.electricityPricePerKwh, 0.31);
    assert.equal(restarted.settings.wagePerHour, 15);
    assert.equal(restarted.settings.profitMarginPercent, 80);
    assert.equal(restarted.settings.supportSurchargePercent, 15);
    assert.equal(restarted.settings.wallThicknessMm, 1.2);
    assert.deepEqual(
      [restarted.settings.shippingMinutes, restarted.settings.plateMinutesMin, restarted.settings.plateMinutesMax, restarted.settings.fullPlateVolumeCm3],
      [8, 2, 12, 400],
    );
    assert.deepEqual(restarted.lastPrint, {
      printerId: printer.id,
      materialId: material.id,
      layerHeightMm: 0.16,
      infillPercent: 25,
      support: true,
    });
    assert.deepEqual(restarted.warnings, []);
  });

  it('rejects invalid values and leaves the file untouched', () => {
    const dir = tempDir();
    const store = createStore(dir);
    const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.throws(
      () => store.addItem('printers', { name: '', powerW: -5, throughputCm3PerH: 20, wearPerHour: -1 }),
      (error) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.status, 400);
        assert.deepEqual(Object.keys(error.errors), ['name', 'powerW', 'wearPerHour']);
        return true;
      },
    );
    const general = {
      electricityPricePerKwh: 0.3, wagePerHour: 14, profitMarginPercent: 50, supportSurchargePercent: 20, wallThicknessMm: 1,
      shippingMinutes: 6, plateMinutesMin: 3, plateMinutesMax: 15, fullPlateVolumeCm3: 500,
    };
    throwsStoreError(() => store.updateGeneral({ ...general, electricityPricePerKwh: 'teuer' }), 400, /Strompreis/);
    throwsStoreError(() => store.updateGeneral({ ...general, wagePerHour: -2 }), 400, /Stundenlohn: Mindestens 0 €\/h/);
    throwsStoreError(() => store.updateGeneral({ ...general, plateMinutesMin: 20 }), 400, /Mindestzeit pro Platte darf nicht größer/);
    throwsStoreError(() => store.updateGeneral({ ...general, fullPlateVolumeCm3: 0 }), 400, /Höchstzeit ab: Muss größer als 0 cm³/);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  });

  it('rejects duplicate names', () => {
    const store = createStore(tempDir());
    throwsStoreError(() => store.addItem('materials', { name: 'pla', pricePerKg: 20, densityGPerCm3: 1.24 }), 409, /bereits/);
    // renaming an item to its own name is fine
    store.updateItem('materials', 'pla', { name: 'PLA', pricePerKg: 21, densityGPerCm3: 1.24 });
  });

  it('never deletes the last printer or material', () => {
    const store = createStore(tempDir());
    throwsStoreError(() => store.deleteItem('printers', 'beispieldrucker'), 409, /letzte Drucker/);
    for (const id of ['petg', 'abs', 'tpu']) store.deleteItem('materials', id);
    throwsStoreError(() => store.deleteItem('materials', 'pla'), 409, /letzte Material/);
  });

  it('falls back to another printer when the selected one is deleted', () => {
    const dir = tempDir();
    const store = createStore(dir);
    const { item } = store.addItem('printers', { name: 'Zweiter', powerW: 200, throughputCm3PerH: 30, wearPerHour: 0.5 });
    store.setLastPrint({ printerId: item.id, materialId: 'abs', layerHeightMm: 0.2, infillPercent: 15, support: false });
    const { lastPrint } = store.deleteItem('printers', item.id);
    assert.equal(lastPrint.printerId, 'beispieldrucker');
    assert.equal(lastPrint.materialId, 'abs');
    assert.equal(readJson(path.join(dir, 'last-print.json')).printerId, 'beispieldrucker');
  });

  it('reports unknown items', () => {
    const store = createStore(tempDir());
    throwsStoreError(() => store.updateItem('printers', 'gibtsnicht', { name: 'X', powerW: 1, throughputCm3PerH: 1, wearPerHour: 0 }), 404);
    throwsStoreError(() => store.deleteItem('materials', 'gibtsnicht'), 404);
  });

  it('keeps a broken settings file as backup and starts with defaults', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ "printers": [ kaputt');
    const state = createStore(dir).getState();
    assert.equal(state.settings.printers[0].id, 'beispieldrucker');
    assert.equal(state.warnings.length, 1);
    assert.match(state.warnings[0], /beschädigt/);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.defekt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ "printers": [ kaputt');
  });

  it('fills in values that are missing in older or hand-edited files', () => {
    const dir = tempDir();
    // Settings from before wall thickness, wage, wear and labour rules existed, and a printer without id.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      electricityPricePerKwh: 0.3,
      profitMarginPercent: 40,
      supportSurchargePercent: 10,
      printers: [
        { name: 'Ohne ID', powerW: 90, throughputCm3PerH: 15 },
        { id: 'alt', name: 'Alter Drucker', powerW: 120, throughputCm3PerH: 25 },
      ],
      materials: [{ id: 'pla', name: 'PLA', pricePerKg: 19, densityGPerCm3: 1.24 }],
    }));
    // last-print.json of the previous version still has a manual labour time
    fs.writeFileSync(path.join(dir, 'last-print.json'), JSON.stringify({
      printerId: 'alt', materialId: 'pla', layerHeightMm: 0.16, infillPercent: 20, labourMinutes: 10, support: true,
    }));
    const { settings, lastPrint, warnings } = createStore(dir).getState();
    assert.deepEqual(warnings, []);
    assert.equal(settings.wallThicknessMm, 0.8);
    assert.equal(settings.wagePerHour, 14);
    assert.deepEqual(
      [settings.shippingMinutes, settings.plateMinutesMin, settings.plateMinutesMax, settings.fullPlateVolumeCm3],
      [6, 3, 15, 500],
    );
    assert.deepEqual(settings.printers.map((p) => p.wearPerHour), [0.25, 0.25]);
    assert.equal(settings.electricityPricePerKwh, 0.3); // existing values stay
    assert.match(settings.printers[0].id, /^[\w-]+$/);
    assert.deepEqual(lastPrint, {
      printerId: 'alt', materialId: 'pla', layerHeightMm: 0.16, infillPercent: 20, support: true,
    });
    // the filled-in values are written back, so they stay stable across restarts
    const onDisk = readJson(path.join(dir, 'settings.json'));
    assert.equal(onDisk.wagePerHour, 14);
    assert.equal(onDisk.shippingMinutes, 6);
    assert.equal(onDisk.printers[1].wearPerHour, 0.25);
    assert.equal(createStore(dir).getState().settings.printers[0].id, settings.printers[0].id);
  });

  it('writes files atomically without leftovers', () => {
    const dir = tempDir();
    const store = createStore(dir);
    for (let i = 0; i < 20; i++) {
      store.setLastPrint({ printerId: null, materialId: null, layerHeightMm: 0.2, infillPercent: i, support: false });
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['last-print.json', 'settings.json']);
  });
});

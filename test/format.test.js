// Number formatting/parsing (German and English) and input validation.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatDuration,
  formatEuroCents,
  formatEuroPrecise,
  formatInputNumber,
  formatNumber,
  parseDecimal,
} from '../public/lib/format.js';
import {
  checkNumber,
  checkPlateMinutes,
  validateGeneral,
  validateJob,
  validateLastPrint,
  validateMaterial,
  validatePrinter,
} from '../public/lib/validate.js';

describe('number input', () => {
  it('understands decimal comma and decimal point', () => {
    assert.equal(parseDecimal('0,2'), 0.2);
    assert.equal(parseDecimal('0.2'), 0.2);
    assert.equal(parseDecimal(' 24,99 '), 24.99);
    assert.equal(parseDecimal('1.234,5'), 1234.5);
    assert.equal(parseDecimal(',5'), 0.5);
    assert.equal(parseDecimal(7), 7);
  });

  it('rejects text that is not a number', () => {
    for (const input of ['', 'abc', '1,2,3', '12a', '--1', null, undefined, true]) {
      assert.ok(Number.isNaN(parseDecimal(input)), `${input} should not parse`);
    }
  });

  it('formats for German readers', () => {
    assert.equal(formatInputNumber(0.2), '0,2');
    assert.equal(formatInputNumber(1240), '1240');
    assert.equal(formatEuroCents(1234).replace(/\s/g, ' '), '12,34 €');
    assert.equal(formatDuration(0.5), '30 min');
    assert.equal(formatDuration(2.25), '2 h 15 min');
    assert.equal(formatDuration(0.001), '< 1 min');
  });

  it('formats for English readers', () => {
    assert.equal(formatInputNumber(0.2, 'en'), '0.2');
    assert.equal(formatNumber(1234.5, 2, 'en'), '1,234.50');
    assert.equal(formatEuroCents(1234, 'en'), '€12.34');
    assert.equal(formatEuroPrecise(1.30496, { truncate: true, lang: 'en' }), '€1.3049');
    assert.equal(formatDuration(1001.5, 'en'), '1,001 h 30 min');
  });

  it('reads English input, including thousands separators', () => {
    assert.equal(parseDecimal('0.2', 'en'), 0.2);
    assert.equal(parseDecimal('1,234.5', 'en'), 1234.5);
    assert.equal(parseDecimal('1,000', 'en'), 1000);
    assert.equal(parseDecimal('12,345,678', 'en'), 12345678);
    assert.equal(parseDecimal('0,25', 'en'), 0.25); // a decimal comma still works
    assert.equal(parseDecimal('2,5', 'en'), 2.5);
    assert.ok(Number.isNaN(parseDecimal('1.2.3', 'en')));
  });

  it('shows exact amounts in the calculation steps without misleading rounding', () => {
    const plain = (text) => text.replace(/\s/g, ' ');
    assert.equal(plain(formatEuroPrecise(0.81842)), '0,8184 €');
    assert.equal(plain(formatEuroPrecise(1.30496)), '1,3050 €'); // rounded …
    assert.equal(plain(formatEuroPrecise(1.30496, { truncate: true })), '1,3049 €'); // … vs. cut, matches "1,30 €"
    assert.equal(plain(formatEuroPrecise(1.305, { truncate: true })), '1,3050 €');
  });
});

describe('validation', () => {
  it('accepts valid printers and materials and normalizes them', () => {
    assert.deepEqual(validatePrinter({ name: '  Prusa   MK4S ', powerW: '80', throughputCm3PerH: '18,5', wearPerHour: '0,3' }), {
      value: { name: 'Prusa MK4S', powerW: 80, throughputCm3PerH: 18.5, wearPerHour: 0.3 },
    });
    assert.deepEqual(validateMaterial({ name: 'PLA', pricePerKg: 0, densityGPerCm3: 1.24 }), {
      value: { name: 'PLA', pricePerKg: 0, densityGPerCm3: 1.24 },
    });
  });

  it('returns German messages per field', () => {
    const result = validatePrinter({ name: ' ', powerW: 0, throughputCm3PerH: 'schnell', wearPerHour: -0.1 });
    assert.deepEqual(result.errors, {
      name: 'Bitte einen Namen eingeben.',
      powerW: 'Muss größer als 0 W sein.',
      throughputCm3PerH: 'Bitte eine Zahl eingeben.',
      wearPerHour: 'Mindestens 0 €/h.',
    });
    assert.equal(checkNumber('infillPercent', 120).error, 'Höchstens 100 %.');
    assert.equal(checkNumber('layerHeightMm', '0').error, 'Mindestens 0,01 mm.');
    assert.equal(checkNumber('wagePerHour', '13,90').value, 13.9);
    assert.equal(checkNumber('shippingMinutes', -1).error, 'Mindestens 0 min.');
  });

  it('checks the per-print values that are remembered', () => {
    const valid = { printerId: 'a', materialId: null, layerHeightMm: 0.2, infillPercent: 15, support: true };
    assert.deepEqual(validateLastPrint(valid).value, valid);
    assert.ok(validateLastPrint({ ...valid, printerId: '../x' }).errors.printerId);
    assert.ok(validateLastPrint({ ...valid, support: 'ja' }).errors.support);
    // the manual labour time of an older version is simply dropped
    assert.deepEqual(validateLastPrint({ ...valid, labourMinutes: 10 }).value, valid);
  });

  it('checks pieces and plates', () => {
    assert.deepEqual(validateJob({ objectCount: '10', plateCount: 2 }).value, { objectCount: 10, plateCount: 2 });
    assert.equal(validateJob({ objectCount: 2, plateCount: 3 }).errors.plateCount, 'Höchstens so viele Platten wie Stücke.');
    assert.equal(validateJob({ objectCount: 1.5, plateCount: 1 }).errors.objectCount, 'Bitte eine ganze Zahl eingeben.');
    assert.equal(validateJob({ objectCount: 0, plateCount: 1 }).errors.objectCount, 'Mindestens 1 Stück.');
    assert.equal(validateJob({ objectCount: 5, plateCount: '2,5' }).errors.plateCount, 'Bitte eine ganze Zahl eingeben.');
  });

  it('checks that the labour per plate goes from minimum to maximum', () => {
    const general = {
      electricityPricePerKwh: 0.35, wagePerHour: 14, profitMarginPercent: 50, supportSurchargePercent: 20, wallThicknessMm: 0.8,
      shippingMinutes: 6, plateMinutesMin: 3, plateMinutesMax: 15, fullPlateVolumeCm3: 500,
    };
    assert.deepEqual(validateGeneral(general).value, general);
    assert.match(validateGeneral({ ...general, plateMinutesMin: 20 }).errors.plateMinutesMax, /Mindestzeit .* nicht größer/);
    assert.ok(validateGeneral({ ...general, fullPlateVolumeCm3: 0 }).errors.fullPlateVolumeCm3);
    assert.equal(checkPlateMinutes(3, 3), null);
  });

  it('gives English messages with English numbers and units', () => {
    assert.deepEqual(validatePrinter({ name: ' ', powerW: 0, throughputCm3PerH: 'fast', wearPerHour: -0.1 }, 'en').errors, {
      name: 'Please enter a name.',
      powerW: 'Must be greater than 0 W.',
      throughputCm3PerH: 'Please enter a number.',
      wearPerHour: 'At least €0/h.',
    });
    assert.equal(checkNumber('infillPercent', 120, 'en').error, 'At most 100%.');
    assert.equal(checkNumber('wagePerHour', 2000, 'en').error, 'At most €1,000/h.');
    assert.equal(checkNumber('wagePerHour', 2000).error, 'Höchstens 1.000 €/h.');
    assert.equal(checkNumber('layerHeightMm', '0', 'en').error, 'At least 0.01 mm.');
    assert.equal(checkNumber('layerHeightMm', '0.12', 'en').value, 0.12);
    assert.equal(checkNumber('fullPlateVolumeCm3', 200000, 'en').error, 'At most 100,000 cm³.');
    assert.equal(validateJob({ objectCount: 0, plateCount: 1 }, 'en').errors.objectCount, 'At least 1 piece.');
    assert.equal(validateJob({ objectCount: 20000, plateCount: 1 }, 'en').errors.objectCount, 'At most 10,000 pieces.');
    assert.equal(validateJob({ objectCount: 2, plateCount: 3 }, 'en').errors.plateCount, 'No more plates than pieces.');
    assert.equal(checkPlateMinutes(5, 3, 'en'), 'The minimum time per plate must not be greater than the maximum.');
  });
});

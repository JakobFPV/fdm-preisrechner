// Price and weight calculation.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculatePrice, minutesPerPlate, REFERENCE_LAYER_HEIGHT_MM, toCents } from '../public/lib/calc.js';
import { analyzeModelFile } from '../public/lib/mesh.js';
import { defaultLastPrint, defaultSettings } from '../src/defaults.js';
import { binaryStl, boxTriangles } from './helpers/models.js';

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

// The 20 × 20 × 20 mm test cube, read from a real STL file: 8 cm³, surface 6 × 4 cm² = 24 cm².
const cube = await analyzeModelFile(binaryStl(boxTriangles(20, 20, 20)), 'wuerfel.stl');

// Round numbers keep the expected values easy to check by hand.
// Wear and labour are 0 here, so these tests check material and electricity on their own;
// wear, labour, pieces and plates have their own tests further down.
const material = { pricePerKg: 20, densityGPerCm3: 1.25 }; // 20 €/kg, 1.25 g/cm³
const slowPrinter = { powerW: 100, throughputCm3PerH: 10, wearPerHour: 0 }; // 100 W, 10 cm³/h
const fastPrinter = { powerW: 250, throughputCm3PerH: 40, wearPerHour: 0 }; // 250 W, 40 cm³/h
const noLabour = { shippingMinutes: 0, plateMinutesMin: 0, plateMinutesMax: 0, fullPlateVolumeCm3: 500 };
const labourRules = { shippingMinutes: 6, plateMinutesMin: 3, plateMinutesMax: 15, fullPlateVolumeCm3: 500 };
const settings = {
  electricityPricePerKwh: 0.5,
  wagePerHour: 14,
  profitMarginPercent: 0,
  supportSurchargePercent: 25,
  wallThicknessMm: 1, // walls of the cube: 24 cm² × 0.1 cm = 2.4 cm³ = 30 %
  ...noLabour,
};
const print = { layerHeightMm: 0.2, infillPercent: 100, support: false };

function calc({ printer = slowPrinter, settings: s = {}, print: p = {}, model = cube } = {}) {
  return calculatePrice({
    model,
    printer,
    material,
    settings: { ...settings, ...s },
    print: { ...print, ...p },
  });
}

describe('20 mm test cube', () => {
  it('has a volume of 8 cm³ and a surface of 24 cm²', () => {
    near(cube.volumeCm3, 8);
    near(cube.surfaceAreaCm2, 24);
    assert.deepEqual(cube.sizeMm, { x: 20, y: 20, z: 20 });
  });

  it('100 % infill: the whole volume is printed', () => {
    const r = calc({ print: { infillPercent: 100 } });
    near(r.materialVolumeCm3, 8);
    near(r.weightG, 10); // 8 cm³ × 1.25 g/cm³
    near(r.materialCost, 0.2); // 10 g × 20 €/kg
    assert.equal(r.materialCostCents, 20);
  });

  it('0 % infill: only the walls are printed', () => {
    const r = calc({ print: { infillPercent: 0 } });
    near(r.shellVolumeCm3, 2.4);
    near(r.wallShare, 0.3);
    near(r.infillVolumeCm3, 0);
    near(r.materialVolumeCm3, 2.4);
    near(r.weightG, 3); // 2.4 cm³ × 1.25 g/cm³
    near(r.materialCost, 0.06);
  });

  it('partial infill fills the inner volume proportionally', () => {
    const r = calc({ print: { infillPercent: 50 } });
    near(r.innerVolumeCm3, 5.6);
    near(r.materialVolumeCm3, 2.4 + 5.6 * 0.5);
    near(r.weightG, 6.5);
  });

  it('without support no support material is added', () => {
    const r = calc({ print: { support: false } });
    near(r.supportVolumeCm3, 0);
    near(r.supportWeightG, 0);
    near(r.weightG, 10);
  });

  it('with support the surcharge is added to material, weight, time and electricity', () => {
    const without = calc({ print: { support: false } });
    const withSupport = calc({ print: { support: true } });
    near(withSupport.supportVolumeCm3, 2); // 25 % of 8 cm³
    near(withSupport.weightG, 12.5);
    near(withSupport.supportWeightG, 2.5);
    near(withSupport.materialCost, 0.25);
    near(withSupport.printHours, without.printHours * 1.25);
    near(withSupport.energyKwh, without.energyKwh * 1.25);
  });

  it('with support and 0 % infill the surcharge applies to the walls only', () => {
    const r = calc({ print: { support: true, infillPercent: 0 } });
    near(r.materialVolumeCm3, 3); // 2.4 cm³ × 1.25
    near(r.weightG, 3.75);
  });

  it('0 % margin: the price is exactly the costs, without profit', () => {
    const r = calc({ settings: { profitMarginPercent: 0 } });
    // 8 cm³ ÷ 10 cm³/h = 0.8 h; 100 W × 0.8 h = 0.08 kWh × 0.50 €/kWh = 0.04 €
    near(r.printHours, 0.8);
    near(r.energyKwh, 0.08);
    near(r.electricityCost, 0.04);
    near(r.profit, 0);
    near(r.price, 0.24);
    assert.equal(r.profitCents, 0);
    assert.equal(r.priceCents, 24);
  });

  it('the profit margin is added on top of the costs', () => {
    const r = calc({ settings: { profitMarginPercent: 50 } });
    near(r.cost, 0.24);
    near(r.profit, 0.12);
    near(r.price, 0.36);
    assert.equal(r.priceCents, 36);
  });

  it('two printers with different power draw and throughput', () => {
    const slow = calc({ printer: slowPrinter });
    const fast = calc({ printer: fastPrinter });

    // Same model and material → same weight and material cost
    near(slow.weightG, fast.weightG);
    near(slow.materialCost, fast.materialCost);

    // Time: 8 cm³ ÷ 10 cm³/h = 0.8 h vs. 8 cm³ ÷ 40 cm³/h = 0.2 h
    near(slow.printHours, 0.8);
    near(fast.printHours, 0.2);

    // Energy: 100 W × 0.8 h = 0.08 kWh vs. 250 W × 0.2 h = 0.05 kWh
    near(slow.energyKwh, 0.08);
    near(fast.energyKwh, 0.05);
    near(slow.electricityCost, 0.04);
    near(fast.electricityCost, 0.025);

    near(slow.price, 0.24);
    near(fast.price, 0.225);
  });

  it('thinner layers take proportionally longer', () => {
    const reference = calc({ print: { layerHeightMm: REFERENCE_LAYER_HEIGHT_MM } });
    const fine = calc({ print: { layerHeightMm: 0.1 } });
    const coarse = calc({ print: { layerHeightMm: 0.3 } });
    near(reference.printHours, 0.8);
    near(fine.printHours, 1.6);
    near(coarse.printHours, 0.8 / 1.5);
    near(fine.weightG, reference.weightG); // layer height does not change the material amount
  });

  it('a more expensive material only changes the material cost', () => {
    const cheap = calc();
    const expensive = calculatePrice({
      model: cube,
      printer: slowPrinter,
      material: { ...material, pricePerKg: 40 },
      settings,
      print,
    });
    near(expensive.materialCost, cheap.materialCost * 2);
    near(expensive.electricityCost, cheap.electricityCost);
  });
});

describe('pieces and plates', () => {
  it('the number of pieces multiplies material, weight, print time, electricity and wear', () => {
    const printer = { ...slowPrinter, wearPerHour: 0.3 };
    const one = calc({ printer });
    const five = calc({ printer, print: { objectCount: 5 } });
    near(five.materialVolumeCm3, 40);
    near(five.weightG, 50);
    near(five.weightPerObjectG, 10);
    near(five.materialCost, 1);
    near(five.printHours, 4); // 40 cm³ ÷ 10 cm³/h
    near(five.energyKwh, 0.4);
    near(five.wearCost, 1.2); // 4 h × 0.30 €/h
    near(five.price, one.price * 5); // no labour in these settings
    // material 1.00 + electricity 0.20 + wear 1.20 = 2.40 €, i.e. 0.48 € per piece
    assert.equal(five.priceCents, 240);
    assert.equal(five.pricePerObjectCents, 48);
  });

  it('the number of plates does not change material or print time, only labour', () => {
    const onePlate = calc({ settings: labourRules, print: { objectCount: 10, plateCount: 1 } });
    const twoPlates = calc({ settings: labourRules, print: { objectCount: 10, plateCount: 2 } });
    near(onePlate.weightG, twoPlates.weightG);
    near(onePlate.printHours, twoPlates.printHours);
    assert.notEqual(onePlate.labourMinutes, twoPlates.labourMinutes);
  });

  it('default is one piece on one plate', () => {
    const r = calc();
    assert.equal(r.objectCount, 1);
    assert.equal(r.plateCount, 1);
    assert.equal(r.pricePerObjectCents, r.priceCents);
  });
});

describe('labour: fixed shipping plus 3–15 minutes per plate', () => {
  it('handling per plate grows with the model volume on the plate', () => {
    assert.equal(minutesPerPlate(0, labourRules), 3);
    assert.equal(minutesPerPlate(8, labourRules), 3); // 3 + 12 × 8/500 = 3.19 → 3
    assert.equal(minutesPerPlate(80, labourRules), 5); // 3 + 12 × 0.16 = 4.92 → 5
    assert.equal(minutesPerPlate(250, labourRules), 9); // half full
    assert.equal(minutesPerPlate(500, labourRules), 15); // full plate
    assert.equal(minutesPerPlate(5000, labourRules), 15); // never more than the maximum
  });

  it('one small piece: 6 min shipping + 3 min for its plate = 9 min', () => {
    const r = calc({ settings: labourRules });
    near(r.modelVolumePerPlateCm3, 8);
    assert.equal(r.plateMinutes, 3);
    assert.equal(r.labourMinutes, 9);
    near(r.labourCost, (9 / 60) * 14); // 2,10 €
    assert.equal(r.labourCostCents, 210);
    near(r.price, 0.24 + 2.1); // 0 % margin
  });

  it('shipping is counted once per order, the plate time per plate', () => {
    // 10 cubes on 1 plate: 80 cm³ per plate → 5 min; 6 + 1 × 5 = 11 min
    const onePlate = calc({ settings: labourRules, print: { objectCount: 10, plateCount: 1 } });
    assert.equal(onePlate.plateMinutes, 5);
    assert.equal(onePlate.labourMinutes, 11);
    // 10 cubes on 2 plates: 40 cm³ per plate → 4 min; 6 + 2 × 4 = 14 min
    const twoPlates = calc({ settings: labourRules, print: { objectCount: 10, plateCount: 2 } });
    near(twoPlates.modelVolumePerPlateCm3, 40);
    assert.equal(twoPlates.plateMinutes, 4);
    assert.equal(twoPlates.labourMinutes, 14);
    near(twoPlates.labourCost, (14 / 60) * 14);
  });

  it('large models get the maximum of 15 minutes per plate', () => {
    const big = { volumeCm3: 600, surfaceAreaCm2: 500 };
    const r = calc({ model: big, settings: labourRules });
    assert.equal(r.plateMinutes, 15);
    assert.equal(r.labourMinutes, 21);
    const full = calc({ settings: labourRules, print: { objectCount: 100, plateCount: 1 } }); // 800 cm³
    assert.equal(full.plateMinutes, 15);
  });

  it('labour scales with the hourly wage and the settings', () => {
    near(calc({ settings: { ...labourRules, wagePerHour: 28 } }).labourCost, (9 / 60) * 28);
    near(calc({ settings: { ...labourRules, wagePerHour: 0 } }).labourCost, 0);
    assert.equal(calc({ settings: { ...labourRules, shippingMinutes: 10 } }).labourMinutes, 13);
  });

  it('labour matches its formula exactly: 11 min × 14 €/h = 2,57 €', () => {
    const r = calc({ settings: { ...labourRules, profitMarginPercent: 100 }, print: { objectCount: 10, infillPercent: 15 } });
    assert.equal(r.labourMinutes, 11);
    assert.equal(r.labourCostCents, toCents((11 / 60) * 14));
    assert.equal(r.labourCostCents, 257);
    assert.equal(r.materialCostCents + r.electricityCostCents + r.wearCostCents + r.labourCostCents, r.costCents);
    assert.equal(r.costCents + r.profitCents, r.priceCents);
  });
});

describe('wear', () => {
  it('wear: print hours × the wear cost of the selected printer', () => {
    const slow = calc({ printer: { ...slowPrinter, wearPerHour: 0.3 } });
    const fast = calc({ printer: { ...fastPrinter, wearPerHour: 0.5 } });
    near(slow.wearCost, 0.8 * 0.3); // 0.24 €
    near(fast.wearCost, 0.2 * 0.5); // 0.10 €
    assert.equal(slow.wearCostCents, 24);
    assert.equal(fast.wearCostCents, 10);
    near(slow.price, 0.24 + 0.24);
  });

  it('wear grows with the print time (thinner layers, support)', () => {
    const printer = { ...slowPrinter, wearPerHour: 0.3 };
    const base = calc({ printer });
    near(calc({ printer, print: { layerHeightMm: 0.1 } }).wearCost, base.wearCost * 2);
    near(calc({ printer, print: { support: true } }).wearCost, base.wearCost * 1.25);
  });

  it('the profit margin applies to all costs: material, electricity, wear and labour', () => {
    const r = calc({
      printer: { ...slowPrinter, wearPerHour: 0.3 },
      settings: { ...labourRules, profitMarginPercent: 50 },
    });
    // material 0.20 + electricity 0.04 + wear 0.24 + labour 2.10 (9 min) = 2.58 €; × 1.5 = 3.87 €
    near(r.cost, 2.58);
    near(r.profit, 1.29);
    near(r.price, 3.87);
    assert.equal(r.priceCents, 387);
  });
});

describe('README example', () => {
  it('20 mm cube with the default settings costs 3,32 €', () => {
    const defaults = defaultSettings();
    const r = calculatePrice({
      model: cube,
      printer: defaults.printers[0],
      material: defaults.materials.find((m) => m.id === 'pla'),
      settings: defaults,
      print: defaultLastPrint(defaults),
    });
    assert.equal(defaults.wagePerHour, 14);
    assert.equal(defaults.shippingMinutes, 6);
    assert.equal(r.objectCount, 1);
    near(r.weightG, 3.51168);
    near(r.wearCost, 0.1416 * 0.25);
    assert.equal(r.labourMinutes, 9); // 6 min shipping + 3 min for one plate
    near(r.labourCost, 2.1);
    assert.equal(r.priceCents, 332);
  });

  it('10 cubes on 2 plates with the default settings cost 6,56 €', () => {
    const defaults = defaultSettings();
    const r = calculatePrice({
      model: cube,
      printer: defaults.printers[0],
      material: defaults.materials.find((m) => m.id === 'pla'),
      settings: defaults,
      print: { ...defaultLastPrint(defaults), objectCount: 10, plateCount: 2 },
    });
    near(r.modelVolumePerPlateCm3, 40);
    assert.equal(r.plateMinutes, 4); // 3 + 12 × 40/500 = 3.96 → 4
    assert.equal(r.labourMinutes, 14); // 6 + 2 × 4
    assert.equal(r.priceCents, 656);
    assert.equal(r.pricePerObjectCents, 66);
  });
});

describe('edge cases', () => {
  it('walls never exceed the model volume (thin parts are printed solid)', () => {
    // 100 × 100 × 1 mm plate: 10 cm³, surface 204 cm² → walls would be 20.4 cm³
    const plate = { volumeCm3: 10, surfaceAreaCm2: 204 };
    const r = calc({ model: plate, print: { infillPercent: 0 } });
    near(r.shellVolumeCm3, 10);
    near(r.wallShare, 1);
    near(r.weightG, 12.5);
  });

  it('wall thickness 0 means 0 % infill prints nothing', () => {
    const r = calc({ settings: { wallThicknessMm: 0 }, print: { infillPercent: 0 } });
    near(r.weightG, 0);
    assert.equal(r.priceCents, 0);
  });

  const randomInput = (support, margin) => {
    const objectCount = 1 + Math.floor(Math.random() * 20);
    const plateMinutesMin = Math.random() * 5;
    return {
      model: { volumeCm3: Math.random() * 500, surfaceAreaCm2: Math.random() * 600 },
      printer: { powerW: 30 + Math.random() * 400, throughputCm3PerH: 2 + Math.random() * 60, wearPerHour: Math.random() },
      material: { pricePerKg: Math.random() * 80, densityGPerCm3: 0.9 + Math.random() },
      settings: {
        electricityPricePerKwh: Math.random(),
        wagePerHour: Math.random() * 30,
        profitMarginPercent: margin ?? Math.random() * 200,
        supportSurchargePercent: Math.random() * 60,
        wallThicknessMm: Math.random() * 2,
        shippingMinutes: Math.random() * 10,
        plateMinutesMin,
        plateMinutesMax: plateMinutesMin + Math.random() * 15,
        fullPlateVolumeCm3: 50 + Math.random() * 1000,
      },
      print: {
        layerHeightMm: 0.05 + Math.random() * 0.3,
        infillPercent: Math.random() * 100,
        support,
        objectCount,
        plateCount: 1 + Math.floor(Math.random() * objectCount),
      },
    };
  };

  it('the rounded amounts always add up to the shown price', () => {
    for (let i = 0; i < 500; i++) {
      const input = randomInput(i % 2 === 0);
      const r = calculatePrice(input);
      assert.equal(r.priceCents, r.materialCostCents + r.electricityCostCents + r.wearCostCents + r.labourCostCents + r.profitCents);
      // the shown price is the exact price rounded to the cent …
      assert.ok(Math.abs(r.priceCents - r.price * 100) <= 0.5 + 1e-6, `price ${r.priceCents} vs ${r.price}`);
      // … and every line is less than a cent away from its exact value
      for (const [cents, exact] of [
        [r.materialCostCents, r.materialCost],
        [r.electricityCostCents, r.electricityCost],
        [r.wearCostCents, r.wearCost],
        [r.labourCostCents, r.labourCost],
      ]) {
        assert.ok(Math.abs(cents - exact * 100) < 1 + 1e-6, `${cents} vs ${exact}`);
        assert.ok(cents >= 0);
      }
      assert.ok(Math.abs(r.profitCents - r.profit * 100) <= 1 + 1e-6);
      assert.ok(r.profitCents >= 0);
      // labour is shown as "minutes × wage", so it is always rounded on its own
      assert.equal(r.labourCostCents, toCents(r.labourCost));
      // minutes per plate stay within the configured range
      assert.ok(r.plateMinutes >= Math.round(input.settings.plateMinutesMin));
      assert.ok(r.plateMinutes <= Math.round(input.settings.plateMinutesMax));
      near(r.labourMinutes, input.settings.shippingMinutes + r.plateCount * r.plateMinutes, 1e-9);
    }
  });

  it('0 % margin never shows a profit, even with rounding', () => {
    for (let i = 0; i < 300; i++) {
      const r = calculatePrice(randomInput(i % 2 === 0, 0));
      assert.equal(r.profitCents, 0);
      assert.equal(r.priceCents, r.costCents);
    }
  });

  it('rounds half cents up despite binary floating point', () => {
    assert.equal(toCents(0.285), 29);
    assert.equal(toCents(0.005), 1);
    assert.equal(toCents(1.004), 100);
  });
});

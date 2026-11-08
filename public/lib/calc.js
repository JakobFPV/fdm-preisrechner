// Price estimate for an FDM print order – a transparent model without a slicer.
// Pure functions without DOM access, used by the browser and by the tests.
//
// Per piece:
//   walls          = min(volume, surface area × wall thickness)
//   part           = walls + (volume − walls) × infill
//   material       = part × (1 + support surcharge)              (surcharge only with support)
// For the whole order (all pieces):
//   weight         = material × pieces × density
//   print time     = material × pieces ÷ (throughput × layer height ÷ 0.2 mm)
//   electricity    = power × print time × electricity price
//   wear           = print time × the printer's wear cost per hour
//   labour         = (shipping minutes + plates × minutes per plate) × hourly wage
//                    minutes per plate: from the minimum to the maximum, by model volume per plate
//   price          = (material + electricity + wear + labour) × (1 + profit margin)

/** Layer height at which a printer's throughput is specified. */
export const REFERENCE_LAYER_HEIGHT_MM = 0.2;

/** Rounds a euro amount to whole cents (robust against binary float noise like 0.285 * 100). */
export function toCents(euros) {
  return Math.round(exactCents(euros));
}

function exactCents(euros) {
  return Number((euros * 100).toPrecision(12));
}

/**
 * Splits `totalCents` into whole cents for each exact euro amount (largest remainder method):
 * the parts add up to the total and each part is less than one cent away from its exact value.
 */
function splitCents(amounts, totalCents) {
  const exact = amounts.map(exactCents);
  const cents = exact.map(Math.floor);
  let missing = totalCents - cents.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - cents[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; missing > 0 && i < 4 * byRemainder.length; i++) {
    cents[byRemainder[i % byRemainder.length].index] += 1;
    missing -= 1;
  }
  // Only possible through floating point noise: take cents back from the smallest remainders.
  for (let i = byRemainder.length - 1; missing < 0 && i >= 0; i--) {
    const { index } = byRemainder[i];
    if (cents[index] > 0) {
      cents[index] -= 1;
      missing += 1;
    }
  }
  return cents;
}

/**
 * Handling time per build plate (removing the parts, cleaning up) in whole minutes:
 * grows linearly with the model volume on the plate, from the minimum (empty plate)
 * to the maximum (plate holds `fullPlateVolumeCm3` or more).
 */
export function minutesPerPlate(modelVolumePerPlateCm3, settings) {
  const fill = Math.min(1, Math.max(0, modelVolumePerPlateCm3 / settings.fullPlateVolumeCm3));
  return Math.round(settings.plateMinutesMin + (settings.plateMinutesMax - settings.plateMinutesMin) * fill);
}

/**
 * @param {object} input
 * @param {{volumeCm3: number, surfaceAreaCm2: number}} input.model
 * @param {{powerW: number, throughputCm3PerH: number, wearPerHour: number}} input.printer
 * @param {{pricePerKg: number, densityGPerCm3: number}} input.material
 * @param {{electricityPricePerKwh: number, wagePerHour: number, shippingMinutes: number,
 *          plateMinutesMin: number, plateMinutesMax: number, fullPlateVolumeCm3: number,
 *          profitMarginPercent: number, supportSurchargePercent: number, wallThicknessMm: number}} input.settings
 * @param {{layerHeightMm: number, infillPercent: number, support: boolean,
 *          objectCount?: number, plateCount?: number}} input.print
 */
export function calculatePrice({ model, printer, material, settings, print }) {
  const objectCount = print.objectCount ?? 1;
  const plateCount = print.plateCount ?? 1;
  const volumeCm3 = model.volumeCm3;

  // Material amount of one piece
  const shellVolumeCm3 = Math.min(volumeCm3, model.surfaceAreaCm2 * (settings.wallThicknessMm / 10));
  const innerVolumeCm3 = volumeCm3 - shellVolumeCm3;
  const infillVolumeCm3 = innerVolumeCm3 * (print.infillPercent / 100);
  const partVolumeCm3 = shellVolumeCm3 + infillVolumeCm3;
  const supportVolumeCm3 = print.support ? partVolumeCm3 * (settings.supportSurchargePercent / 100) : 0;
  const materialVolumePerObjectCm3 = partVolumeCm3 + supportVolumeCm3;

  // Whole order
  const materialVolumeCm3 = materialVolumePerObjectCm3 * objectCount;
  const weightPerObjectG = materialVolumePerObjectCm3 * material.densityGPerCm3;
  const weightG = materialVolumeCm3 * material.densityGPerCm3;
  const supportWeightG = supportVolumeCm3 * objectCount * material.densityGPerCm3;

  // Time and energy: thinner layers move less material per second
  const throughputCm3PerH = printer.throughputCm3PerH * (print.layerHeightMm / REFERENCE_LAYER_HEIGHT_MM);
  const printHours = materialVolumeCm3 / throughputCm3PerH;
  const energyKwh = (printer.powerW * printHours) / 1000;

  // Labour: shipping once per order, handling per build plate
  const modelVolumePerPlateCm3 = (volumeCm3 * objectCount) / plateCount;
  const plateMinutes = minutesPerPlate(modelVolumePerPlateCm3, settings);
  const labourMinutes = settings.shippingMinutes + plateCount * plateMinutes;
  const labourHours = labourMinutes / 60;

  // Money (exact values)
  const materialCost = (weightG / 1000) * material.pricePerKg;
  const electricityCost = energyKwh * settings.electricityPricePerKwh;
  const wearCost = printHours * printer.wearPerHour;
  const labourCost = labourHours * settings.wagePerHour;
  const cost = materialCost + electricityCost + wearCost + labourCost;
  const profit = cost * (settings.profitMarginPercent / 100);
  const price = cost + profit;

  // Money for display: the price is the exact price rounded to the cent, and all lines add up to it.
  // Labour is shown with its formula (minutes × wage), so it is rounded on its own; material,
  // electricity and wear share the remaining cents (each less than a cent from its exact value).
  const costCents = toCents(cost);
  const priceCents = Math.max(toCents(price), costCents);
  const labourCostCents = Math.min(toCents(labourCost), costCents);
  const [materialCostCents, electricityCostCents, wearCostCents] =
    splitCents([materialCost, electricityCost, wearCost], costCents - labourCostCents);
  const profitCents = priceCents - costCents;

  return {
    objectCount,
    plateCount,
    volumeCm3,
    shellVolumeCm3,
    wallShare: volumeCm3 > 0 ? shellVolumeCm3 / volumeCm3 : 0,
    innerVolumeCm3,
    infillVolumeCm3,
    partVolumeCm3,
    supportVolumeCm3,
    materialVolumePerObjectCm3,
    materialVolumeCm3,
    weightPerObjectG,
    weightG,
    supportWeightG,
    throughputCm3PerH,
    printHours,
    energyKwh,
    modelVolumePerPlateCm3,
    plateMinutes,
    labourMinutes,
    labourHours,
    materialCost,
    electricityCost,
    wearCost,
    labourCost,
    cost,
    profit,
    price,
    materialCostCents,
    electricityCostCents,
    wearCostCents,
    labourCostCents,
    costCents,
    profitCents,
    priceCents,
    pricePerObjectCents: Math.round(priceCents / objectCount),
  };
}

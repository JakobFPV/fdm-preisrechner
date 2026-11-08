// Values used on the very first start (and when a settings file is broken).

/** Wear and tear per print hour (nozzle, belts, build plate, depreciation), also used for older printer entries. */
export const DEFAULT_WEAR_PER_HOUR = 0.25;

/** Name of the example printer per language; it follows the language until the user renames it. */
export const DEFAULT_PRINTER_NAMES = { de: 'Beispieldrucker', en: 'Example printer' };

export function defaultSettings() {
  return {
    version: 1,
    // null: no language chosen yet – the interface uses the browser's language and stores it
    language: null,
    electricityPricePerKwh: 0.35,
    wagePerHour: 14,
    profitMarginPercent: 50,
    supportSurchargePercent: 20,
    wallThicknessMm: 0.8,
    // Labour: shipping once per order, plus handling per build plate (more model volume → more time)
    shippingMinutes: 6,
    plateMinutesMin: 3,
    plateMinutesMax: 15,
    fullPlateVolumeCm3: 500,
    printers: [
      // Throughput: average material per hour at 0.2 mm layer height, including travel moves.
      {
        id: 'beispieldrucker',
        name: DEFAULT_PRINTER_NAMES.de,
        powerW: 100,
        throughputCm3PerH: 20,
        wearPerHour: DEFAULT_WEAR_PER_HOUR,
      },
    ],
    materials: [
      { id: 'pla', name: 'PLA', pricePerKg: 20, densityGPerCm3: 1.24 },
      { id: 'petg', name: 'PETG', pricePerKg: 22, densityGPerCm3: 1.27 },
      { id: 'abs', name: 'ABS', pricePerKg: 22, densityGPerCm3: 1.04 },
      { id: 'tpu', name: 'TPU', pricePerKg: 30, densityGPerCm3: 1.21 },
    ],
  };
}

export function defaultLastPrint(settings) {
  return {
    printerId: settings.printers[0]?.id ?? null,
    materialId: settings.materials[0]?.id ?? null,
    layerHeightMm: 0.2,
    infillPercent: 15,
    support: false,
  };
}

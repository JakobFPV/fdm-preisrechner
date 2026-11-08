// Validation rules, shared by the browser (instant feedback) and the server (authoritative check).
// Error messages are German because they are shown in the user interface.

import { formatCompact, parseDecimal } from './format.js';

export const NAME_MAX_LENGTH = 60;

/** Numeric fields with label, unit and allowed range. */
export const NUMBER_FIELDS = {
  powerW: { label: 'Leistung', unit: 'W', min: 0, exclusiveMin: true, max: 5000 },
  throughputCm3PerH: { label: 'Durchsatz', unit: 'cm³/h', min: 0, exclusiveMin: true, max: 1000 },
  wearPerHour: { label: 'Verschleiß', unit: '€/h', min: 0, max: 100 },
  pricePerKg: { label: 'Preis', unit: '€/kg', min: 0, max: 10000 },
  densityGPerCm3: { label: 'Dichte', unit: 'g/cm³', min: 0, exclusiveMin: true, max: 25 },
  electricityPricePerKwh: { label: 'Strompreis', unit: '€/kWh', min: 0, max: 10 },
  wagePerHour: { label: 'Stundenlohn', unit: '€/h', min: 0, max: 1000 },
  shippingMinutes: { label: 'Versand', unit: 'min', min: 0, max: 240 },
  plateMinutesMin: { label: 'Mindestzeit pro Platte', unit: 'min', min: 0, max: 240 },
  plateMinutesMax: { label: 'Höchstzeit pro Platte', unit: 'min', min: 0, max: 240 },
  fullPlateVolumeCm3: { label: 'Höchstzeit ab', unit: 'cm³', min: 0, exclusiveMin: true, max: 100000 },
  profitMarginPercent: { label: 'Gewinnmarge', unit: '%', min: 0, max: 10000 },
  supportSurchargePercent: { label: 'Stützmaterial-Zuschlag', unit: '%', min: 0, max: 1000 },
  wallThicknessMm: { label: 'Wandstärke', unit: 'mm', min: 0, max: 50 },
  layerHeightMm: { label: 'Schichthöhe', unit: 'mm', min: 0.01, max: 2 },
  infillPercent: { label: 'Füllung', unit: '%', min: 0, max: 100 },
  objectCount: { label: 'Stückzahl', unit: 'Stück', min: 1, max: 10000, integer: true },
  plateCount: { label: 'Druckplatten', unit: 'Platten', min: 1, max: 1000, integer: true },
};

const OTHER_LABELS = { name: 'Name', printerId: 'Drucker', materialId: 'Material', support: 'Stützstrukturen' };

export const PRINTER_KEYS = ['name', 'powerW', 'throughputCm3PerH', 'wearPerHour'];
export const MATERIAL_KEYS = ['name', 'pricePerKg', 'densityGPerCm3'];
export const GENERAL_KEYS = [
  'electricityPricePerKwh',
  'wagePerHour',
  'profitMarginPercent',
  'supportSurchargePercent',
  'wallThicknessMm',
  'shippingMinutes',
  'plateMinutesMin',
  'plateMinutesMax',
  'fullPlateVolumeCm3',
];
const LAST_PRINT_NUMBER_KEYS = ['layerHeightMm', 'infillPercent'];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const withUnit = (value, unit) => `${formatCompact(value, 4)} ${unit}`;

export function fieldLabel(key) {
  return NUMBER_FIELDS[key]?.label ?? OTHER_LABELS[key] ?? key;
}

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** Checks one numeric field. Returns `{ value }` or `{ error }`. Accepts numbers and typed strings ("0,2"). */
export function checkNumber(key, raw) {
  const spec = NUMBER_FIELDS[key];
  const value = parseDecimal(raw);
  if (!Number.isFinite(value)) return { error: 'Bitte eine Zahl eingeben.' };
  if (spec.exclusiveMin ? value <= spec.min : value < spec.min) {
    return {
      error: spec.exclusiveMin
        ? `Muss größer als ${withUnit(spec.min, spec.unit)} sein.`
        : `Mindestens ${withUnit(spec.min, spec.unit)}.`,
    };
  }
  if (value > spec.max) return { error: `Höchstens ${withUnit(spec.max, spec.unit)}.` };
  if (spec.integer && !Number.isInteger(value)) return { error: 'Bitte eine ganze Zahl eingeben.' };
  return { value };
}

/** Cross-field rule for the labour per plate. Returns a German message or null. */
export function checkPlateMinutes(min, max) {
  return min > max ? 'Die Mindestzeit pro Platte darf nicht größer als die Höchstzeit sein.' : null;
}

export function checkName(raw) {
  const value = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (value === '') return { error: 'Bitte einen Namen eingeben.' };
  if (value.length > NAME_MAX_LENGTH) return { error: `Höchstens ${NAME_MAX_LENGTH} Zeichen.` };
  return { value };
}

function validateKeys(input, keys) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const value = {};
  const errors = {};
  for (const key of keys) {
    const result = key === 'name' ? checkName(source[key]) : checkNumber(key, source[key]);
    if ('error' in result) errors[key] = result.error;
    else value[key] = result.value;
  }
  return Object.keys(errors).length > 0 ? { errors } : { value };
}

/** `{ value }` with normalized values, or `{ errors: { field: message } }`. */
export const validatePrinter = (input) => validateKeys(input, PRINTER_KEYS);
export const validateMaterial = (input) => validateKeys(input, MATERIAL_KEYS);
export function validateGeneral(input) {
  const result = validateKeys(input, GENERAL_KEYS);
  if (result.errors) return result;
  const plateError = checkPlateMinutes(result.value.plateMinutesMin, result.value.plateMinutesMax);
  return plateError ? { errors: { plateMinutesMax: plateError } } : result;
}

/** Quantity of the current job: identical pieces and the build plates they need. */
export function validateJob(input) {
  const result = validateKeys(input, ['objectCount', 'plateCount']);
  if (result.errors) return result;
  if (result.value.plateCount > result.value.objectCount) {
    return { errors: { plateCount: 'Höchstens so viele Platten wie Stücke.' } };
  }
  return result;
}

/** Per-print values that are remembered: selected printer/material, layer height, infill, support. */
export function validateLastPrint(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const numbers = validateKeys(source, LAST_PRINT_NUMBER_KEYS);
  const errors = { ...numbers.errors };
  const printerId = checkOptionalId(source.printerId);
  const materialId = checkOptionalId(source.materialId);
  if (printerId === undefined) errors.printerId = 'Ungültige Auswahl.';
  if (materialId === undefined) errors.materialId = 'Ungültige Auswahl.';
  if (typeof source.support !== 'boolean') errors.support = 'Muss an oder aus sein.';
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { printerId, materialId, ...numbers.value, support: source.support } };
}

function checkOptionalId(raw) {
  if (raw === null || raw === undefined) return null;
  return isValidId(raw) ? raw : undefined;
}

/** Joins field errors into one readable sentence: "Leistung: Muss größer als 0 W sein. …" */
export function describeErrors(errors) {
  return Object.entries(errors)
    .map(([key, message]) => `${fieldLabel(key)}: ${message}`)
    .join(' ');
}

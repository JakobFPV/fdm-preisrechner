// Validation rules, shared by the browser (instant feedback) and the server (authoritative check).
// Every function takes the language of its messages as the last argument ('de' or 'en', default 'de').

import { formatCompact, parseDecimal } from './format.js';
import { LANGUAGES, t, tn } from './i18n.js';

export const NAME_MAX_LENGTH = 60;

/** Numeric fields with unit and allowed range. Labels come from the dictionary ("field.<key>"). */
export const NUMBER_FIELDS = {
  powerW: { unit: 'W', min: 0, exclusiveMin: true, max: 5000 },
  throughputCm3PerH: { unit: 'cm³/h', min: 0, exclusiveMin: true, max: 1000 },
  wearPerHour: { unit: '€/h', min: 0, max: 100 },
  pricePerKg: { unit: '€/kg', min: 0, max: 10000 },
  densityGPerCm3: { unit: 'g/cm³', min: 0, exclusiveMin: true, max: 25 },
  electricityPricePerKwh: { unit: '€/kWh', min: 0, max: 10 },
  wagePerHour: { unit: '€/h', min: 0, max: 1000 },
  shippingMinutes: { unit: 'min', min: 0, max: 240 },
  plateMinutesMin: { unit: 'min', min: 0, max: 240 },
  plateMinutesMax: { unit: 'min', min: 0, max: 240 },
  fullPlateVolumeCm3: { unit: 'cm³', min: 0, exclusiveMin: true, max: 100000 },
  profitMarginPercent: { unit: '%', min: 0, max: 10000 },
  supportSurchargePercent: { unit: '%', min: 0, max: 1000 },
  wallThicknessMm: { unit: 'mm', min: 0, max: 50 },
  layerHeightMm: { unit: 'mm', min: 0.01, max: 2 },
  infillPercent: { unit: '%', min: 0, max: 100 },
  objectCount: { unitKey: 'unit.pieces', min: 1, max: 10000, integer: true },
  plateCount: { unitKey: 'unit.plates', min: 1, max: 1000, integer: true },
};

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

/** "0,01 mm", "1 Stück", "20 %" (de) / "0.01 mm", "1 piece", "20%" (en) */
function withUnit(value, spec, lang) {
  const number = formatCompact(value, 4, lang);
  if (spec.unitKey) return `${number} ${tn(lang, spec.unitKey, value)}`;
  if (spec.unit === '%' && lang === 'en') return `${number}%`;
  // English puts the euro sign in front: "€0.25/h" instead of "0.25 €/h"
  if (spec.unit.startsWith('€/') && lang === 'en') return `€${number}${spec.unit.slice(1)}`;
  return `${number} ${spec.unit}`;
}

export function fieldLabel(key, lang = 'de') {
  return t(lang, `field.${key}`);
}

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** Checks one numeric field. Returns `{ value }` or `{ error }`. Accepts numbers and typed strings ("0,2"). */
export function checkNumber(key, raw, lang = 'de') {
  const spec = NUMBER_FIELDS[key];
  const value = parseDecimal(raw, lang);
  if (!Number.isFinite(value)) return { error: t(lang, 'error.number') };
  if (spec.exclusiveMin ? value <= spec.min : value < spec.min) {
    return {
      error: t(lang, spec.exclusiveMin ? 'error.greaterThan' : 'error.min', { value: withUnit(spec.min, spec, lang) }),
    };
  }
  if (value > spec.max) return { error: t(lang, 'error.max', { value: withUnit(spec.max, spec, lang) }) };
  if (spec.integer && !Number.isInteger(value)) return { error: t(lang, 'error.integer') };
  return { value };
}

/** Cross-field rule for the labour per plate. Returns a message or null. */
export function checkPlateMinutes(min, max, lang = 'de') {
  return min > max ? t(lang, 'error.plateMinutes') : null;
}

export function checkName(raw, lang = 'de') {
  const value = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (value === '') return { error: t(lang, 'error.nameRequired') };
  if (value.length > NAME_MAX_LENGTH) return { error: t(lang, 'error.nameTooLong', { max: NAME_MAX_LENGTH }) };
  return { value };
}

function validateKeys(input, keys, lang) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const value = {};
  const errors = {};
  for (const key of keys) {
    const result = key === 'name' ? checkName(source[key], lang) : checkNumber(key, source[key], lang);
    if ('error' in result) errors[key] = result.error;
    else value[key] = result.value;
  }
  return Object.keys(errors).length > 0 ? { errors } : { value };
}

/** `{ value }` with normalized values, or `{ errors: { field: message } }`. */
export const validatePrinter = (input, lang = 'de') => validateKeys(input, PRINTER_KEYS, lang);
export const validateMaterial = (input, lang = 'de') => validateKeys(input, MATERIAL_KEYS, lang);

export function validateGeneral(input, lang = 'de') {
  const result = validateKeys(input, GENERAL_KEYS, lang);
  if (result.errors) return result;
  const plateError = checkPlateMinutes(result.value.plateMinutesMin, result.value.plateMinutesMax, lang);
  return plateError ? { errors: { plateMinutesMax: plateError } } : result;
}

/** Quantity of the current job: identical pieces and the build plates they need. */
export function validateJob(input, lang = 'de') {
  const result = validateKeys(input, ['objectCount', 'plateCount'], lang);
  if (result.errors) return result;
  if (result.value.plateCount > result.value.objectCount) {
    return { errors: { plateCount: t(lang, 'error.platesAbovePieces') } };
  }
  return result;
}

/** Per-print values that are remembered: selected printer/material, layer height, infill, support. */
export function validateLastPrint(input, lang = 'de') {
  const source = input !== null && typeof input === 'object' ? input : {};
  const numbers = validateKeys(source, LAST_PRINT_NUMBER_KEYS, lang);
  const errors = { ...numbers.errors };
  const printerId = checkOptionalId(source.printerId);
  const materialId = checkOptionalId(source.materialId);
  if (printerId === undefined) errors.printerId = t(lang, 'error.invalidChoice');
  if (materialId === undefined) errors.materialId = t(lang, 'error.invalidChoice');
  if (typeof source.support !== 'boolean') errors.support = t(lang, 'error.onOff');
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { printerId, materialId, ...numbers.value, support: source.support } };
}

/** The interface language: 'de' or 'en'. */
export function validateLanguage(input, lang = 'de') {
  return LANGUAGES.includes(input) ? { value: input } : { errors: { language: t(lang, 'error.language') } };
}

function checkOptionalId(raw) {
  if (raw === null || raw === undefined) return null;
  return isValidId(raw) ? raw : undefined;
}

/** Joins field errors into one readable sentence: "Leistung: Muss größer als 0 W sein. …" */
export function describeErrors(errors, lang = 'de') {
  return Object.entries(errors)
    .map(([key, message]) => `${fieldLabel(key, lang)}: ${message}`)
    .join(' ');
}

// Number, money and duration formatting for the user interface, in German or English.
// `lang` is 'de' or 'en' (default 'de').

import { LOCALES } from './i18n.js';

const formats = new Map();

function cached(key, create) {
  let format = formats.get(key);
  if (!format) {
    format = create();
    formats.set(key, format);
  }
  return format;
}

const localeOf = (lang) => LOCALES[lang] ?? LOCALES.de;

function numberFormat(lang, minDigits, maxDigits, useGrouping = true) {
  const locale = localeOf(lang);
  return cached(`n|${locale}|${minDigits}|${maxDigits}|${useGrouping}`, () => new Intl.NumberFormat(locale, {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
    useGrouping,
  }));
}

function euroFormat(lang, digits = 2) {
  const locale = localeOf(lang);
  return cached(`e|${locale}|${digits}`, () => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }));
}

/** Fixed number of decimals: 1234.5 → "1.234,50" (de) / "1,234.50" (en). */
export function formatNumber(value, digits = 2, lang = 'de') {
  return numberFormat(lang, digits, digits).format(value);
}

/** Up to `maxDigits` decimals without trailing zeros: 0.20 → "0,2" / "0.2". */
export function formatCompact(value, maxDigits = 2, lang = 'de') {
  return numberFormat(lang, 0, maxDigits).format(value);
}

/** Value for an input field: no thousands separators, up to 4 decimals. */
export function formatInputNumber(value, lang = 'de') {
  return Number.isFinite(value) ? numberFormat(lang, 0, 4, false).format(value) : '';
}

/** Euro amount from whole cents: 1234 → "12,34 €" / "€12.34". */
export function formatEuroCents(cents, lang = 'de') {
  return euroFormat(lang).format(cents / 100);
}

/** Euro amount: 0.35 → "0,35 €" / "€0.35". */
export function formatEuro(euros, lang = 'de') {
  return euroFormat(lang).format(euros);
}

/**
 * Euro amount with four decimals, for the calculation steps: 0.07023 → "0,0702 €".
 * `truncate` cuts instead of rounding, so a value just below half a cent (1.30496)
 * never shows as "1,3050 €" next to the rounded price "1,30 €".
 */
export function formatEuroPrecise(euros, { truncate = false, lang = 'de' } = {}) {
  const value = truncate ? Math.floor(Number((euros * 1e4).toPrecision(12))) / 1e4 : euros;
  return euroFormat(lang, 4).format(value);
}

/** Duration in hours → "2 h 05 min", "45 min" or "< 1 min". */
export function formatDuration(hours, lang = 'de') {
  if (!Number.isFinite(hours)) return '–';
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 1) return '< 1 min';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return `${numberFormat(lang, 0, 0).format(h)} h ${String(m).padStart(2, '0')} min`;
}

/**
 * Parses a typed number. Numbers are passed through unchanged; anything unreadable gives NaN.
 *   de: "0,2", "0.2", " 24,99 ", "1.234,5"
 *   en: "0.2", "0,2", "1,234.5", "1,000"
 */
export function parseDecimal(input, lang = 'de') {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return Number.NaN;
  let text = input.replace(/[\s  ]/g, '');
  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (lang === 'en') {
    if (hasComma && hasDot) {
      text = text.replace(/,/g, ''); // "1,234.5"
    } else if (/^[+-]?[1-9]\d{0,2}(,\d{3})+$/.test(text)) {
      text = text.replace(/,/g, ''); // "1,000"
    } else {
      text = text.replace(',', '.'); // "0,2" typed with a decimal comma
    }
  } else if (hasComma && hasDot) {
    text = text.replace(/\./g, '').replace(',', '.'); // "1.234,5"
  } else {
    text = text.replace(',', '.');
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return Number.NaN;
  return Number(text);
}

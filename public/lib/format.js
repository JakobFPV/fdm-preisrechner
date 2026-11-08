// Formatting and parsing helpers for the German user interface.

const LOCALE = 'de-DE';
const numberFormats = new Map();

function numberFormat(minDigits, maxDigits, useGrouping = true) {
  const key = `${minDigits}|${maxDigits}|${useGrouping}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
      useGrouping,
    });
    numberFormats.set(key, format);
  }
  return format;
}

const euroFormat = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR' });

/** Fixed number of decimals with German separators: 1234.5 → "1.234,50". */
export function formatNumber(value, digits = 2) {
  return numberFormat(digits, digits).format(value);
}

/** Up to `maxDigits` decimals without trailing zeros: 0.20 → "0,2". */
export function formatCompact(value, maxDigits = 2) {
  return numberFormat(0, maxDigits).format(value);
}

/** Value for an input field: no thousands separators, up to 4 decimals. */
export function formatInputNumber(value) {
  return Number.isFinite(value) ? numberFormat(0, 4, false).format(value) : '';
}

/** Euro amount from whole cents: 1234 → "12,34 €". */
export function formatEuroCents(cents) {
  return euroFormat.format(cents / 100);
}

/** Euro amount: 0.35 → "0,35 €". */
export function formatEuro(euros) {
  return euroFormat.format(euros);
}

const preciseEuroFormat = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * Euro amount with four decimals, for the calculation steps: 0.07023 → "0,0702 €".
 * `truncate` cuts instead of rounding, so a value just below half a cent (1.30496)
 * never shows as "1,3050 €" next to the rounded price "1,30 €".
 */
export function formatEuroPrecise(euros, { truncate = false } = {}) {
  const value = truncate ? Math.floor(Number((euros * 1e4).toPrecision(12))) / 1e4 : euros;
  return preciseEuroFormat.format(value);
}

/** Duration in hours → "2 h 05 min", "45 min" or "< 1 min". */
export function formatDuration(hours) {
  if (!Number.isFinite(hours)) return '–';
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 1) return '< 1 min';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return `${numberFormat(0, 0).format(h)} h ${String(m).padStart(2, '0')} min`;
}

/**
 * Parses a number typed with a decimal comma or point:
 * "0,2", "0.2", " 24,99 ", "1.234,5" → number. Anything else → NaN.
 * Numbers are passed through unchanged.
 */
export function parseDecimal(input) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return Number.NaN;
  let text = input.replace(/[\s  ]/g, '');
  if (text.includes(',') && text.includes('.')) {
    // German notation with thousands separators: "1.234,5"
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(',', '.');
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return Number.NaN;
  return Number(text);
}

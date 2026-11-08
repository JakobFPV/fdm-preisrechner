// Durable storage for the settings: plain JSON files in the data directory.
//   settings.json    long-term settings (language, printers, materials, costs, labour rules)
//   last-print.json  last used per-print values (printer, material, layer height, infill, support)
// Files are written atomically (temp file + rename), so a crash never leaves half a file behind.
// Methods take the language of their error messages as the last argument ('de' or 'en').

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRINTER_NAMES, DEFAULT_WEAR_PER_HOUR, defaultLastPrint, defaultSettings } from './defaults.js';
import { normalizeLanguage, t } from '../public/lib/i18n.js';
import {
  GENERAL_KEYS,
  describeErrors,
  isValidId,
  validateGeneral,
  validateLanguage,
  validateLastPrint,
  validateMaterial,
  validatePrinter,
} from '../public/lib/validate.js';

export class StoreError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.errors = errors;
  }
}

const KINDS = {
  printers: { validate: validatePrinter, lastPrintKey: 'printerId' },
  materials: { validate: validateMaterial, lastPrintKey: 'materialId' },
};

/**
 * @param {string} dataDir
 * @param {{logLanguage?: 'de'|'en'}} [options] language of console messages
 */
export function createStore(dataDir, { logLanguage = 'de' } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  const lastPrintFile = path.join(dataDir, 'last-print.json');
  const warnings = []; // { code, params } – translated by the interface

  let settings = loadFile(settingsFile, parseSettingsFile, defaultSettings, warnings, logLanguage);
  let lastPrint = loadFile(lastPrintFile, parseLastPrintFile, () => defaultLastPrint(settings), warnings, logLanguage);

  function saveSettings(next) {
    writeJsonAtomic(settingsFile, next);
    settings = next;
  }

  function saveLastPrint(next) {
    writeJsonAtomic(lastPrintFile, next);
    lastPrint = next;
  }

  /** The stored selection, falling back to the first printer/material if the stored one is gone. */
  function effectiveLastPrint() {
    const pick = (list, id) => (list.some((item) => item.id === id) ? id : (list[0]?.id ?? null));
    return {
      ...lastPrint,
      printerId: pick(settings.printers, lastPrint.printerId),
      materialId: pick(settings.materials, lastPrint.materialId),
    };
  }

  function kindOf(kind, lang) {
    const config = KINDS[kind];
    if (!config) throw new StoreError(404, t(lang, 'store.unknownKind'));
    return config;
  }

  function validated(config, input, lang) {
    const result = config.validate(input, lang);
    if (result.errors) throw new StoreError(400, describeErrors(result.errors, lang), result.errors);
    return result.value;
  }

  function assertUniqueName(kind, name, lang, exceptId = null) {
    const wanted = name.toLocaleLowerCase();
    const clash = settings[kind].some((item) => item.id !== exceptId && item.name.toLocaleLowerCase() === wanted);
    if (clash) {
      const message = t(lang, `store.duplicate.${kind}`);
      throw new StoreError(409, message, { name: message });
    }
  }

  return {
    paths: { settings: settingsFile, lastPrint: lastPrintFile },

    /** Chosen interface language, or null if none was chosen yet (the browser's language is used). */
    language() {
      return settings.language;
    },

    getState() {
      return {
        settings: structuredClone(settings),
        lastPrint: effectiveLastPrint(),
        warnings: structuredClone(warnings),
        storage: { dataDir, settingsFile, lastPrintFile },
      };
    },

    updateGeneral(input, lang = 'de') {
      const result = validateGeneral(input, lang);
      if (result.errors) throw new StoreError(400, describeErrors(result.errors, lang), result.errors);
      saveSettings({ ...settings, ...result.value });
      return structuredClone(settings);
    },

    /** Switches the interface language. The untouched example printer is renamed to match. */
    setLanguage(input, lang = 'de') {
      const result = validateLanguage(input, lang);
      if (result.errors) throw new StoreError(400, describeErrors(result.errors, lang), result.errors);
      const language = result.value;
      const exampleNames = Object.values(DEFAULT_PRINTER_NAMES);
      const target = DEFAULT_PRINTER_NAMES[language];
      const printers = settings.printers.map((printer) => {
        const isExample = exampleNames.includes(printer.name) && printer.name !== target;
        const taken = settings.printers.some((other) => other !== printer && other.name === target);
        return isExample && !taken ? { ...printer, name: target } : printer;
      });
      saveSettings({ ...settings, language, printers });
      return structuredClone(settings);
    },

    addItem(kind, input, lang = 'de') {
      const config = kindOf(kind, lang);
      const value = validated(config, input, lang);
      assertUniqueName(kind, value.name, lang);
      const item = { id: crypto.randomUUID(), ...value };
      saveSettings({ ...settings, [kind]: [...settings[kind], item] });
      return { settings: structuredClone(settings), item: { ...item } };
    },

    updateItem(kind, id, input, lang = 'de') {
      const config = kindOf(kind, lang);
      const index = settings[kind].findIndex((item) => item.id === id);
      if (index === -1) throw new StoreError(404, t(lang, `store.notFound.${kind}`));
      const value = validated(config, input, lang);
      assertUniqueName(kind, value.name, lang, id);
      const item = { id, ...value };
      const list = [...settings[kind]];
      list[index] = item;
      saveSettings({ ...settings, [kind]: list });
      return { settings: structuredClone(settings), item: { ...item } };
    },

    deleteItem(kind, id, lang = 'de') {
      const config = kindOf(kind, lang);
      const list = settings[kind];
      if (!list.some((item) => item.id === id)) throw new StoreError(404, t(lang, `store.notFound.${kind}`));
      if (list.length <= 1) throw new StoreError(409, t(lang, `store.lastOne.${kind}`));
      saveSettings({ ...settings, [kind]: list.filter((item) => item.id !== id) });
      if (lastPrint[config.lastPrintKey] === id) saveLastPrint(effectiveLastPrint());
      return { settings: structuredClone(settings), lastPrint: effectiveLastPrint() };
    },

    setLastPrint(input, lang = 'de') {
      const result = validateLastPrint(input, lang);
      if (result.errors) throw new StoreError(400, describeErrors(result.errors, lang), result.errors);
      saveLastPrint(result.value);
      return effectiveLastPrint();
    },
  };
}

// ---------------------------------------------------------------------------
// Reading files

/**
 * Loads a JSON file. A missing file is created with defaults. A broken file is kept as
 * "<name>.broken-<time>" (never overwritten) and replaced by defaults, with a warning for the UI.
 */
function loadFile(file, parse, makeDefault, warnings, logLanguage) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = makeDefault();
    writeJsonAtomic(file, value);
    return value;
  }

  try {
    const { value, changed } = parse(JSON.parse(text), logLanguage);
    if (changed) writeJsonAtomic(file, value);
    return value;
  } catch (error) {
    const backup = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, backup);
    const value = makeDefault();
    writeJsonAtomic(file, value);
    const warning = {
      code: 'warning.brokenFile',
      params: { file: path.basename(file), backup: path.basename(backup), reason: error.message },
    };
    warnings.push(warning);
    console.warn(t(logLanguage, warning.code, warning.params));
    return value;
  }
}

function parseSettingsFile(data, lang) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  const defaults = defaultSettings();
  let changed = false;

  // Files from before the language switch were used with the German interface.
  let language = data.language === undefined ? 'de' : data.language;
  if (language !== null && !normalizeLanguage(language)) language = null;
  if (language !== data.language) changed = true;

  // Values added in later versions may be missing in older files: fill them in.
  const generalInput = {};
  for (const key of GENERAL_KEYS) {
    if (data[key] === undefined) {
      generalInput[key] = defaults[key];
      changed = true;
    } else {
      generalInput[key] = data[key];
    }
  }
  const general = validateGeneral(generalInput, lang);
  if (general.errors) throw new Error(describeErrors(general.errors, lang));

  // Printers saved before wear costs existed get the default wear cost.
  const printers = parseItems(data.printers, validatePrinter, 'printers', lang, { wearPerHour: DEFAULT_WEAR_PER_HOUR });
  const materials = parseItems(data.materials, validateMaterial, 'materials', lang);
  changed ||= printers.changed || materials.changed;

  return {
    value: { version: 1, language, ...general.value, printers: printers.items, materials: materials.items },
    changed,
  };
}

function parseItems(list, validate, key, lang, fillMissing = {}) {
  if (!Array.isArray(list)) throw new Error(`"${key}" is missing or not a list`);
  const ids = new Set();
  let changed = false;
  const items = list.map((original, index) => {
    let entry = original;
    for (const [field, value] of Object.entries(fillMissing)) {
      if (entry !== null && typeof entry === 'object' && entry[field] === undefined) {
        entry = { ...entry, [field]: value };
        changed = true;
      }
    }
    const result = validate(entry, lang);
    if (result.errors) throw new Error(`${key}[${index}]: ${describeErrors(result.errors, lang)}`);
    let id = entry.id;
    if (!isValidId(id) || ids.has(id)) {
      id = crypto.randomUUID(); // hand-edited entry without (unique) id
      changed = true;
    }
    ids.add(id);
    return { id, ...result.value };
  });
  return { items, changed };
}

function parseLastPrintFile(data, lang) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  const defaults = defaultLastPrint({ printers: [], materials: [] });
  const result = validateLastPrint({ ...defaults, ...data }, lang);
  if (result.errors) throw new Error(describeErrors(result.errors, lang));
  return { value: result.value, changed: false };
}

// ---------------------------------------------------------------------------
// Writing files

function writeJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

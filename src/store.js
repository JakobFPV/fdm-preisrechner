// Durable storage for the settings: plain JSON files in the data directory.
//   settings.json    long-term settings (printers, materials, costs)
//   last-print.json  last used per-print values (printer, material, layer height, infill, support)
// Files are written atomically (temp file + rename), so a crash never leaves half a file behind.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WEAR_PER_HOUR, defaultLastPrint, defaultSettings } from './defaults.js';
import {
  GENERAL_KEYS,
  describeErrors,
  isValidId,
  validateGeneral,
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
  printers: {
    validate: validatePrinter,
    lastPrintKey: 'printerId',
    notFound: 'Dieser Drucker existiert nicht (mehr).',
    duplicate: 'Es gibt bereits einen Drucker mit diesem Namen.',
    lastOne: 'Der letzte Drucker kann nicht gelöscht werden. Lege zuerst einen weiteren an.',
  },
  materials: {
    validate: validateMaterial,
    lastPrintKey: 'materialId',
    notFound: 'Dieses Material existiert nicht (mehr).',
    duplicate: 'Es gibt bereits ein Material mit diesem Namen.',
    lastOne: 'Das letzte Material kann nicht gelöscht werden. Lege zuerst ein weiteres an.',
  },
};

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  const lastPrintFile = path.join(dataDir, 'last-print.json');
  const warnings = [];

  let settings = loadFile(settingsFile, parseSettingsFile, defaultSettings, warnings);
  let lastPrint = loadFile(lastPrintFile, parseLastPrintFile, () => defaultLastPrint(settings), warnings);

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

  function kindOf(kind) {
    const config = KINDS[kind];
    if (!config) throw new StoreError(404, 'Unbekannte Art von Eintrag.');
    return config;
  }

  function validated(config, input) {
    const result = config.validate(input);
    if (result.errors) throw new StoreError(400, describeErrors(result.errors), result.errors);
    return result.value;
  }

  function assertUniqueName(kind, name, exceptId = null) {
    const wanted = name.toLocaleLowerCase('de-DE');
    const clash = settings[kind].some(
      (item) => item.id !== exceptId && item.name.toLocaleLowerCase('de-DE') === wanted,
    );
    if (clash) {
      const message = KINDS[kind].duplicate;
      throw new StoreError(409, message, { name: message });
    }
  }

  return {
    paths: { settings: settingsFile, lastPrint: lastPrintFile },

    getState() {
      return {
        settings: structuredClone(settings),
        lastPrint: effectiveLastPrint(),
        warnings: [...warnings],
        storage: { dataDir, settingsFile, lastPrintFile },
      };
    },

    updateGeneral(input) {
      const result = validateGeneral(input);
      if (result.errors) throw new StoreError(400, describeErrors(result.errors), result.errors);
      saveSettings({ ...settings, ...result.value });
      return structuredClone(settings);
    },

    addItem(kind, input) {
      const config = kindOf(kind);
      const value = validated(config, input);
      assertUniqueName(kind, value.name);
      const item = { id: crypto.randomUUID(), ...value };
      saveSettings({ ...settings, [kind]: [...settings[kind], item] });
      return { settings: structuredClone(settings), item: { ...item } };
    },

    updateItem(kind, id, input) {
      const config = kindOf(kind);
      const index = settings[kind].findIndex((item) => item.id === id);
      if (index === -1) throw new StoreError(404, config.notFound);
      const value = validated(config, input);
      assertUniqueName(kind, value.name, id);
      const item = { id, ...value };
      const list = [...settings[kind]];
      list[index] = item;
      saveSettings({ ...settings, [kind]: list });
      return { settings: structuredClone(settings), item: { ...item } };
    },

    deleteItem(kind, id) {
      const config = kindOf(kind);
      const list = settings[kind];
      if (!list.some((item) => item.id === id)) throw new StoreError(404, config.notFound);
      if (list.length <= 1) throw new StoreError(409, config.lastOne);
      saveSettings({ ...settings, [kind]: list.filter((item) => item.id !== id) });
      if (lastPrint[config.lastPrintKey] === id) saveLastPrint(effectiveLastPrint());
      return { settings: structuredClone(settings), lastPrint: effectiveLastPrint() };
    },

    setLastPrint(input) {
      const result = validateLastPrint(input);
      if (result.errors) throw new StoreError(400, describeErrors(result.errors), result.errors);
      saveLastPrint(result.value);
      return effectiveLastPrint();
    },
  };
}

// ---------------------------------------------------------------------------
// Reading files

/**
 * Loads a JSON file. A missing file is created with defaults. A broken file is kept as
 * "<name>.defekt-<time>" (never overwritten) and replaced by defaults, with a warning for the UI.
 */
function loadFile(file, parse, makeDefault, warnings) {
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
    const { value, changed } = parse(JSON.parse(text));
    if (changed) writeJsonAtomic(file, value);
    return value;
  } catch (error) {
    const backup = `${file}.defekt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, backup);
    const value = makeDefault();
    writeJsonAtomic(file, value);
    const message =
      `Die Datei „${path.basename(file)}“ war beschädigt (${error.message}) und wurde als ` +
      `„${path.basename(backup)}“ gesichert. Es gelten wieder die Standardwerte.`;
    warnings.push(message);
    console.warn(message);
    return value;
  }
}

function parseSettingsFile(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein JSON-Objekt');
  const defaults = defaultSettings();
  let changed = false;

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
  const general = validateGeneral(generalInput);
  if (general.errors) throw new Error(describeErrors(general.errors));

  // Printers saved before wear costs existed get the default wear cost.
  const printers = parseItems(data.printers, validatePrinter, 'printers', { wearPerHour: DEFAULT_WEAR_PER_HOUR });
  const materials = parseItems(data.materials, validateMaterial, 'materials');
  changed ||= printers.changed || materials.changed;

  return {
    value: { version: 1, ...general.value, printers: printers.items, materials: materials.items },
    changed,
  };
}

function parseItems(list, validate, key, fillMissing = {}) {
  if (!Array.isArray(list)) throw new Error(`„${key}“ fehlt oder ist keine Liste`);
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
    const result = validate(entry);
    if (result.errors) throw new Error(`${key}[${index}]: ${describeErrors(result.errors)}`);
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

function parseLastPrintFile(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein JSON-Objekt');
  const defaults = defaultLastPrint({ printers: [], materials: [] });
  const result = validateLastPrint({ ...defaults, ...data });
  if (result.errors) throw new Error(describeErrors(result.errors));
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

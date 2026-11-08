// Browser logic of the FDM price calculator:
// model upload, per-print controls, long-term settings (stored by the local server), the live price
// and the German/English language switch (texts in lib/i18n.js).

import { calculatePrice, REFERENCE_LAYER_HEIGHT_MM } from './lib/calc.js';
import { analyzeModelFile, checkModelFileName, MAX_FILE_BYTES, ModelError } from './lib/mesh.js';
import { detectLanguage, normalizeLanguage, t, tn } from './lib/i18n.js';
import {
  checkNumber,
  checkPlateMinutes,
  GENERAL_KEYS,
  validateJob,
  validateMaterial,
  validatePrinter,
} from './lib/validate.js';
import {
  formatCompact,
  formatDuration,
  formatEuro,
  formatEuroCents,
  formatEuroPrecise,
  formatInputNumber,
  formatNumber,
} from './lib/format.js';

// The module loaded, so the hint for a missing server is not needed.
document.getElementById('boot-message')?.remove();

const $ = (id) => document.getElementById(id);

const state = {
  lang: detectLanguage(navigator.languages ?? [navigator.language]), // replaced by the stored choice
  settings: null, // long-term settings from data/settings.json
  lastPrint: null, // per-print values from data/last-print.json
  storage: null, // file locations, shown in the settings panel
  warnings: [], // { code, params } from loading the settings files
  model: null, // { fileName, info }
  modelError: null, // { fileName, code, params } or { fileName, unexpected }
  modelLoading: null, // file name while reading
  job: { objectCount: 1, plateCount: 1 }, // quantity of the current model (not stored, reset per model)
};

const ui = {
  editing: { printers: null, materials: null }, // item id, 'new' or null
  confirmDelete: { printers: null, materials: null }, // item id or null
};

// ---------------------------------------------------------------------------
// Language helpers: everything visible goes through these.

const tr = (key, params) => t(state.lang, key, params);
const trn = (key, count, params) => tn(state.lang, key, count, params);
const num = (value, digits = 2) => formatNumber(value, digits, state.lang);
const compact = (value, digits = 2) => formatCompact(value, digits, state.lang);
const euro = (euros) => formatEuro(euros, state.lang);
const euroCents = (cents) => formatEuroCents(cents, state.lang);
const euroPrecise = (euros, truncate = false) => formatEuroPrecise(euros, { truncate, lang: state.lang });
const duration = (hours) => formatDuration(hours, state.lang);
const inputNumber = (value) => formatInputNumber(value, state.lang);

const ITEM_KINDS = {
  printers: {
    listId: 'printer-list',
    addButtonId: 'add-printer',
    kindKey: 'kind.printer',
    newKey: 'printer.new',
    lastOneKey: 'printer.lastOne',
    lastPrintKey: 'printerId',
    validate: validatePrinter,
    fields: [
      { key: 'name', placeholderKey: 'placeholder.printerName' },
      { key: 'powerW', unit: 'W', placeholderKey: 'placeholder.power' },
      { key: 'throughputCm3PerH', unit: 'cm³/h', placeholderKey: 'placeholder.throughput' },
      // Prefilled for new printers: most people keep the default wear cost.
      { key: 'wearPerHour', unit: '€/h', placeholderKey: 'placeholder.wear', defaultValue: 0.25 },
    ],
    summary: (p) => tr('printer.summary', {
      power: compact(p.powerW, 1),
      throughput: compact(p.throughputCm3PerH, 2),
      wear: euro(p.wearPerHour),
    }),
  },
  materials: {
    listId: 'material-list',
    addButtonId: 'add-material',
    kindKey: 'kind.material',
    newKey: 'material.new',
    lastOneKey: 'material.lastOne',
    lastPrintKey: 'materialId',
    validate: validateMaterial,
    fields: [
      { key: 'name', placeholderKey: 'placeholder.materialName' },
      { key: 'pricePerKg', unit: '€/kg', placeholderKey: 'placeholder.price' },
      { key: 'densityGPerCm3', unit: 'g/cm³', placeholderKey: 'placeholder.density' },
    ],
    summary: (m) => tr('material.summary', { price: euro(m.pricePerKg), density: compact(m.densityGPerCm3, 3) }),
  },
};

// Arrow-key steps for numeric inputs.
const STEPS = {
  layerHeightMm: 0.02,
  infillPercent: 5,
  objectCount: 1,
  plateCount: 1,
  electricityPricePerKwh: 0.01,
  wagePerHour: 0.5,
  profitMarginPercent: 5,
  supportSurchargePercent: 5,
  wallThicknessMm: 0.1,
  shippingMinutes: 1,
  plateMinutesMin: 1,
  plateMinutesMax: 1,
  fullPlateVolumeCm3: 50,
};

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
};

// ---------------------------------------------------------------------------
// Server API

class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

async function api(method, url, body, { keepalive = false } = {}) {
  const headers = { 'Accept-Language': state.lang }; // server messages in the interface language
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
    });
  } catch {
    throw new ApiError(tr('error.serverUnreachable'), 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // no JSON body
  }
  if (!response.ok) {
    throw new ApiError(data?.error ?? tr('error.http', { status: String(response.status) }), response.status, data?.errors);
  }
  return data;
}

/** Saves after a short pause (typing, dragging); flushed before other writes and when leaving the page. */
function createSaver(save, delay) {
  let timer = null;
  let chain = Promise.resolve();
  const run = () => {
    clearTimeout(timer);
    timer = null;
    chain = chain.then(() => save())
      .catch((error) => showToast(tr('toast.saveFailed', { message: error.message }), 'error'));
    return chain;
  };
  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    flush() {
      return timer === null ? chain : run();
    },
    flushOnExit() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      save({ keepalive: true }).catch(() => {});
    },
  };
}

const lastPrintSaver = createSaver(
  (options) => api('PUT', '/api/last-print', state.lastPrint, options),
  250,
);

const generalSaver = createSaver(async (options) => {
  const values = Object.fromEntries(GENERAL_KEYS.map((key) => [key, state.settings[key]]));
  await api('PUT', '/api/settings/general', values, options);
  flashSaved();
}, 500);

const flushSaves = () => Promise.all([lastPrintSaver.flush(), generalSaver.flush()]);

// ---------------------------------------------------------------------------
// Start (init() is called at the end of this file, after all declarations)

async function init() {
  bindLanguageSwitch();
  bindModelInput();
  bindPrintControls();
  bindJobControls();
  bindGeneralForm();
  bindSettingsPanel();
  bindPageLifecycle();
  applyStaticTexts();

  let data;
  try {
    data = await api('GET', '/api/state');
  } catch (error) {
    showAppError(tr('error.loadState', { message: error.message }));
    return;
  }
  state.settings = data.settings;
  state.lastPrint = data.lastPrint;
  state.storage = data.storage;
  state.warnings = data.warnings ?? [];

  const stored = normalizeLanguage(state.settings.language);
  if (stored) {
    state.lang = stored;
  } else {
    // First start: remember the browser's language (this also names the example printer).
    try {
      state.settings = (await api('PUT', '/api/settings/language', { language: state.lang })).settings;
    } catch (error) {
      showToast(tr('toast.saveFailed', { message: error.message }), 'error');
    }
  }

  applyStaticTexts();
  $('layout').inert = false;
  document.body.classList.add('is-ready');
  renderAll();
}

function renderAll() {
  renderWarnings();
  renderSelects();
  renderPrintControls();
  renderJobControls();
  renderSettings();
  renderModel();
  renderResult();
}

// ---------------------------------------------------------------------------
// Language

function bindLanguageSwitch() {
  for (const button of document.querySelectorAll('.lang-option')) {
    button.addEventListener('click', () => switchLanguage(button.dataset.lang));
  }
}

async function switchLanguage(lang) {
  if (!normalizeLanguage(lang) || lang === state.lang || !state.settings) return;
  state.lang = lang;
  clearFieldErrors(); // they were written in the other language
  applyStaticTexts();
  renderAll();
  try {
    await flushSaves();
    const response = await api('PUT', '/api/settings/language', { language: lang });
    state.settings = response.settings; // the untouched example printer was renamed
    renderSelects();
    renderPrintControls();
    renderItemList('printers');
    renderResult();
  } catch (error) {
    showToast(tr('toast.saveFailed', { message: error.message }), 'error');
  }
}

/** Texts written in index.html: data-i18n (text), data-i18n-html (trusted markup), data-i18n-attr. */
function applyStaticTexts() {
  document.documentElement.lang = state.lang;
  document.title = tr('app.title');
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = tr(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-html]')) element.innerHTML = tr(element.dataset.i18nHtml);
  for (const element of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of element.dataset.i18nAttr.split(';')) {
      const [attribute, key] = pair.split(':');
      element.setAttribute(attribute.trim(), tr(key.trim()));
    }
  }
  for (const chip of document.querySelectorAll('#layer-chips .chip')) chip.textContent = num(Number(chip.dataset.value), 2);
  for (const button of document.querySelectorAll('.lang-option')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === state.lang));
  }
  if (state.storage) $('storage-path').textContent = state.storage.settingsFile;
}

function clearFieldErrors() {
  for (const element of document.querySelectorAll('.field-error')) element.textContent = '';
  for (const input of document.querySelectorAll('.is-invalid')) setFieldError(input, null, null);
}

// ---------------------------------------------------------------------------
// Model upload

let modelRequest = 0;

function bindModelInput() {
  const input = $('file-input');
  const dropzone = $('dropzone');
  dropzone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const [file] = input.files;
    input.value = ''; // allows choosing the same file again
    if (file) loadModel(file);
  });

  // Drops are accepted anywhere, so a missed drop never makes the browser open the file itself.
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    dropzone.classList.add('is-dragover');
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('is-dragover');
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragover');
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > 1) showToast(tr('toast.multipleFiles'));
    loadModel(files[0]);
  });
}

async function loadModel(file) {
  const request = ++modelRequest;
  state.model = null;
  state.modelError = null;
  state.modelLoading = file.name;
  renderModel();
  renderResult();

  let model = null;
  let error = null;
  try {
    checkModelFileName(file.name);
    if (file.size > MAX_FILE_BYTES) throw new ModelError('model.tooLarge', { max: MAX_FILE_BYTES / 1024 / 1024 });
    await nextPaint(); // show the loading state before the (possibly long) parsing starts
    const info = await analyzeModelFile(await file.arrayBuffer(), file.name);
    model = { fileName: file.name, info };
  } catch (caught) {
    if (caught instanceof ModelError) {
      error = { fileName: file.name, code: caught.code, params: caught.params };
    } else {
      console.error(caught);
      error = { fileName: file.name, unexpected: String(caught?.message ?? caught) };
    }
  }

  if (request !== modelRequest) return; // a newer file was chosen meanwhile
  state.model = model;
  state.modelError = error;
  if (model) {
    state.job = { objectCount: 1, plateCount: 1 }; // a new model starts a new job
    renderJobControls();
  }
  state.modelLoading = null;
  renderModel();
  renderResult();
}

function nextPaint() {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 50); // requestAnimationFrame does not run in background tabs
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });
}

function renderModel() {
  const { model, modelError, modelLoading } = state;

  $('model-loading').hidden = !modelLoading;
  $('model-loading').textContent = modelLoading ? tr('model.reading', { name: modelLoading }) : '';

  $('model-error').hidden = !modelError;
  if (modelError) {
    $('model-error').replaceChildren(
      h('strong', {}, tr('model.failed', { name: modelError.fileName })),
      modelError.code
        ? tr(modelError.code, modelError.params)
        : tr('model.unexpected', { message: modelError.unexpected }),
    );
  }

  $('dropzone').classList.toggle('is-compact', Boolean(model));
  $('dropzone-title').innerHTML = tr(model ? 'dropzone.loaded.html' : 'dropzone.empty.html');

  $('model-info').hidden = !model;
  if (!model) return;
  const { info } = model;
  $('model-name').textContent = model.fileName;
  $('model-name').title = model.fileName;
  $('model-format').textContent = tr(`format.${info.format}`);
  const { x, y, z } = info.sizeMm;
  $('model-size').textContent = `${formatLength(x)} × ${formatLength(y)} × ${formatLength(z)} mm`;
  $('model-volume').textContent = `${formatSmall(info.volumeCm3)} cm³`;
  $('model-area').textContent = `${formatSmall(info.surfaceAreaCm2)} cm²`;
  $('model-triangles').textContent = num(info.triangleCount, 0) +
    (info.objectCount > 1 ? ` · ${tr('model.objects', { count: info.objectCount })}` : '');
  $('model-warnings').replaceChildren(...info.warnings.map((warning) => h('li', {}, tr(warning.code, warning.params))));
  $('model-warnings').hidden = info.warnings.length === 0;
}

const formatLength = (mm) => num(mm, mm < 1 ? 3 : 1);
const formatSmall = (value) => num(value, value < 0.1 ? 4 : 2);

// ---------------------------------------------------------------------------
// Per-print controls

function bindPrintControls() {
  $('printer-select').addEventListener('change', (event) => updateLastPrint({ printerId: event.target.value }));
  $('material-select').addEventListener('change', (event) => updateLastPrint({ materialId: event.target.value }));
  $('support').addEventListener('change', (event) => updateLastPrint({ support: event.target.checked }));
  $('infill-range').addEventListener('input', (event) => updateLastPrint({ infillPercent: Number(event.target.value) }));
  for (const chip of document.querySelectorAll('#layer-chips .chip')) {
    chip.addEventListener('click', () => updateLastPrint({ layerHeightMm: Number(chip.dataset.value) }));
  }
  bindNumberInput($('layer-height'), 'layerHeightMm', {
    get: () => state.lastPrint?.layerHeightMm,
    set: (value) => updateLastPrint({ layerHeightMm: value }),
  });
  bindNumberInput($('infill'), 'infillPercent', {
    get: () => state.lastPrint?.infillPercent,
    set: (value) => updateLastPrint({ infillPercent: value }),
  });
}

function updateLastPrint(changes) {
  if (!state.lastPrint) return;
  Object.assign(state.lastPrint, changes);
  renderPrintControls();
  renderResult();
  lastPrintSaver.schedule();
}

function renderSelects() {
  const { printers, materials } = state.settings;
  ensureValidSelection();
  fillSelect($('printer-select'), printers, state.lastPrint.printerId);
  fillSelect($('material-select'), materials, state.lastPrint.materialId);
}

function fillSelect(select, items, selectedId) {
  select.replaceChildren(...items.map((item) => new Option(item.name, item.id, false, item.id === selectedId)));
}

/** Falls back to the first printer/material if the selected one no longer exists. */
function ensureValidSelection() {
  const changes = {};
  for (const [kind, key] of [['printers', 'printerId'], ['materials', 'materialId']]) {
    const list = state.settings[kind];
    if (!list.some((item) => item.id === state.lastPrint[key])) changes[key] = list[0]?.id ?? null;
  }
  if (Object.keys(changes).length > 0) {
    Object.assign(state.lastPrint, changes);
    lastPrintSaver.schedule();
  }
}

function renderPrintControls() {
  const print = state.lastPrint;
  setInputValue($('layer-height'), print.layerHeightMm);
  for (const chip of document.querySelectorAll('#layer-chips .chip')) {
    chip.setAttribute('aria-pressed', String(Math.abs(Number(chip.dataset.value) - print.layerHeightMm) < 1e-9));
  }
  setInputValue($('infill'), print.infillPercent);
  $('infill-range').value = String(print.infillPercent);
  $('support').checked = print.support;
  $('support-hint').textContent = tr('print.supportHint', { value: compact(state.settings.supportSurchargePercent, 2) });
  if ($('printer-select').value !== print.printerId) $('printer-select').value = print.printerId;
  if ($('material-select').value !== print.materialId) $('material-select').value = print.materialId;
  const printer = state.settings.printers.find((p) => p.id === print.printerId);
  const material = state.settings.materials.find((m) => m.id === print.materialId);
  $('printer-hint').textContent = printer ? ITEM_KINDS.printers.summary(printer) : '';
  $('material-hint').textContent = material ? ITEM_KINDS.materials.summary(material) : '';
}

// ---------------------------------------------------------------------------
// Quantity: identical pieces of the current model and the build plates they need

const JOB_KEYS = { 'object-count': 'objectCount', 'plate-count': 'plateCount' };

function bindJobControls() {
  for (const [inputId, key] of Object.entries(JOB_KEYS)) {
    bindNumberInput($(inputId), key, {
      get: () => state.job[key],
      set: (value) => updateJob(key, value),
    });
  }
  for (const button of document.querySelectorAll('.stepper-btn')) {
    button.addEventListener('click', () => {
      const key = JOB_KEYS[button.dataset.target];
      const problem = updateJob(key, state.job[key] + Number(button.dataset.delta));
      if (!problem) setFieldError($(button.dataset.target), $(`${button.dataset.target}-error`), null);
    });
  }
}

/**
 * Changes the number of pieces or plates. Fewer pieces than plates also lowers the plates.
 * Returns an error message if the new value is not possible, otherwise null.
 */
function updateJob(key, value) {
  const next = { ...state.job, [key]: value };
  if (key === 'objectCount' && next.plateCount > next.objectCount) next.plateCount = next.objectCount;
  const result = validateJob(next, state.lang);
  if (result.errors) return result.errors[key] ?? Object.values(result.errors)[0];
  state.job = result.value;
  renderJobControls();
  renderResult();
  return null;
}

function renderJobControls() {
  const { objectCount, plateCount } = state.job;
  setInputValue($('object-count'), objectCount);
  setInputValue($('plate-count'), plateCount);
  const button = (target, delta) => document.querySelector(`.stepper-btn[data-target="${target}"][data-delta="${delta}"]`);
  button('object-count', '-1').disabled = objectCount <= 1;
  button('object-count', '1').disabled = objectCount >= 10000;
  button('plate-count', '-1').disabled = plateCount <= 1;
  button('plate-count', '1').disabled = plateCount >= objectCount;
}

/** The automatic labour time: shown in step 4, with the rule when no model is loaded yet. */
function renderLabour(calc) {
  const s = state.settings;
  if (!calc) {
    $('labour-total').textContent = tr('labour.rule', {
      shipping: compact(s.shippingMinutes, 1),
      min: compact(s.plateMinutesMin, 1),
      max: compact(s.plateMinutesMax, 1),
    });
    $('labour-detail').textContent = tr('labour.ruleDetail', { volume: compact(s.fullPlateVolumeCm3, 1) });
    return;
  }
  $('labour-total').textContent = tr('labour.total', {
    shipping: compact(s.shippingMinutes, 1),
    plates: trn('plates', calc.plateCount),
    perPlate: compact(calc.plateMinutes, 1),
    total: compact(calc.labourMinutes, 1),
    cost: euroCents(calc.labourCostCents),
  });
  $('labour-detail').textContent = tr('labour.detail', {
    perPlate: compact(calc.plateMinutes, 1),
    volume: num(calc.modelVolumePerPlateCm3, 1),
    min: compact(s.plateMinutesMin, 1),
    max: compact(s.plateMinutesMax, 1),
    full: compact(s.fullPlateVolumeCm3, 1),
  });
}

// ---------------------------------------------------------------------------
// Result

function currentResult() {
  if (!state.model || !state.settings) return null;
  const printer = state.settings.printers.find((p) => p.id === state.lastPrint.printerId);
  const material = state.settings.materials.find((m) => m.id === state.lastPrint.materialId);
  if (!printer || !material) return null;
  const calc = calculatePrice({
    model: state.model.info,
    printer,
    material,
    settings: state.settings,
    print: { ...state.lastPrint, ...state.job },
  });
  return { calc, printer, material };
}

function renderResult() {
  if (!state.settings) return;
  const result = currentResult();
  const price = $('price');
  $('r-profit-label').textContent = tr('price.profit', { value: compact(state.settings.profitMarginPercent, 2) });

  if (!result) {
    price.textContent = '–';
    price.classList.add('is-empty');
    $('price-sub').textContent = tr(
      state.modelLoading ? 'price.empty.loading'
        : state.model ? 'price.empty.choose'
          : state.modelError ? 'price.empty.invalid'
            : 'price.empty.upload',
    );
    for (const id of ['r-weight', 'r-time', 'r-material', 'r-electricity', 'r-wear', 'r-labour', 'r-profit']) {
      $(id).replaceChildren('–');
    }
    $('price-each').hidden = true;
    $('explain').hidden = true;
    renderLabour(null);
    return;
  }

  const { calc, printer, material } = result;
  const print = state.lastPrint;
  const pieces = calc.objectCount;
  price.classList.remove('is-empty');
  price.textContent = euroCents(calc.priceCents);
  $('price-each').hidden = pieces === 1;
  $('price-each').textContent = tr('price.each', { count: pieces, price: euroCents(calc.pricePerObjectCents) });
  $('price-sub').textContent = [
    material.name,
    printer.name,
    `${compact(print.layerHeightMm, 3)} mm`,
    tr('summary.infill', { value: compact(print.infillPercent, 1) }),
    print.support ? tr('summary.support') : null,
    trn('summary.plates', calc.plateCount),
  ].filter(Boolean).join(' · ');

  const weightNotes = [];
  if (pieces > 1) weightNotes.push(tr('price.weightPieces', { count: pieces, weight: num(calc.weightPerObjectG, 1) }));
  if (calc.supportWeightG > 0) weightNotes.push(tr('price.weightSupport', { weight: num(calc.supportWeightG, 1) }));
  $('r-weight').replaceChildren(`${num(calc.weightG, 1)} g`, ...weightNotes.map((note) => h('span', { class: 'sub' }, note)));
  $('r-time').replaceChildren(
    duration(calc.printHours),
    calc.plateCount > 1 ? h('span', { class: 'sub' }, tr('price.timePlates', { count: calc.plateCount })) : '',
  );
  $('r-material').replaceChildren(euroCents(calc.materialCostCents));
  $('r-electricity').replaceChildren(
    euroCents(calc.electricityCostCents),
    h('span', { class: 'sub' }, `${num(calc.energyKwh, 3)} kWh`),
  );
  $('r-wear').replaceChildren(
    euroCents(calc.wearCostCents),
    h('span', { class: 'sub' }, `${num(calc.printHours, 2)} h × ${euro(printer.wearPerHour)}/h`),
  );
  $('r-labour').replaceChildren(
    euroCents(calc.labourCostCents),
    h('span', { class: 'sub' }, `${compact(calc.labourMinutes, 1)} min × ${euro(state.settings.wagePerHour)}/h`),
  );
  $('r-profit').replaceChildren(euroCents(calc.profitCents));
  renderLabour(calc);
  renderExplanation(calc, printer, material);
}

function renderExplanation(calc, printer, material) {
  const settings = state.settings;
  const print = state.lastPrint;
  const area = state.model.info.surfaceAreaCm2;
  const lines = [];

  const wallValues = { area: num(area, 2), wall: compact(settings.wallThicknessMm, 2), volume: num(calc.shellVolumeCm3, 2) };
  if (area * (settings.wallThicknessMm / 10) >= calc.volumeCm3) {
    lines.push(tr('explain.wallsSolid', wallValues));
  } else {
    lines.push(tr('explain.walls', { ...wallValues, share: num(calc.wallShare * 100, 0) }));
  }
  lines.push(tr('explain.infill', {
    inner: num(calc.innerVolumeCm3, 2),
    infill: compact(print.infillPercent, 1),
    volume: num(calc.infillVolumeCm3, 2),
  }));
  if (print.support) {
    lines.push(tr('explain.support', {
      part: num(calc.partVolumeCm3, 2),
      surcharge: compact(settings.supportSurchargePercent, 2),
      volume: num(calc.supportVolumeCm3, 2),
    }));
  }
  lines.push(tr('explain.weight', {
    volume: num(calc.materialVolumePerObjectCm3, 2),
    pieces: calc.objectCount > 1 ? tr('explain.pieces', { count: calc.objectCount }) : '',
    density: compact(material.densityGPerCm3, 3),
    weight: num(calc.weightG, 1),
  }));
  const layerNote = Math.abs(print.layerHeightMm - REFERENCE_LAYER_HEIGHT_MM) < 1e-9 ? '' : tr('explain.layerNote', {
    throughput: compact(printer.throughputCm3PerH, 2),
    layer: compact(print.layerHeightMm, 3),
    reference: compact(REFERENCE_LAYER_HEIGHT_MM, 2),
  });
  lines.push(tr('explain.time', {
    volume: num(calc.materialVolumeCm3, 2),
    throughput: num(calc.throughputCm3PerH, 1),
    note: layerNote,
    duration: duration(calc.printHours),
  }));
  lines.push(tr('explain.material', {
    weight: num(calc.weightG, 1),
    price: euro(material.pricePerKg),
    cost: euroPrecise(calc.materialCost),
  }));
  lines.push(tr('explain.electricity', {
    power: compact(printer.powerW, 1),
    hours: num(calc.printHours, 2),
    energy: num(calc.energyKwh, 3),
    price: euro(settings.electricityPricePerKwh),
    cost: euroPrecise(calc.electricityCost),
  }));
  lines.push(tr('explain.wear', {
    hours: num(calc.printHours, 2),
    rate: euro(printer.wearPerHour),
    cost: euroPrecise(calc.wearCost),
  }));
  lines.push(tr('explain.labour', {
    shipping: compact(settings.shippingMinutes, 1),
    plates: num(calc.plateCount, 0),
    perPlate: compact(calc.plateMinutes, 1),
    volume: num(calc.modelVolumePerPlateCm3, 1),
    total: compact(calc.labourMinutes, 1),
    wage: euro(settings.wagePerHour),
    cost: euroPrecise(calc.labourCost),
  }));
  const costs = [calc.materialCost, calc.electricityCost, calc.wearCost, calc.labourCost].map((value) => euroPrecise(value));
  lines.push(tr('explain.price', {
    costs: costs.join(' + '),
    margin: compact(settings.profitMarginPercent, 2),
    exact: euroPrecise(calc.price, true),
    price: euroCents(calc.priceCents),
  }));

  $('explain').hidden = false;
  $('explain-list').replaceChildren(...lines.map((line) => h('li', {}, line)));
}

// ---------------------------------------------------------------------------
// Long-term settings

function bindSettingsPanel() {
  const details = $('settings-details');
  try {
    details.open = localStorage.getItem('fdm-preisrechner.settings-open') === '1';
  } catch {
    // storage blocked – panel starts closed
  }
  details.addEventListener('toggle', () => {
    try {
      localStorage.setItem('fdm-preisrechner.settings-open', details.open ? '1' : '0');
    } catch {
      // not important
    }
  });
  $('settings-shortcut').addEventListener('click', () => {
    details.open = true;
    $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('add-printer').addEventListener('click', () => startEdit('printers', 'new'));
  $('add-material').addEventListener('click', () => startEdit('materials', 'new'));
}

function bindGeneralForm() {
  for (const key of GENERAL_KEYS) {
    bindNumberInput($(`g-${key}`), key, {
      get: () => state.settings?.[key],
      set: (value) => {
        if (!state.settings) return null;
        const next = { ...state.settings, [key]: value };
        const problem = checkPlateMinutes(next.plateMinutesMin, next.plateMinutesMax, state.lang);
        if (problem && (key === 'plateMinutesMin' || key === 'plateMinutesMax')) return problem;
        state.settings[key] = value;
        lastGeneralInput = $(`g-${key}`);
        renderPrintControls();
        renderResult();
        generalSaver.schedule();
        return null;
      },
    });
  }
}

function renderSettings() {
  renderItemList('printers');
  renderItemList('materials');
  for (const key of GENERAL_KEYS) setInputValue($(`g-${key}`), state.settings[key]);
  if (state.storage) $('storage-path').textContent = state.storage.settingsFile;
}

let savedTimer;
let lastGeneralInput = null;

/** Shows "Saved" in the settings group that was just edited. */
function flashSaved() {
  const label = lastGeneralInput?.closest('.settings-group')?.querySelector('.save-state') ?? $('general-save-state');
  for (const other of document.querySelectorAll('.save-state')) {
    if (other !== label) other.classList.remove('is-visible');
  }
  label.textContent = tr('settings.saved');
  label.classList.add('is-visible');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => label.classList.remove('is-visible'), 1800);
}

function renderItemList(kind) {
  const config = ITEM_KINDS[kind];
  const rows = state.settings[kind].map((item) => {
    if (ui.editing[kind] === item.id) return renderItemForm(kind, item);
    if (ui.confirmDelete[kind] === item.id) return renderDeleteConfirm(kind, item);
    return renderItemRow(kind, item);
  });
  if (ui.editing[kind] === 'new') rows.push(renderItemForm(kind, null));
  $(config.listId).replaceChildren(...rows);
  $(config.addButtonId).disabled = ui.editing[kind] === 'new';
}

function renderItemRow(kind, item) {
  const config = ITEM_KINDS[kind];
  const isLast = state.settings[kind].length <= 1;
  return h('div', { class: 'item-row', 'data-id': item.id },
    h('div', { class: 'item-text' },
      h('span', { class: 'item-name' }, item.name),
      h('span', { class: 'item-meta' }, config.summary(item))),
    h('div', { class: 'item-actions' },
      iconButton('edit', tr('item.edit', { name: item.name }), tr('item.editTitle'), () => startEdit(kind, item.id)),
      iconButton('trash', tr('item.delete', { name: item.name }), isLast ? tr(config.lastOneKey) : tr('item.deleteTitle'),
        () => askDelete(kind, item.id), { danger: true, disabled: isLast })));
}

function renderDeleteConfirm(kind, item) {
  const cancel = () => {
    ui.confirmDelete[kind] = null;
    renderItemList(kind);
  };
  return h('div', { class: 'item-row confirm-row', 'data-id': item.id },
    h('div', { class: 'item-text' },
      h('span', { class: 'item-name' }, tr('item.confirmDelete', { name: item.name })),
      h('span', { class: 'item-meta' }, tr('item.cannotUndo'))),
    h('div', { class: 'item-actions' },
      h('button', { type: 'button', class: 'btn btn-small btn-danger', 'data-action': 'confirm-delete', onclick: () => deleteItem(kind, item.id) }, tr('action.delete')),
      h('button', { type: 'button', class: 'btn btn-small', onclick: cancel }, tr('action.cancel'))));
}

function renderItemForm(kind, item) {
  const config = ITEM_KINDS[kind];
  const suffix = item?.id ?? 'new';
  const form = h('form', {
    class: 'item-form',
    'data-kind': kind,
    novalidate: true,
    'aria-label': item ? tr('item.edit', { name: item.name }) : tr(config.newKey),
  });
  for (const field of config.fields) {
    const id = `${kind}-${suffix}-${field.key}`;
    const isName = field.key === 'name';
    const input = h('input', {
      id,
      name: field.key,
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      inputmode: isName ? null : 'decimal',
      maxlength: isName ? '60' : null,
      placeholder: tr(field.placeholderKey),
    });
    if (item) input.value = isName ? item.name : inputNumber(item[field.key]);
    else if (field.defaultValue !== undefined) input.value = inputNumber(field.defaultValue);
    form.append(h('div', { class: 'field' },
      h('label', { for: id }, tr(`field.${field.key}`)),
      isName ? input : h('div', { class: 'input-unit' }, input, h('span', { class: 'unit' }, field.unit)),
      h('p', { class: 'field-error', 'data-error-for': field.key })));
  }
  form.append(
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'form-actions' },
      h('button', { type: 'submit', class: 'btn btn-small btn-primary' }, tr(item ? 'action.save' : 'action.add')),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => cancelEdit(kind) }, tr('action.cancel'))));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitItem(kind, item?.id ?? null, form);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit(kind);
    }
  });
  return form;
}

function startEdit(kind, id) {
  ui.editing[kind] = id;
  ui.confirmDelete[kind] = null;
  renderItemList(kind);
  $(ITEM_KINDS[kind].listId).querySelector('form input')?.focus();
}

function cancelEdit(kind) {
  ui.editing[kind] = null;
  renderItemList(kind);
}

function askDelete(kind, id) {
  ui.confirmDelete[kind] = id;
  ui.editing[kind] = null;
  renderItemList(kind);
  $(ITEM_KINDS[kind].listId).querySelector('[data-action="confirm-delete"]')?.focus();
}

async function submitItem(kind, id, form) {
  const config = ITEM_KINDS[kind];
  const input = Object.fromEntries(config.fields.map((field) => [field.key, form.elements.namedItem(field.key).value]));
  const result = config.validate(input, state.lang);
  showFormErrors(form, result.errors ?? {});
  if (result.errors) {
    form.querySelector('.is-invalid')?.focus();
    return;
  }

  setFormBusy(form, true);
  try {
    await flushSaves();
    const response = id === null
      ? await api('POST', `/api/${kind}`, result.value)
      : await api('PUT', `/api/${kind}/${encodeURIComponent(id)}`, result.value);
    state.settings = response.settings;
    ui.editing[kind] = null;
    renderItemList(kind);
    renderSelects();
    renderPrintControls();
    renderResult();
    showToast(tr(id === null ? 'toast.added' : 'toast.saved', { kind: tr(config.kindKey), name: response.item.name }));
  } catch (error) {
    setFormBusy(form, false);
    showFormErrors(form, error.errors ?? {}, error.errors ? '' : error.message);
  }
}

async function deleteItem(kind, id) {
  const config = ITEM_KINDS[kind];
  const name = state.settings[kind].find((item) => item.id === id)?.name ?? '';
  try {
    await flushSaves();
    const response = await api('DELETE', `/api/${kind}/${encodeURIComponent(id)}`);
    state.settings = response.settings;
    state.lastPrint[config.lastPrintKey] = response.lastPrint[config.lastPrintKey];
    showToast(tr('toast.deleted', { kind: tr(config.kindKey), name }));
  } catch (error) {
    showToast(error.message, 'error');
  }
  ui.confirmDelete[kind] = null;
  renderItemList(kind);
  renderSelects();
  renderPrintControls();
  renderResult();
}

function showFormErrors(form, errors, message = '') {
  for (const element of form.querySelectorAll('[data-error-for]')) {
    const key = element.dataset.errorFor;
    setFieldError(form.elements.namedItem(key), element, errors[key] ?? null);
  }
  form.querySelector('.form-error').textContent = message;
}

function setFormBusy(form, busy) {
  for (const element of form.elements) element.disabled = busy;
}

// ---------------------------------------------------------------------------
// Page lifecycle, messages, helpers

function bindPageLifecycle() {
  const flush = () => {
    lastPrintSaver.flushOnExit();
    generalSaver.flushOnExit();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/**
 * Number input with live validation, arrow-key steps and the decimal separator of the language.
 * `set` may return a message when the value is valid on its own but not allowed in context.
 */
function bindNumberInput(input, key, { get, set }) {
  const errorElement = input.closest('.field')?.querySelector('.field-error');
  input.addEventListener('input', () => {
    const result = checkNumber(key, input.value, state.lang);
    if ('error' in result) {
      setFieldError(input, errorElement, result.error);
      return;
    }
    setFieldError(input, errorElement, set(result.value) || null);
  });
  input.addEventListener('blur', () => {
    // Invalid text is replaced by the last valid value.
    setFieldError(input, errorElement, null);
    const value = get();
    if (value !== undefined) input.value = inputNumber(value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      input.blur();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const current = checkNumber(key, input.value, state.lang).value ?? get();
    if (current === undefined) return;
    event.preventDefault();
    const step = STEPS[key] ?? 1;
    const next = Number((current + (event.key === 'ArrowUp' ? step : -step)).toFixed(6));
    const result = checkNumber(key, next, state.lang);
    if ('error' in result) return;
    const problem = set(result.value) || null;
    if (!problem) input.value = inputNumber(result.value);
    setFieldError(input, errorElement, problem);
  });
}

function setInputValue(input, value) {
  if (document.activeElement !== input) input.value = inputNumber(value);
}

function setFieldError(input, errorElement, message) {
  if (!input) return;
  input.classList.toggle('is-invalid', Boolean(message));
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  if (errorElement) errorElement.textContent = message ?? '';
}

let toastTimer;
function showToast(message, kind = 'info') {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', kind === 'error');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, kind === 'error' ? 6000 : 3000);
}

function showAppError(message) {
  $('app-error').textContent = message;
  $('app-error').hidden = false;
}

function renderWarnings() {
  const warnings = state.warnings.map((warning) => h('p', {}, tr(warning.code, warning.params)));
  $('app-warnings').replaceChildren(...warnings);
  $('app-warnings').hidden = warnings.length === 0;
}

function iconButton(icon, label, title, onClick, { danger = false, disabled = false } = {}) {
  const button = h('button', {
    type: 'button',
    class: danger ? 'icon-btn danger' : 'icon-btn',
    'aria-label': label,
    title,
    disabled,
    onclick: onClick,
  });
  const template = document.createElement('template');
  template.innerHTML = ICONS[icon]; // constant markup
  button.append(template.content.firstElementChild);
  return button;
}

/** Small element builder. Attributes with null/undefined/false are skipped; on* attributes become listeners. */
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2), value);
    else if (name === 'class') element.className = value;
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false && child !== '') element.append(child);
  }
  return element;
}

// Start only after every top-level declaration above is initialized.
init();

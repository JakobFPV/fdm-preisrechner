// German/English dictionary: both languages complete, every key used in the code exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { detectLanguage, LANGUAGES, MESSAGES, normalizeLanguage, t, tn } from '../public/lib/i18n.js';
import { NUMBER_FIELDS, PRINTER_KEYS, MATERIAL_KEYS } from '../public/lib/validate.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('dictionary', () => {
  it('German and English have exactly the same keys', () => {
    const de = Object.keys(MESSAGES.de).sort();
    const en = Object.keys(MESSAGES.en).sort();
    assert.deepEqual(en.filter((key) => !MESSAGES.de[key]), [], 'only in English');
    assert.deepEqual(de.filter((key) => !MESSAGES.en[key]), [], 'only in German');
  });

  it('both languages use the same placeholders', () => {
    for (const key of Object.keys(MESSAGES.de)) {
      assert.deepEqual(placeholders(MESSAGES.en[key]), placeholders(MESSAGES.de[key]), key);
    }
  });

  it('only ".html" keys contain markup', () => {
    for (const lang of LANGUAGES) {
      for (const [key, text] of Object.entries(MESSAGES[lang])) {
        if (key.endsWith('.html')) continue;
        // a literal "<model>" in an error text is shown as text, never as markup
        assert.ok(!/<(strong|code|br|em|a)\b/.test(text), `${lang} ${key} contains markup`);
      }
    }
  });

  it('every number field has a label in both languages', () => {
    const keys = [...Object.keys(NUMBER_FIELDS), ...PRINTER_KEYS, ...MATERIAL_KEYS, 'printerId', 'materialId', 'support', 'language'];
    for (const lang of LANGUAGES) {
      for (const key of keys) assert.ok(MESSAGES[lang][`field.${key}`], `${lang} field.${key}`);
    }
  });

  it('every key used in the code and the page exists', () => {
    const sources = [
      'public/app.js', 'public/lib/mesh.js', 'public/lib/validate.js', 'src/app.js', 'src/store.js',
      'server.js', 'scripts/autostart.js',
    ].map((file) => [file, read(file)]);
    const used = new Map();
    const add = (key, file) => used.set(key, file);
    for (const [file, source] of sources) {
      for (const match of source.matchAll(/\btr\(\s*'([\w.-]+)'/g)) add(match[1], file);
      for (const match of source.matchAll(/\bt\(\s*\w+\s*,\s*'([\w.-]+)'/g)) add(match[1], file);
      for (const match of source.matchAll(/new (?:ModelError|HttpError)\(\s*(?:\d+\s*,\s*)?'([\w.-]+)'/g)) add(match[1], file);
      for (const match of source.matchAll(/code: '([\w.-]+)'/g)) add(match[1], file);
      for (const match of source.matchAll(/(?:Key|key): '([a-z][\w-]*\.[\w.-]+)'/g)) add(match[1], file);
      for (const match of source.matchAll(/\btrn\(\s*'([\w.-]+)'/g)) {
        add(`${match[1]}_one`, file);
        add(`${match[1]}_other`, file);
      }
      for (const match of source.matchAll(/\btr\(\s*\w+\s*\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'/g)) {
        add(match[1], file);
        add(match[2], file);
      }
    }
    const html = read('public/index.html');
    for (const match of html.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)) add(match[1], 'index.html');
    for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of match[1].split(';')) add(pair.split(':')[1].trim(), 'index.html');
    }

    assert.ok(used.size > 150, `only ${used.size} keys found – is the scan still working?`);
    const exists = (key) => LANGUAGES.every((lang) => MESSAGES[lang][key]);
    const isPluralBase = (key) => exists(`${key}_one`) && exists(`${key}_other`); // used via tn()
    const missing = [...used].filter(([key]) => !exists(key) && !isPluralBase(key));
    assert.deepEqual(missing, []);
  });

  it('fills in placeholders and formats numbers per language', () => {
    assert.equal(t('de', 'model.objects', { count: 1234 }), '1.234 Objekte');
    assert.equal(t('en', 'model.objects', { count: 1234 }), '1,234 objects');
    assert.equal(tn('de', 'plates', 1), '1 Platte');
    assert.equal(tn('en', 'plates', 3), '3 plates');
    assert.equal(t('en', 'does.not.exist'), 'does.not.exist');
  });

  it('recognises languages', () => {
    assert.equal(normalizeLanguage('de-AT'), 'de');
    assert.equal(normalizeLanguage('en_US.UTF-8'), 'en');
    assert.equal(normalizeLanguage('fr'), null);
    assert.equal(detectLanguage(['fr-FR', 'de-DE', 'en']), 'de');
    assert.equal(detectLanguage(['fr-FR']), 'en');
    assert.equal(detectLanguage([undefined, 'C', 'de_DE.UTF-8']), 'de');
  });
});

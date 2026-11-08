// Erzeugt Beispielmodelle zum Ausprobieren im Ordner test-models/.
//   npm run test-models

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asciiStl,
  binaryStl,
  boxMeshXml,
  boxObj,
  boxTriangles,
  cylinderTriangles,
  cylinderVolume,
  make3mf,
  modelXml,
  reverseWinding,
} from '../test/helpers/models.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'test-models');
fs.mkdirSync(OUT, { recursive: true });

const write = (name, data, expectation) => {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`${name.padEnd(30)} ${expectation}`);
};

const cube = boxTriangles(20, 20, 20);
write('wuerfel-20mm.stl', binaryStl(cube), '20 × 20 × 20 mm, 8,00 cm³ (Binär-STL)');
write('wuerfel-20mm-ascii.stl', asciiStl(cube, 'wuerfel_20mm'), '20 × 20 × 20 mm, 8,00 cm³ (Text-STL)');
write('wuerfel-20mm.3mf', make3mf(modelXml({
  objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }],
  items: [{ objectId: 1, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 118, 118, 0] }],
})), '20 × 20 × 20 mm, 8,00 cm³ (3MF)');
write('quader-60x40x10mm.obj', boxObj(60, 40, 10), '60 × 40 × 10 mm, 24,00 cm³ (OBJ)');

const segments = 96;
write('zylinder-d20-h40.stl', binaryStl(cylinderTriangles(10, 40, segments)),
  `Ø 20 × 40 mm, ${(cylinderVolume(10, 40, segments) / 1000).toFixed(2).replace('.', ',')} cm³`);

// Hollow cube: outer shell 40 mm, inner cavity 30 mm (faces pointing inwards) → 64 − 27 = 37 cm³
const hollow = [...boxTriangles(40, 40, 40), ...reverseWinding(boxTriangles(30, 30, 30, [5, 5, 5]))];
write('hohlwuerfel-40mm.stl', binaryStl(hollow), '40 × 40 × 40 mm mit 30-mm-Hohlraum, 37,00 cm³');

// Broken files for the error messages
const cubeStl = binaryStl(cube);
write('defekt-abgeschnitten.stl', cubeStl.subarray(0, cubeStl.length - 120), 'Fehler: abgeschnittene Binär-STL');
write('kein-modell.stl', 'Das ist keine STL-Datei, sondern nur Text.\n', 'Fehler: keine STL-Daten');
write('defekt.3mf', Buffer.from('PK – kein echtes ZIP-Archiv'), 'Fehler: kaputtes 3MF');
write('nicht-unterstuetzt.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n', 'Fehler: Format nicht unterstützt');

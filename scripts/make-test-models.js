// Creates sample models for trying out the calculator in test-models/.
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
  console.log(`${name.padEnd(28)} ${expectation}`);
};

const cube = boxTriangles(20, 20, 20);
write('cube-20mm.stl', binaryStl(cube), '20 × 20 × 20 mm, 8.00 cm³ (binary STL)');
write('cube-20mm-ascii.stl', asciiStl(cube, 'cube_20mm'), '20 × 20 × 20 mm, 8.00 cm³ (text STL)');
write('cube-20mm.3mf', make3mf(modelXml({
  objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }],
  items: [{ objectId: 1, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 118, 118, 0] }],
})), '20 × 20 × 20 mm, 8.00 cm³ (3MF)');
write('box-60x40x10mm.obj', boxObj(60, 40, 10), '60 × 40 × 10 mm, 24.00 cm³ (OBJ)');

const segments = 96;
write('cylinder-d20-h40.stl', binaryStl(cylinderTriangles(10, 40, segments)),
  `Ø 20 × 40 mm, ${(cylinderVolume(10, 40, segments) / 1000).toFixed(2)} cm³`);

// Hollow cube: outer shell 40 mm, inner cavity 30 mm (faces pointing inwards) → 64 − 27 = 37 cm³
const hollow = [...boxTriangles(40, 40, 40), ...reverseWinding(boxTriangles(30, 30, 30, [5, 5, 5]))];
write('hollow-cube-40mm.stl', binaryStl(hollow), '40 × 40 × 40 mm with a 30 mm cavity, 37.00 cm³');

// Broken files for the error messages
const cubeStl = binaryStl(cube);
write('broken-truncated.stl', cubeStl.subarray(0, cubeStl.length - 120), 'error: truncated binary STL');
write('not-a-model.stl', 'This is not an STL file, just text.\n', 'error: no STL data');
write('broken.3mf', Buffer.from('PK – not a real ZIP archive'), 'error: damaged 3MF');
write('unsupported.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n', 'error: unsupported format');

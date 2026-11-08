// Reading models: volume, surface, size, and clear errors for broken or unsupported files.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeModelFile, ModelError } from '../public/lib/mesh.js';
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
  writeZip,
} from './helpers/models.js';

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const cube = boxTriangles(20, 20, 20);

function assertCube(info, size = 20) {
  near(info.volumeCm3, size ** 3 / 1000);
  near(info.surfaceAreaCm2, (6 * size * size) / 100);
  near(info.sizeMm.x, size);
  near(info.sizeMm.y, size);
  near(info.sizeMm.z, size);
}

/** Expects a ModelError whose German message matches `pattern`. */
async function rejectsWith(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ModelError, `expected ModelError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

const simple3mf = (meshXml, options = {}) =>
  make3mf(modelXml({ objects: [{ id: 1, xml: meshXml }], items: [{ objectId: 1 }], ...options }));

describe('STL', () => {
  it('reads a binary STL', async () => {
    const info = await analyzeModelFile(binaryStl(cube), 'wuerfel.stl');
    assertCube(info);
    assert.equal(info.format, 'STL (binär)');
    assert.equal(info.triangleCount, 12);
    assert.deepEqual(info.warnings, []);
  });

  it('reads an ASCII STL', async () => {
    const info = await analyzeModelFile(Buffer.from(asciiStl(cube)), 'wuerfel.stl');
    assertCube(info);
    assert.equal(info.format, 'STL (ASCII)');
  });

  it('reads ASCII STL with Windows line endings and upper-case keywords', async () => {
    const text = asciiStl(cube).toUpperCase().replace(/\n/g, '\r\n');
    assertCube(await analyzeModelFile(Buffer.from(text), 'WUERFEL.STL'));
  });

  it('treats a binary STL whose header starts with "solid" as binary', async () => {
    const info = await analyzeModelFile(binaryStl(cube, 'solid exported by some CAD'), 'wuerfel.stl');
    assert.equal(info.format, 'STL (binär)');
    assertCube(info);
  });

  it('accepts a Uint8Array view with an offset', async () => {
    const stl = binaryStl(cube);
    const padded = new Uint8Array(stl.length + 16);
    padded.set(stl, 16);
    assertCube(await analyzeModelFile(padded.subarray(16), 'wuerfel.stl'));
  });

  it('ignores the triangle orientation (inverted normals)', async () => {
    assertCube(await analyzeModelFile(binaryStl(reverseWinding(cube)), 'wuerfel.stl'));
  });

  it('measures precisely far away from the origin', async () => {
    assertCube(await analyzeModelFile(binaryStl(boxTriangles(20, 20, 20, [5000, -3000, 1000])), 'wuerfel.stl'));
  });

  it('measures a cylinder', async () => {
    const info = await analyzeModelFile(binaryStl(cylinderTriangles(10, 40, 96)), 'zylinder.stl');
    near(info.volumeCm3, cylinderVolume(10, 40, 96) / 1000, 1e-5);
    near(info.volumeCm3, (Math.PI * 10 * 10 * 40) / 1000, 0.02); // close to the true cylinder
    near(info.sizeMm.x, 20, 1e-4);
    near(info.sizeMm.z, 40, 1e-4);
  });

  it('subtracts inner cavities (hollow cube 40 mm with 30 mm cavity = 37 cm³)', async () => {
    const hollow = [...boxTriangles(40, 40, 40), ...reverseWinding(boxTriangles(30, 30, 30, [5, 5, 5]))];
    near((await analyzeModelFile(binaryStl(hollow), 'hohl.stl')).volumeCm3, 37);
  });

  it('warns when the mesh has holes', async () => {
    const open = cube.slice(2); // bottom face missing
    const info = await analyzeModelFile(binaryStl(open), 'offen.stl');
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /nicht geschlossen/);
  });

  it('warns when the model is suspiciously small (exported in meters)', async () => {
    const info = await analyzeModelFile(binaryStl(boxTriangles(0.02, 0.02, 0.02)), 'meter.stl');
    assert.match(info.warnings.join(' '), /kleiner als 1 mm/);
  });

  it('rejects a truncated binary STL with the numbers in the message', async () => {
    const stl = binaryStl(cube);
    await rejectsWith(analyzeModelFile(stl.subarray(0, stl.length - 120), 'kaputt.stl'),
      /unvollständig.*12 Dreiecke.*nur für 9/);
  });

  it('rejects a text file that is not an STL', async () => {
    await rejectsWith(analyzeModelFile(Buffer.from('Hallo Welt, das ist keine STL.'), 'text.stl'),
      /keine gültige STL-Datei/);
    const longText = Buffer.from('Lorem ipsum dolor sit amet, '.repeat(20));
    await rejectsWith(analyzeModelFile(longText, 'text.stl'), /keine gültige STL-Datei|beschädigt/);
  });

  it('rejects random binary data', async () => {
    const random = Buffer.alloc(4000);
    for (let i = 0; i < random.length; i++) random[i] = (i * 7919 + 13) % 251;
    await rejectsWith(analyzeModelFile(random, 'zufall.stl'), /STL-Datei|Koordinaten|Volumen/);
  });

  it('rejects coordinates that are not numbers', async () => {
    const stl = binaryStl(cube);
    stl.writeFloatLE(Number.NaN, 84 + 12); // first vertex of the first triangle
    await rejectsWith(analyzeModelFile(stl, 'nan.stl'), /ungültige Koordinaten/);
    const text = asciiStl(cube).replace('vertex', 'vertex abc');
    await rejectsWith(analyzeModelFile(Buffer.from(text), 'nan.stl'), /ungültige Koordinaten/);
  });

  it('rejects an ASCII STL that ends in the middle of a face', async () => {
    const text = asciiStl(cube);
    await rejectsWith(analyzeModelFile(Buffer.from(text.slice(0, text.lastIndexOf('endloop'))), 'halb.stl'),
      /unvollständig/);
  });

  it('rejects an STL without triangles', async () => {
    await rejectsWith(analyzeModelFile(binaryStl([]), 'leer.stl'), /keine Dreiecke/);
    await rejectsWith(analyzeModelFile(Buffer.from('solid leer\nendsolid leer\n'), 'leer.stl'), /keine Dreiecke/);
  });

  it('rejects a flat model without volume', async () => {
    const flat = [[[0, 0, 0], [10, 0, 0], [10, 10, 0]], [[0, 0, 0], [10, 10, 0], [0, 10, 0]]];
    await rejectsWith(analyzeModelFile(binaryStl(flat), 'flach.stl'), /kein messbares Volumen/);
  });
});

describe('OBJ', () => {
  it('reads quads with shared vertices', async () => {
    const info = await analyzeModelFile(Buffer.from(boxObj(20, 20, 20)), 'wuerfel.obj');
    assertCube(info);
    assert.equal(info.format, 'OBJ');
    assert.equal(info.triangleCount, 12);
  });

  it('reads negative indices and texture/normal references', async () => {
    assertCube(await analyzeModelFile(Buffer.from(boxObj(20, 20, 20, { negativeIndices: true, withNormals: true })), 'wuerfel.obj'));
  });

  it('rejects faces that point to missing vertices, with the line number', async () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 9\n';
    await rejectsWith(analyzeModelFile(Buffer.from(obj), 'kaputt.obj'), /nicht in der Datei stehen|nicht vorhandenen/);
    await rejectsWith(analyzeModelFile(Buffer.from('v 0 0 0\nf 1 -5 1\n'), 'kaputt.obj'), /Zeile 2/);
  });

  it('rejects an OBJ without faces', async () => {
    await rejectsWith(analyzeModelFile(Buffer.from('# nur Punkte\nv 0 0 0\nv 1 1 1\n'), 'punkte.obj'),
      /keine Flächen/);
  });

  it('rejects broken vertex lines', async () => {
    await rejectsWith(analyzeModelFile(Buffer.from('v 0 0\nf 1 1 1\n'), 'kaputt.obj'), /Zeile 1/);
  });
});

describe('3MF', () => {
  it('reads a compressed 3MF', async () => {
    const info = await analyzeModelFile(simple3mf(boxMeshXml(20, 20, 20)), 'wuerfel.3mf');
    assertCube(info);
    assert.equal(info.format, '3MF');
    assert.equal(info.objectCount, 1);
  });

  it('reads an uncompressed 3MF without relationship file', async () => {
    const file = make3mf(modelXml({ objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }], items: [{ objectId: 1 }] }),
      { compress: false, rels: false });
    assertCube(await analyzeModelFile(file, 'wuerfel.3mf'));
  });

  it('converts the model unit to millimeters', async () => {
    const info = await analyzeModelFile(simple3mf(boxMeshXml(2, 2, 2), { unit: 'centimeter' }), 'cm.3mf');
    assertCube(info, 20);
    const inch = await analyzeModelFile(simple3mf(boxMeshXml(1, 1, 1), { unit: 'inch' }), 'inch.3mf');
    near(inch.sizeMm.x, 25.4);
    near(inch.volumeCm3, 25.4 ** 3 / 1000);
  });

  it('applies build item transforms (scale, rotation, mirroring)', async () => {
    const scaled = modelXml({
      objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }],
      items: [{ objectId: 1, transform: [2, 0, 0, 0, 2, 0, 0, 0, 2, 100, 100, 0] }],
    });
    assertCube(await analyzeModelFile(make3mf(scaled), 'gross.3mf'), 40);

    const rotated = modelXml({
      objects: [{ id: 1, xml: boxMeshXml(10, 20, 30) }],
      items: [{ objectId: 1, transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0] }], // 90° around z
    });
    const info = await analyzeModelFile(make3mf(rotated), 'gedreht.3mf');
    near(info.sizeMm.x, 20);
    near(info.sizeMm.y, 10);
    near(info.volumeCm3, 6);

    const mirrored = modelXml({
      objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }],
      items: [{ objectId: 1, transform: [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }],
    });
    assertCube(await analyzeModelFile(make3mf(mirrored), 'gespiegelt.3mf'));
  });

  it('follows components stored in other model files (Bambu Studio style)', async () => {
    const root = modelXml({
      production: true,
      objects: [{
        id: 2,
        xml: '<components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components>',
      }],
      items: [{ objectId: 2, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 128, 128, 10] }],
    });
    const part = modelXml({ objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }], items: [] });
    const file = make3mf(root, { parts: [{ name: '3D/Objects/object_1.model', data: part }] });
    const info = await analyzeModelFile(file, 'bambu.3mf');
    assertCube(info);
    assert.equal(info.objectCount, 1);
  });

  it('adds up several objects and says so', async () => {
    const xml = modelXml({
      objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }, { id: 2, xml: boxMeshXml(10, 10, 10, [40, 0, 0]) }],
      items: [{ objectId: 1 }, { objectId: 2 }],
    });
    const info = await analyzeModelFile(make3mf(xml), 'zwei.3mf');
    near(info.volumeCm3, 9);
    assert.equal(info.objectCount, 2);
    assert.match(info.warnings.join(' '), /2 Objekte/);
  });

  it('skips items that are marked as not printable', async () => {
    const xml = modelXml({
      objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }, { id: 2, xml: boxMeshXml(10, 10, 10) }],
      items: [{ objectId: 1 }, { objectId: 2, printable: false }],
    });
    assertCube(await analyzeModelFile(make3mf(xml), 'teilweise.3mf'));
  });

  it('rejects a file that is not a ZIP archive', async () => {
    await rejectsWith(analyzeModelFile(binaryStl(cube), 'falsch.3mf'), /kein gültiges ZIP-Archiv/);
  });

  it('rejects a ZIP archive without a 3D model', async () => {
    const zip = writeZip([{ name: 'readme.txt', data: 'hallo' }]);
    await rejectsWith(analyzeModelFile(zip, 'leer.3mf'), /kein 3D-Modell/);
  });

  it('rejects broken model data', async () => {
    const badIndex = '<mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>';
    await rejectsWith(analyzeModelFile(simple3mf(badIndex), 'kaputt.3mf'), /nicht vorhandenen Eckpunkt/);

    const badNumber = boxMeshXml(20, 20, 20).replace('x="0"', 'x="abc"');
    await rejectsWith(analyzeModelFile(simple3mf(badNumber), 'kaputt.3mf'), /ungültige Koordinaten/);

    const missingObject = modelXml({ objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }], items: [{ objectId: 7 }] });
    await rejectsWith(analyzeModelFile(make3mf(missingObject), 'kaputt.3mf'), /ID „7“ fehlt/);
  });

  it('rejects a damaged (truncated) archive', async () => {
    const file = simple3mf(boxMeshXml(20, 20, 20));
    await rejectsWith(analyzeModelFile(file.subarray(0, file.length - 30), 'abgeschnitten.3mf'), /beschädigt/);
  });

  it('rejects a 3MF without printable objects', async () => {
    const xml = modelXml({ objects: [{ id: 1, xml: boxMeshXml(20, 20, 20) }], items: [] });
    await rejectsWith(analyzeModelFile(make3mf(xml), 'leer.3mf'), /keine druckbaren Objekte/);
  });
});

describe('file types', () => {
  it('rejects unsupported formats with a clear message', async () => {
    await rejectsWith(analyzeModelFile(Buffer.from('ISO-10303-21;'), 'teil.step'), /„\.step“ wird nicht unterstützt/);
    await rejectsWith(analyzeModelFile(Buffer.from('x'), 'ohne-endung'), /keine Dateiendung/);
  });

  it('rejects empty files', async () => {
    await rejectsWith(analyzeModelFile(new Uint8Array(0), 'leer.stl'), /Die Datei ist leer/);
    await rejectsWith(analyzeModelFile(new ArrayBuffer(0), 'leer.3mf'), /Die Datei ist leer/);
  });

  it('accepts upper-case extensions', async () => {
    assertCube(await analyzeModelFile(binaryStl(cube), 'WUERFEL.STL'));
  });
});

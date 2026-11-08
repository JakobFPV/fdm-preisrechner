// Builders for test models (STL, OBJ, 3MF), used by the tests and by scripts/make-test-models.js.

import zlib from 'node:zlib';

// Corners of an axis-aligned box and its faces, counter-clockwise seen from outside.
const BOX_CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const BOX_QUADS = [
  [0, 3, 2, 1], // bottom (−z)
  [4, 5, 6, 7], // top (+z)
  [0, 1, 5, 4], // front (−y)
  [3, 7, 6, 2], // back (+y)
  [0, 4, 7, 3], // left (−x)
  [1, 2, 6, 5], // right (+x)
];

export function boxVertices(sx, sy, sz, [ox, oy, oz] = [0, 0, 0]) {
  return BOX_CORNERS.map(([x, y, z]) => [ox + x * sx, oy + y * sy, oz + z * sz]);
}

export function boxTriangleIndices() {
  return BOX_QUADS.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
}

/** 12 triangles of a box, each triangle as [[x,y,z], [x,y,z], [x,y,z]]. */
export function boxTriangles(sx, sy, sz, offset = [0, 0, 0]) {
  const vertices = boxVertices(sx, sy, sz, offset);
  return boxTriangleIndices().map((triangle) => triangle.map((i) => vertices[i]));
}

/** Closed cylinder around the z axis, standing on z = 0. */
export function cylinderTriangles(radius, height, segments) {
  const ring = (z) =>
    Array.from({ length: segments }, (_, i) => {
      const angle = (2 * Math.PI * i) / segments;
      return [radius * Math.cos(angle), radius * Math.sin(angle), z];
    });
  const bottom = ring(0);
  const top = ring(height);
  const triangles = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    triangles.push([[0, 0, 0], bottom[j], bottom[i]]);
    triangles.push([[0, 0, height], top[i], top[j]]);
    triangles.push([bottom[i], bottom[j], top[j]]);
    triangles.push([bottom[i], top[j], top[i]]);
  }
  return triangles;
}

/** Exact volume of the polygonal cylinder above (mm³). */
export function cylinderVolume(radius, height, segments) {
  return (segments / 2) * radius * radius * Math.sin((2 * Math.PI) / segments) * height;
}

export function reverseWinding(triangles) {
  return triangles.map(([a, b, c]) => [a, c, b]);
}

export function binaryStl(triangles, header = 'FDM price calculator test model') {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write(header.slice(0, 80), 0, 'latin1');
  buffer.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const triangle of triangles) {
    const [nx, ny, nz] = normalOf(triangle);
    for (const value of [nx, ny, nz, ...triangle.flat()]) {
      buffer.writeFloatLE(value, offset);
      offset += 4;
    }
    offset += 2;
  }
  return buffer;
}

export function asciiStl(triangles, name = 'testmodell') {
  const lines = [`solid ${name}`];
  for (const triangle of triangles) {
    lines.push(`  facet normal ${normalOf(triangle).map(formatFloat).join(' ')}`, '    outer loop');
    for (const vertex of triangle) lines.push(`      vertex ${vertex.map(formatFloat).join(' ')}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return lines.join('\n');
}

/** Box as OBJ with shared vertices and quad faces (optionally with negative indices). */
export function boxObj(sx, sy, sz, { negativeIndices = false, withNormals = false } = {}) {
  const lines = ['# FDM price calculator test model', 'o box'];
  for (const [x, y, z] of boxVertices(sx, sy, sz)) lines.push(`v ${x} ${y} ${z}`);
  if (withNormals) lines.push('vn 0 0 1', 'vt 0 0');
  for (const quad of BOX_QUADS) {
    const refs = quad.map((i) => (negativeIndices ? i - BOX_CORNERS.length : i + 1));
    lines.push(`f ${refs.map((r) => (withNormals ? `${r}/1/1` : `${r}`)).join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** <mesh> element of a 3MF object for a box. */
export function boxMeshXml(sx, sy, sz, offset = [0, 0, 0]) {
  const vertices = boxVertices(sx, sy, sz, offset)
    .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)
    .join('');
  const triangles = boxTriangleIndices()
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    .join('');
  return `<mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh>`;
}

/** 3MF model XML. `objects`: [{ id, xml, type }], `items`: [{ objectId, transform, printable, path }] */
export function modelXml({ unit = 'millimeter', objects, items, production = false }) {
  const ns = production ? ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"' : '';
  const objectXml = objects
    .map((o) => `<object id="${o.id}" type="${o.type ?? 'model'}">${o.xml}</object>`)
    .join('\n    ');
  const itemXml = (items ?? [])
    .map((item) => {
      const attributes = [`objectid="${item.objectId}"`];
      if (item.transform) attributes.push(`transform="${item.transform.join(' ')}"`);
      if (item.path) attributes.push(`p:path="${item.path}"`);
      if (item.printable === false) attributes.push('printable="0"');
      return `<item ${attributes.join(' ')}/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${ns}>
  <!-- generated by the FDM price calculator tests -->
  <resources>
    ${objectXml}
  </resources>
  <build>${itemXml}</build>
</model>
`;
}

/** Packs model XML into a 3MF (ZIP) file. `parts` are extra files: [{ name, data }]. */
export function make3mf(rootModelXml, { parts = [], compress = true, rels = true } = {}) {
  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    },
  ];
  if (rels) {
    files.push({
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
        '</Relationships>',
    });
  }
  files.push({ name: '3D/3dmodel.model', data: rootModelXml }, ...parts);
  return writeZip(files.map((file) => ({ ...file, compress })));
}

/** Minimal ZIP writer (stored or deflated entries). */
export function writeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const compress = file.compress !== false;
    const stored = compress ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function normalOf([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n) || 1;
  return n.map((value) => value / length);
}

function formatFloat(value) {
  return Number(value.toFixed(6)).toExponential(6);
}

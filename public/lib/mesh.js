// Reads 3D models (STL, OBJ, 3MF) and measures volume, surface area and size.
// Pure JavaScript without DOM access, used by the browser and by the tests.
// Errors and warnings carry a dictionary key (see i18n.js), so the interface can show them in any language.

import { t } from './i18n.js';
import { openZip } from './zip.js';

export const SUPPORTED_FORMATS = ['stl', '3mf', 'obj'];
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

/**
 * Problem with the uploaded file. `code` is a dictionary key and `params` its placeholders;
 * `message` holds the German text (for logs and tests). Show it with t(lang, error.code, error.params).
 */
export class ModelError extends Error {
  constructor(code, params = {}) {
    super(t('de', code, params));
    this.name = 'ModelError';
    this.code = code;
    this.params = params;
  }
}

// A closed surface has a vector area of zero. Larger relative values mean holes or flipped faces.
const OPEN_MESH_TOLERANCE = 1e-3;
const MAX_STL_TRIANGLES = Math.floor(MAX_FILE_BYTES / 50);
const UNIT_TO_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const PRINTABLE_OBJECT_TYPES = new Set(['model', 'solidsupport']);
const MAX_COMPONENT_DEPTH = 16;

const utf8 = new TextDecoder('utf-8');

export function fileExtension(fileName) {
  const match = /\.([^./\\]+)$/.exec(fileName ?? '');
  return match ? match[1].toLowerCase() : '';
}

/** Throws a ModelError if the file type is not supported (checked before reading the file). */
export function checkModelFileName(fileName) {
  const extension = fileExtension(fileName);
  if (SUPPORTED_FORMATS.includes(extension)) return extension;
  if (!extension) {
    throw new ModelError('model.noExtension');
  }
  throw new ModelError('model.unsupported', { ext: extension });
}

/**
 * Reads a model file and returns its measurements.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {string} fileName  used to pick the format by its extension
 * @returns {Promise<{format: string, objectCount: number, triangleCount: number, volumeCm3: number,
 *   surfaceAreaCm2: number, sizeMm: {x: number, y: number, z: number}, warnings: {code: string, params: object}[]}>}
 *   `format` is "stl-binary", "stl-ascii", "obj" or "3mf"; warnings are dictionary keys (see i18n.js).
 */
export async function analyzeModelFile(data, fileName) {
  const extension = checkModelFileName(fileName);
  const bytes = toBytes(data);
  if (bytes.byteLength === 0) throw new ModelError('model.empty');
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ModelError('model.tooLarge', { max: MAX_FILE_BYTES / 1024 / 1024 });
  }
  let parsed;
  if (extension === 'stl') parsed = parseStl(bytes);
  else if (extension === 'obj') parsed = parseObj(bytes);
  else parsed = await parse3mf(bytes);
  return measureModel(parsed);
}

// ---------------------------------------------------------------------------
// Measuring

function measureModel({ format, meshes, unitScale = 1, objectCount = 1 }) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume = 0;
  let area = 0;
  let triangleCount = 0;
  let openMeshes = 0;

  for (const mesh of meshes) {
    const result = measureMesh(mesh, bounds);
    if (result.triangles === 0) continue;
    if (!Number.isFinite(result.signedVolume) || !Number.isFinite(result.area)) {
      throw new ModelError('model.invalidCoordinates');
    }
    // Inverted or mirrored meshes have a negative signed volume.
    volume += Math.abs(result.signedVolume);
    area += result.area;
    triangleCount += result.triangles;
    if (result.area > 0 && result.vectorArea / result.area > OPEN_MESH_TOLERANCE) openMeshes += 1;
  }

  if (triangleCount === 0) throw new ModelError('model.noTriangles');

  const s = unitScale;
  const volumeMm3 = volume * s ** 3;
  if (!(volumeMm3 > 1e-6)) {
    throw new ModelError('model.noVolume');
  }
  const sizeMm = {
    x: (bounds.max[0] - bounds.min[0]) * s,
    y: (bounds.max[1] - bounds.min[1]) * s,
    z: (bounds.max[2] - bounds.min[2]) * s,
  };

  const warnings = [];
  if (openMeshes > 0) {
    warnings.push({ code: 'warning.openMesh', params: {} });
  }
  const largest = Math.max(sizeMm.x, sizeMm.y, sizeMm.z);
  if (largest < 1) {
    warnings.push({ code: 'warning.tiny', params: {} });
  } else if (largest > 2000) {
    warnings.push({ code: 'warning.huge', params: {} });
  }
  if (objectCount > 1) {
    warnings.push({ code: 'warning.multipleObjects', params: { count: objectCount } });
  }

  return {
    format,
    objectCount,
    triangleCount,
    volumeCm3: volumeMm3 / 1000,
    surfaceAreaCm2: (area * s * s) / 100,
    sizeMm,
    warnings,
  };
}

/**
 * Signed volume (sum of tetrahedra), surface area, vector area and bounding box of one mesh.
 * `positions`: xyz triples. `indices`: vertex index triples, or null for a plain triangle list.
 * `transform`: optional 3MF matrix (row vector form, 12 numbers).
 */
function measureMesh({ positions: p, indices, transform: t }, bounds) {
  const triangles = indices ? indices.length / 3 : p.length / 9;
  if (triangles === 0) return { triangles: 0 };

  // Work relative to the first vertex: keeps the numbers small for models far from the origin.
  const first = indices ? indices[0] * 3 : 0;
  let ox = p[first];
  let oy = p[first + 1];
  let oz = p[first + 2];
  if (t) {
    const x = ox, y = oy, z = oz;
    ox = x * t[0] + y * t[3] + z * t[6] + t[9];
    oy = x * t[1] + y * t[4] + z * t[7] + t[10];
    oz = x * t[2] + y * t[5] + z * t[8] + t[11];
  }

  let [minX, minY, minZ] = bounds.min;
  let [maxX, maxY, maxZ] = bounds.max;
  let volume6 = 0;
  let area2 = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;

  for (let k = 0; k < triangles; k++) {
    let i0, i1, i2;
    if (indices) {
      i0 = indices[3 * k] * 3;
      i1 = indices[3 * k + 1] * 3;
      i2 = indices[3 * k + 2] * 3;
    } else {
      i0 = 9 * k;
      i1 = i0 + 3;
      i2 = i0 + 6;
    }
    let x0 = p[i0], y0 = p[i0 + 1], z0 = p[i0 + 2];
    let x1 = p[i1], y1 = p[i1 + 1], z1 = p[i1 + 2];
    let x2 = p[i2], y2 = p[i2 + 1], z2 = p[i2 + 2];
    if (t) {
      let x = x0, y = y0, z = z0;
      x0 = x * t[0] + y * t[3] + z * t[6] + t[9];
      y0 = x * t[1] + y * t[4] + z * t[7] + t[10];
      z0 = x * t[2] + y * t[5] + z * t[8] + t[11];
      x = x1; y = y1; z = z1;
      x1 = x * t[0] + y * t[3] + z * t[6] + t[9];
      y1 = x * t[1] + y * t[4] + z * t[7] + t[10];
      z1 = x * t[2] + y * t[5] + z * t[8] + t[11];
      x = x2; y = y2; z = z2;
      x2 = x * t[0] + y * t[3] + z * t[6] + t[9];
      y2 = x * t[1] + y * t[4] + z * t[7] + t[10];
      z2 = x * t[2] + y * t[5] + z * t[8] + t[11];
    }

    if (x0 < minX) minX = x0; if (x0 > maxX) maxX = x0;
    if (y0 < minY) minY = y0; if (y0 > maxY) maxY = y0;
    if (z0 < minZ) minZ = z0; if (z0 > maxZ) maxZ = z0;
    if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
    if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
    if (z1 < minZ) minZ = z1; if (z1 > maxZ) maxZ = z1;
    if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
    if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
    if (z2 < minZ) minZ = z2; if (z2 > maxZ) maxZ = z2;

    x0 -= ox; y0 -= oy; z0 -= oz;
    x1 -= ox; y1 -= oy; z1 -= oz;
    x2 -= ox; y2 -= oy; z2 -= oz;

    // Twice the triangle's area vector: (v1 − v0) × (v2 − v0)
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const wx = x2 - x0, wy = y2 - y0, wz = z2 - z0;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    area2 += Math.sqrt(nx * nx + ny * ny + nz * nz);
    vx += nx;
    vy += ny;
    vz += nz;

    // Six times the signed tetrahedron volume: v0 · (v1 × v2)
    volume6 += x0 * (y1 * z2 - z1 * y2) + y0 * (z1 * x2 - x1 * z2) + z0 * (x1 * y2 - y1 * x2);
  }

  bounds.min = [minX, minY, minZ];
  bounds.max = [maxX, maxY, maxZ];
  return {
    triangles,
    signedVolume: volume6 / 6,
    area: area2 / 2,
    vectorArea: Math.sqrt(vx * vx + vy * vy + vz * vz) / 2,
  };
}

// ---------------------------------------------------------------------------
// STL

function parseStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.byteLength;

  // Binary STL: 80-byte header, triangle count, 50 bytes per triangle.
  // Checked first because many binary files also start with "solid" in their header.
  if (size >= 84 && 84 + view.getUint32(80, true) * 50 === size) {
    return { format: 'stl-binary', meshes: [parseBinaryStl(view, view.getUint32(80, true))] };
  }
  if (looksLikeAsciiStl(bytes)) {
    return { format: 'stl-ascii', meshes: [parseAsciiStl(bytes)] };
  }
  if (size < 84) {
    throw new ModelError('stl.invalid');
  }
  const count = view.getUint32(80, true);
  if (count === 0) throw new ModelError('stl.noTriangles');
  if (count > MAX_STL_TRIANGLES) {
    throw new ModelError('stl.invalid');
  }
  const expected = 84 + count * 50;
  if (expected > size) {
    const available = Math.max(0, Math.floor((size - 84) / 50));
    throw new ModelError('stl.truncated', { count, available });
  }
  // A few exporters append extra bytes after the triangle data – those are ignored.
  return { format: 'stl-binary', meshes: [parseBinaryStl(view, count)] };
}

function parseBinaryStl(view, count) {
  const positions = new Float32Array(count * 9);
  let offset = 84;
  let p = 0;
  for (let i = 0; i < count; i++) {
    offset += 12; // skip the stored normal
    for (let k = 0; k < 9; k++) {
      positions[p++] = view.getFloat32(offset, true);
      offset += 4;
    }
    offset += 2; // attribute byte count
  }
  return { positions, indices: null, transform: null };
}

function looksLikeAsciiStl(bytes) {
  const head = utf8.decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
  // eslint-disable-next-line no-control-regex
  return /^\s*solid\b/i.test(head) && !/[\x00-\x08\x0e-\x1f]/.test(head);
}

function parseAsciiStl(bytes) {
  const text = utf8.decode(bytes);
  const positions = new GrowableArray(Float64Array, Math.max(1024, Math.floor(bytes.byteLength / 20)));
  const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)|endloop/gi;
  let loop = [];
  let sawEndloop = false;
  let match;

  const addPolygon = (coords) => {
    const n = coords.length / 3;
    if (n < 3) throw new ModelError('stl.badFace');
    for (let i = 1; i < n - 1; i++) {
      positions.push3(coords[0], coords[1], coords[2]);
      positions.push3(coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]);
      positions.push3(coords[3 * i + 3], coords[3 * i + 4], coords[3 * i + 5]);
    }
  };

  while ((match = pattern.exec(text)) !== null) {
    if (match[1] === undefined) {
      sawEndloop = true;
      addPolygon(loop);
      loop = [];
      continue;
    }
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new ModelError('stl.badCoordinates', { text: match[0].trim() });
    }
    loop.push(x, y, z);
  }

  if (loop.length > 0) {
    if (!sawEndloop && loop.length % 9 === 0) {
      for (const value of loop) positions.push(value); // no "endloop" at all: plain triangle list
    } else {
      throw new ModelError('stl.unfinished');
    }
  }
  if (positions.length === 0) throw new ModelError('stl.noTriangles');
  return { positions: positions.toArray(), indices: null, transform: null };
}

// ---------------------------------------------------------------------------
// OBJ

function parseObj(bytes) {
  const text = utf8.decode(bytes);
  const vertices = new GrowableArray(Float64Array, 4096);
  const indices = new GrowableArray(Uint32Array, 4096);
  let lineNumber = 0;
  let position = 0;

  while (position < text.length) {
    let end = text.indexOf('\n', position);
    if (end === -1) end = text.length;
    const line = text.slice(position, end).trim();
    position = end + 1;
    lineNumber += 1;
    if (line.length < 2 || line[0] === '#') continue;

    const keyword = line.slice(0, 2);
    if (keyword === 'v ' || keyword === 'v\t') {
      const parts = line.split(/\s+/);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (parts.length < 4 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new ModelError('obj.badVertex', { line: lineNumber });
      }
      vertices.push3(x, y, z);
    } else if (keyword === 'f ' || keyword === 'f\t') {
      const parts = line.split(/\s+/);
      const count = parts.length - 1;
      if (count < 3) {
        throw new ModelError('obj.badFace', { line: lineNumber });
      }
      const vertexCount = vertices.length / 3;
      const refs = new Array(count);
      for (let i = 0; i < count; i++) {
        const token = parts[i + 1];
        const slash = token.indexOf('/');
        const raw = Number(slash === -1 ? token : token.slice(0, slash));
        const index = raw > 0 ? raw - 1 : vertexCount + raw; // negative = relative to the end
        if (!Number.isInteger(raw) || raw === 0 || index < 0) {
          throw new ModelError('obj.badReference', { token, line: lineNumber });
        }
        refs[i] = index;
      }
      for (let i = 1; i < count - 1; i++) indices.push3(refs[0], refs[i], refs[i + 1]);
    }
  }

  if (indices.length === 0) throw new ModelError('obj.noFaces');
  const vertexCount = vertices.length / 3;
  const indexArray = indices.toArray();
  for (let i = 0; i < indexArray.length; i++) {
    if (indexArray[i] >= vertexCount) {
      throw new ModelError('obj.missingVertices');
    }
  }
  return { format: 'obj', meshes: [{ positions: vertices.toArray(), indices: indexArray, transform: null }] };
}

// ---------------------------------------------------------------------------
// 3MF (ZIP package with XML model parts)

async function parse3mf(bytes) {
  let zip;
  try {
    zip = openZip(bytes);
  } catch {
    throw new ModelError('3mf.notZip');
  }

  const rootPath = await findRootModelPath(zip);
  if (!rootPath) throw new ModelError('3mf.noModel');

  const models = new Map();
  const loadModel = async (partPath) => {
    const entry = zip.find(partPath);
    if (!entry) throw new ModelError('3mf.missingPart', { part: partPath });
    if (models.has(entry)) return models.get(entry);
    let xml;
    try {
      xml = await zip.readText(entry);
    } catch {
      throw new ModelError('3mf.unpack');
    }
    const model = parseModelXml(xml);
    models.set(entry, model);
    return model;
  };

  const root = await loadModel(rootPath);
  const unitScale = UNIT_TO_MM[root.unit];
  if (unitScale === undefined) throw new ModelError('3mf.unknownUnit', { unit: root.unit });

  const meshes = [];
  const addObject = async (partPath, objectId, transform, depth) => {
    if (depth > MAX_COMPONENT_DEPTH) {
      throw new ModelError('3mf.tooDeep');
    }
    const model = await loadModel(partPath);
    const object = model.objects.get(objectId);
    if (!object) throw new ModelError('3mf.missingObject', { id: objectId });
    if (!PRINTABLE_OBJECT_TYPES.has(object.type)) return; // support/surface/other objects are not part of the print
    if (object.mesh) meshes.push({ ...object.mesh, transform });
    for (const component of object.components) {
      await addObject(component.path ?? partPath, component.objectId, composeTransforms(component.transform, transform), depth + 1);
    }
  };

  let objectCount = 0;
  for (const item of root.items) {
    if (!item.printable) continue;
    objectCount += 1;
    await addObject(item.path ?? rootPath, item.objectId, item.transform, 0);
  }
  if (objectCount === 0) throw new ModelError('3mf.noPrintable');
  return { format: '3mf', meshes, unitScale, objectCount };
}

async function findRootModelPath(zip) {
  const rels = zip.find('_rels/.rels');
  if (rels) {
    let xml = '';
    try {
      xml = await zip.readText(rels);
    } catch {
      // fall back to the default location below
    }
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
      const attributes = parseAttributes(match[1]);
      if (/\/3dmodel$/i.test(attributes.Type ?? '') && attributes.Target) {
        const target = decodeEntities(attributes.Target);
        if (zip.find(target)) return target;
      }
    }
  }
  const fallback =
    zip.entries.find((entry) => /^\/?3D\/[^/]+\.model$/i.test(entry.name)) ??
    zip.entries.find((entry) => /\.model$/i.test(entry.name));
  return fallback?.name ?? null;
}

// <prefix:name attributes/> – quoted attribute values may contain ">" and "/".
const TAG_PATTERN = /<(\/)?(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)((?:[^>"'/]+|"[^"]*"|'[^']*'|\/(?!>))*)(\/)?>/g;
const ATTRIBUTE_PATTERN = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Reads the parts of a 3MF model XML that matter for measuring: unit, objects, build items. */
function parseModelXml(source) {
  let xml = source;
  if (xml.includes('<!--')) xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (xml.includes('<![CDATA[')) xml = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  const result = { unit: 'millimeter', objects: new Map(), items: [] };
  let seenModel = false;
  let corePrefix; // core elements use the same prefix as <model> (normally none)
  let object = null;
  let vertices = null;
  let triangles = null;
  let inBuild = false;

  TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAG_PATTERN.exec(xml)) !== null) {
    const closing = match[1] === '/';
    const prefix = match[2];
    const name = match[3];
    const selfClosing = match[5] === '/';

    if (!seenModel) {
      if (name === 'model' && !closing) {
        seenModel = true;
        corePrefix = prefix;
        const unit = parseAttributes(match[4]).unit;
        if (unit) result.unit = unit.trim().toLowerCase();
      }
      continue;
    }
    if (prefix !== corePrefix) continue; // element of an extension namespace

    switch (name) {
      case 'object': {
        if (closing) {
          object = null;
          break;
        }
        const attributes = parseAttributes(match[4]);
        const id = attributes.id !== undefined ? decodeEntities(attributes.id).trim() : '';
        if (!id) throw new ModelError('3mf.objectWithoutId');
        object = { id, type: (attributes.type ?? 'model').toLowerCase(), mesh: null, components: [] };
        result.objects.set(id, object);
        if (selfClosing) object = null;
        break;
      }
      case 'mesh':
        if (!object) break;
        if (!closing) {
          vertices = new GrowableArray(Float64Array, 1024);
          triangles = new GrowableArray(Uint32Array, 1024);
        }
        if (closing || selfClosing) {
          object.mesh = finishMesh(vertices, triangles);
          vertices = null;
          triangles = null;
        }
        break;
      case 'vertex': {
        // Hot path (millions of vertices): read x/y/z directly instead of building an attribute object.
        if (!vertices || closing) break;
        readTriple(match[4], VERTEX_ATTRIBUTES, 'x', 'y', 'z');
        const [x, y, z] = triple;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new ModelError('3mf.badCoordinates');
        }
        vertices.push3(x, y, z);
        break;
      }
      case 'triangle': {
        if (!triangles || closing) break;
        readTriple(match[4], TRIANGLE_ATTRIBUTES, 'v1', 'v2', 'v3');
        triangles.push3(toIndex(triple[0]), toIndex(triple[1]), toIndex(triple[2]));
        break;
      }
      case 'component': {
        if (!object || closing) break;
        const a = parseAttributes(match[4]);
        object.components.push({
          objectId: requireObjectId(a.objectid),
          transform: parseTransform(a.transform),
          path: findPathAttribute(a),
        });
        break;
      }
      case 'build':
        inBuild = !closing && !selfClosing;
        break;
      case 'item': {
        if (!inBuild || closing) break;
        const a = parseAttributes(match[4]);
        result.items.push({
          objectId: requireObjectId(a.objectid),
          transform: parseTransform(a.transform),
          path: findPathAttribute(a),
          printable: a.printable !== '0' && a.printable !== 'false',
        });
        break;
      }
      default:
        break;
    }
  }

  if (!seenModel) throw new ModelError('3mf.noModelElement');
  return result;
}

const VERTEX_ATTRIBUTES = /(?:^|\s)([xyz])\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TRIANGLE_ATTRIBUTES = /(?:^|\s)(v[123])\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const triple = [Number.NaN, Number.NaN, Number.NaN];

/** Reads three numeric attributes into `triple` (NaN when missing). */
function readTriple(text, pattern, first, second, third) {
  triple[0] = Number.NaN;
  triple[1] = Number.NaN;
  triple[2] = Number.NaN;
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[2] ?? match[3];
    const value = raw.trim() === '' ? Number.NaN : Number(raw);
    if (match[1] === first) triple[0] = value;
    else if (match[1] === second) triple[1] = value;
    else if (match[1] === third) triple[2] = value;
  }
}

function finishMesh(vertices, triangles) {
  const positions = vertices.toArray();
  const indices = triangles.toArray();
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) {
      throw new ModelError('3mf.missingVertex');
    }
  }
  return { positions, indices };
}

function toIndex(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new ModelError('3mf.badTriangle');
  }
  return index;
}

function requireObjectId(value) {
  const id = value === undefined ? '' : decodeEntities(value).trim();
  if (!id) throw new ModelError('3mf.referenceWithoutId');
  return id;
}

/** Production extension: `p:path` points to another model part inside the package. */
function findPathAttribute(attributes) {
  for (const [key, value] of Object.entries(attributes)) {
    if (/:path$/.test(key) && value) return decodeEntities(value);
  }
  return undefined;
}

function parseTransform(text) {
  if (text === undefined) return null;
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || !values.every(Number.isFinite)) {
    throw new ModelError('3mf.badTransform');
  }
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  return values.every((value, i) => value === identity[i]) ? null : values;
}

/** Combines two 3MF transforms: `inner` is applied first, then `outer`. */
function composeTransforms(inner, outer) {
  if (!inner) return outer;
  if (!outer) return inner;
  const result = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = row === 3 ? outer[9 + col] : 0;
      for (let k = 0; k < 3; k++) sum += inner[row * 3 + k] * outer[k * 3 + col];
      result[row * 3 + col] = sum;
    }
  }
  return result;
}

function parseAttributes(text) {
  const attributes = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_PATTERN.exec(text)) !== null) {
    attributes[match[1]] = match[2] ?? match[3];
  }
  return attributes;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

// ---------------------------------------------------------------------------
// Helpers

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected an ArrayBuffer or Uint8Array');
}

/** Typed array that grows as values are pushed. */
class GrowableArray {
  constructor(Type, capacity) {
    this.Type = Type;
    this.data = new Type(capacity);
    this.length = 0;
  }

  push(value) {
    if (this.length === this.data.length) this.grow();
    this.data[this.length++] = value;
  }

  push3(a, b, c) {
    if (this.length + 3 > this.data.length) this.grow();
    const data = this.data;
    data[this.length] = a;
    data[this.length + 1] = b;
    data[this.length + 2] = c;
    this.length += 3;
  }

  grow() {
    const next = new this.Type(Math.max(this.data.length * 2, 16));
    next.set(this.data);
    this.data = next;
  }

  toArray() {
    return this.data.subarray(0, this.length);
  }
}

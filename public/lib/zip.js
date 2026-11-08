// Minimal ZIP reader – just enough for 3MF packages.
// Supports stored and deflated entries and ZIP64 sizes/offsets.
// No encryption, no multi-disk archives.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;
const MAX_COMMENT = 0xffff;

const utf8 = new TextDecoder('utf-8');

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * Opens a ZIP archive held in memory.
 * @param {Uint8Array} bytes
 */
export function openZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  let count = view.getUint16(end + 10, true);
  let directoryOffset = view.getUint32(end + 16, true);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || view.getUint32(locator, true) !== SIG_END64_LOCATOR) {
      throw new ZipError('ZIP64-Verzeichnis fehlt.');
    }
    const end64 = toSafeNumber(view.getBigUint64(locator + 8, true));
    if (end64 + 56 > view.byteLength || view.getUint32(end64, true) !== SIG_END64) {
      throw new ZipError('ZIP64-Verzeichnis ist beschädigt.');
    }
    count = toSafeNumber(view.getBigUint64(end64 + 32, true));
    directoryOffset = toSafeNumber(view.getBigUint64(end64 + 48, true));
  }

  const entries = [];
  const byName = new Map();
  let p = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError('Das Inhaltsverzeichnis des Archivs ist beschädigt.');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    let localOffset = view.getUint32(p + 42, true);
    const nameStart = p + 46;
    if (nameStart + nameLength + extraLength > view.byteLength) {
      throw new ZipError('Das Inhaltsverzeichnis des Archivs ist abgeschnitten.');
    }
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));

    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      // ZIP64 "extended information" extra field
      let e = nameStart + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = view.getUint16(e, true);
        const length = view.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = toSafeNumber(view.getBigUint64(q, true)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = toSafeNumber(view.getBigUint64(q, true)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = toSafeNumber(view.getBigUint64(q, true)); }
          break;
        }
        e += 4 + length;
      }
    }

    const entry = { name, flags, method, compressedSize, size, localOffset };
    entries.push(entry);
    byName.set(normalizeName(name), entry);
    p = nameStart + nameLength + extraLength + commentLength;
  }

  return {
    entries,
    /** Finds an entry by part name; leading "/", percent-escapes and case are ignored. */
    find(name) {
      return byName.get(normalizeName(name)) ?? null;
    },
    read(entry) {
      return readEntry(bytes, view, entry);
    },
    async readText(entry) {
      return utf8.decode(await readEntry(bytes, view, entry));
    },
  };
}

function findEndOfCentralDirectory(view) {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let i = last; i >= first; i--) {
    if (view.getUint32(i, true) === SIG_END) return i;
  }
  throw new ZipError('Die Datei ist kein ZIP-Archiv.');
}

async function readEntry(bytes, view, entry) {
  if (entry.flags & 0x1) throw new ZipError('Das Archiv ist verschlüsselt.');
  const p = entry.localOffset;
  if (p + 30 > view.byteLength || view.getUint32(p, true) !== SIG_LOCAL) {
    throw new ZipError('Ein Eintrag im Archiv ist beschädigt.');
  }
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new ZipError('Das Archiv ist abgeschnitten.');
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new ZipError(`Die Kompressionsmethode ${entry.method} wird nicht unterstützt.`);
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError('Dieser Browser kann keine komprimierten Dateien entpacken.');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function normalizeName(name) {
  let normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // keep the raw name if it contains a stray "%"
  }
  return normalized.toLowerCase();
}

function toSafeNumber(big) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('Das Archiv ist zu groß.');
  return Number(big);
}

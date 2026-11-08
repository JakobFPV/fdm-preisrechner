// HTTP server: serves the web app from /public and a small JSON API for the stored settings.
// Meant for local use only: it answers only requests addressed to localhost.
// Messages are in the language the page asks for (Accept-Language), else in the stored language.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { normalizeLanguage, t } from '../public/lib/i18n.js';
import { createStore, StoreError } from './store.js';

export const APP_ID = 'fdm-preisrechner';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_BODY_BYTES = 64 * 1024;

/** Error with a dictionary key; translated when the response is sent. */
class HttpError extends Error {
  constructor(status, code, params = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/**
 * Creates the HTTP server (not yet listening) together with its settings store.
 * @param {{dataDir: string, publicDir: string, logLanguage?: 'de'|'en'}} options
 */
export function createAppServer({ dataDir, publicDir, logLanguage = 'de' }) {
  const store = createStore(dataDir, { logLanguage });
  const root = path.resolve(publicDir);
  const server = http.createServer((req, res) => {
    const lang = requestLanguage(req, store);
    handleRequest(req, res, store, root, lang).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: t(lang, error.code, error.params) });
      } else if (error instanceof StoreError) {
        sendJson(res, error.status, { error: error.message, ...(error.errors ? { errors: error.errors } : {}) });
      } else {
        console.error(error);
        sendJson(res, 500, { error: t(lang, 'http.internal', { message: error.message }) });
      }
    });
  });
  return { server, store };
}

/** First language of the Accept-Language header if supported, else the stored one, else German. */
function requestLanguage(req, store) {
  const first = String(req.headers['accept-language'] ?? '').split(',')[0];
  return normalizeLanguage(first) ?? store.language() ?? 'de';
}

async function handleRequest(req, res, store, publicDir, lang) {
  // Rejecting other host names protects against DNS rebinding from websites.
  if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host))) throw new HttpError(403, 'http.localOnly');
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, pathname, store, lang);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'http.methodNotAllowed');
  return serveStatic(req, res, pathname, publicDir, lang);
}

// ---------------------------------------------------------------------------
// API

async function handleApi(req, res, pathname, store, lang) {
  const { method } = req;
  if (method !== 'GET' && method !== 'HEAD') checkWriteRequest(req);

  if (method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { app: APP_ID });
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, store.getState());
  if (method === 'PUT' && pathname === '/api/settings/general') {
    return sendJson(res, 200, { settings: store.updateGeneral(await readJson(req), lang) });
  }
  if (method === 'PUT' && pathname === '/api/settings/language') {
    const body = await readJson(req);
    return sendJson(res, 200, { settings: store.setLanguage(body?.language, lang) });
  }
  if (method === 'PUT' && pathname === '/api/last-print') {
    return sendJson(res, 200, { lastPrint: store.setLastPrint(await readJson(req), lang) });
  }

  const collection = /^\/api\/(printers|materials)$/.exec(pathname);
  if (collection && method === 'POST') {
    return sendJson(res, 201, store.addItem(collection[1], await readJson(req), lang));
  }
  const member = /^\/api\/(printers|materials)\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  if (member && method === 'PUT') {
    return sendJson(res, 200, store.updateItem(member[1], member[2], await readJson(req), lang));
  }
  if (member && method === 'DELETE') return sendJson(res, 200, store.deleteItem(member[1], member[2], lang));

  throw new HttpError(404, 'http.unknownApi');
}

/**
 * Writes must come from the app itself: same origin (if the browser sends one) and JSON.
 * Other websites cannot send JSON cross-origin without a CORS preflight, which is never allowed here.
 */
function checkWriteRequest(req) {
  const { origin } = req.headers;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'http.foreignOrigin');
  const type = req.headers['content-type'] ?? '';
  if ((req.method === 'POST' || req.method === 'PUT') && !/^application\/json\b/i.test(type)) {
    throw new HttpError(415, 'http.jsonRequired');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'http.tooLarge'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'http.badJson'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Static files

async function serveStatic(req, res, pathname, publicDir, lang) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'http.badPath');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = path.join(publicDir, relative);
  if (!filePath.startsWith(publicDir + path.sep)) return sendNotFound(res, lang);

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) return sendNotFound(res, lang);

  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
}

function sendNotFound(res, lang) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(t(lang, 'http.notFound'));
}

function hostnameOf(host) {
  if (typeof host !== 'string') return '';
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

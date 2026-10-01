#!/usr/bin/env node
/**
 * Lightweight local web UI for Seyenna manpower reconciliation.
 * Pure Node.js http — no npm dependencies.
 *
 *   node src/server.js
 *   open http://localhost:3847
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runReconcile } = require('../lib/reconcile-core');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return send(res, 404, 'Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const data = fs.readFileSync(filePath);
  send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
}

/** Minimal multipart/form-data parser for file fields + text fields. */
function parseMultipart(buf, boundary) {
  const parts = {};
  const sep = Buffer.from('--' + boundary);
  let start = indexOf(buf, sep, 0);
  while (start !== -1) {
    let next = indexOf(buf, sep, start + sep.length);
    let sliceEnd = next === -1 ? buf.length : next;
    let part = buf.slice(start + sep.length, sliceEnd);
    // strip leading CRLF and trailing CRLF / --
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.slice(2);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }
    if (part.toString('utf8', 0, 2) === '--') break;

    const headerEnd = indexOf(part, Buffer.from('\r\n\r\n'), 0);
    if (headerEnd === -1) {
      start = next;
      continue;
    }
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);
    const nameM = headerText.match(/name="([^"]+)"/i);
    const fileM = headerText.match(/filename="([^"]*)"/i);
    if (!nameM) {
      start = next;
      continue;
    }
    const name = nameM[1];
    if (fileM) {
      parts[name] = { filename: fileM[1], data: body };
    } else {
      parts[name] = body.toString('utf8');
    }
    start = next;
  }
  return parts;
}

function indexOf(buf, needle, from) {
  for (let i = from; i <= buf.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleCompare(req, res) {
  try {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return sendJson(res, 400, { ok: false, error: 'Expected multipart/form-data' });
    const boundary = (m[1] || m[2]).trim();
    const body = await readBody(req);
    const parts = parseMultipart(body, boundary);

    const need = [
      ['status', 'Employee_Status'],
      ['pmta', 'Allocation_PMTA'],
      ['mfg', 'Allocation_Manufacturing'],
    ];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seyenna_upload_'));
    const outDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outDir, { recursive: true });

    const paths = {};
    for (const [field, label] of need) {
      const f = parts[field];
      if (!f || !f.data || !f.filename) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return sendJson(res, 400, { ok: false, error: `Missing upload: ${label} (${field})` });
      }
      const safe = label + path.extname(f.filename || '.xlsx') || '.xlsx';
      const dest = path.join(tmpDir, safe);
      fs.writeFileSync(dest, f.data);
      paths[field] = dest;
    }

    const result = runReconcile({
      statusPath: paths.status,
      pmtaPath: paths.pmta,
      mfgPath: paths.mfg,
      outDir,
    });

    // Persist last run under project output/ so downloads are stable
    const stableOut = path.join(ROOT, 'output');
    fs.mkdirSync(stableOut, { recursive: true });
    for (const name of ['report.html', 'report.xlsx', 'mismatches.csv', 'matches.csv', 'summary.json']) {
      const src = path.join(outDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stableOut, name));
    }

    // Also keep a copy of HTML for inline embed
    const reportHtml = fs.readFileSync(path.join(stableOut, 'report.html'), 'utf8');

    sendJson(res, 200, {
      ok: true,
      summary: result.summary,
      downloads: {
        reportHtml: '/download/report.html',
        reportXlsx: '/download/report.xlsx',
        mismatches: '/download/mismatches.csv',
        matches: '/download/matches.csv',
        summary: '/download/summary.json',
      },
      reportHtml,
    });

    // cleanup uploads (keep stable output/)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveFile(res, path.join(PUBLIC, 'index.html'));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
    const rel = url.pathname.slice('/static/'.length);
    return serveFile(res, path.join(PUBLIC, path.basename(rel)));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
    const name = path.basename(url.pathname);
    const allowed = new Set(['report.html', 'report.xlsx', 'mismatches.csv', 'matches.csv', 'summary.json']);
    if (!allowed.has(name)) return send(res, 404, 'Not found');
    const fp = path.join(ROOT, 'output', name);
    if (!fs.existsSync(fp)) return send(res, 404, 'No report yet — run Compare first');
    const disposition = `attachment; filename="${name}"`;
    const data = fs.readFileSync(fp);
    return send(res, 200, data, {
      'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
      'Content-Disposition': disposition,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/compare') {
    return handleCompare(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, port: PORT });
  }
  send(res, 404, 'Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Seyenna PMTA Module UI`);
  console.log(`Open:  http://localhost:${PORT}`);
  console.log(`Bind:  http://${HOST}:${PORT}`);
  console.log(`Stop:  Ctrl+C`);
});

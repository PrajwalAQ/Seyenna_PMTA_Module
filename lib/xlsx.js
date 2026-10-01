/**
 * Lightweight OOXML (.xlsx) reader — unzip + sharedStrings + sheet XML.
 * No npm dependencies. Supports shared strings, inline strings, and numeric cells.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unzipTo(xlsx, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execSync(`unzip -o -q "${xlsx}" -d "${dest}"`, { stdio: 'pipe' });
}

function parseSharedStrings(sstPath) {
  if (!fs.existsSync(sstPath)) return [];
  const xml = fs.readFileSync(sstPath, 'utf8');
  const strings = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]));
    strings.push(texts.join(''));
  }
  return strings;
}

function parseSheet(sheetPath, strings) {
  const xml = fs.readFileSync(sheetPath, 'utf8');
  const rows = new Map();
  const rowRe = /<row[^>]* r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const r = Number(rm[1]);
    const cells = {};
    const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>(?:[\s\S]*?<v>([\s\S]*?)<\/v>)?/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const col = cm[1];
      const attrs = cm[3] || '';
      let val = cm[4] != null ? cm[4] : '';
      if (/t="s"/.test(attrs) && val !== '') {
        val = strings[Number(val)] ?? '';
      } else if (/t="inlineStr"/.test(attrs)) {
        const im = rm[2].match(
          new RegExp(`<c r="${col}${r}"[^>]*>[\\s\\S]*?<t[^>]*>([\\s\\S]*?)<\\/t>`)
        );
        val = im ? decodeXml(im[1]) : '';
      }
      cells[colToIndex(col)] = val;
    }
    rows.set(r, cells);
  }
  if (rows.size === 0) return [];
  const maxR = Math.max(...rows.keys());
  let maxC = 0;
  for (const cellMap of rows.values()) {
    for (const c of Object.keys(cellMap)) maxC = Math.max(maxC, Number(c));
  }
  const out = [];
  for (let r = 1; r <= maxR; r++) {
    const cellMap = rows.get(r) || {};
    const arr = [];
    for (let c = 0; c <= maxC; c++) arr.push(cellMap[c] != null ? String(cellMap[c]) : '');
    out.push(arr);
  }
  return out;
}

/**
 * Read an .xlsx workbook into { sheetName: string[][] }.
 * Only real worksheet sheets are returned (defined names / filter databases skipped).
 */
function readWorkbook(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`File not found: ${xlsxPath}`);
  }
  const dest = path.join(
    os.tmpdir(),
    'seyenna_xlsx_' + path.basename(xlsxPath).replace(/\W+/g, '_') + '_' + process.pid
  );
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    unzipTo(xlsxPath, dest);
    const wbXml = fs.readFileSync(path.join(dest, 'xl/workbook.xml'), 'utf8');
    const relsXml = fs.readFileSync(path.join(dest, 'xl/_rels/workbook.xml.rels'), 'utf8');

    const ridToTarget = {};
    for (const m of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) {
      ridToTarget[m[1]] = m[2];
    }
    for (const m of relsXml.matchAll(/Target="([^"]+)"[^>]*Id="(rId\d+)"/g)) {
      ridToTarget[m[2]] = m[1];
    }

    const sheets = [];
    for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
      const attrs = m[1];
      const nameM = attrs.match(/\bname="([^"]+)"/);
      const ridM = attrs.match(/\br:id="(rId\d+)"/);
      if (!nameM || !ridM) continue;
      const name = decodeXml(nameM[1]);
      // Skip Excel defined-name pseudo sheets
      if (name.startsWith('_xlnm.') || name.startsWith('microsoft.com:')) continue;
      sheets.push({ name, rid: ridM[1] });
    }

    const strings = parseSharedStrings(path.join(dest, 'xl/sharedStrings.xml'));
    const result = {};
    for (const s of sheets) {
      let target = ridToTarget[s.rid];
      if (!target) continue;
      if (target.startsWith('/')) {
        target = path.join(dest, target.replace(/^\//, ''));
      } else {
        target = path.join(dest, 'xl', target);
      }
      if (!fs.existsSync(target)) {
        target = path.join(dest, 'xl', ridToTarget[s.rid]);
      }
      if (!fs.existsSync(target)) continue;
      result[s.name] = parseSheet(target, strings);
    }
    return result;
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

module.exports = { readWorkbook, decodeXml };

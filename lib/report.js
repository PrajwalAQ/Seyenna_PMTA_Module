/**
 * CSV / HTML / JSON report writers for reconciliation results.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeXlsx } = require('./xlsx-write');

const MISMATCH_COLUMNS = [
  'Category',
  'EmployeeID',
  'Name',
  'Detail',
  'StatusDept',
  'StatusSubDept',
  'StatusLocation',
  'AllocSource',
  'AllocDept',
  'AllocLocation',
  'AllocPlanning',
  'Notes',
];

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function groupByCategory(mismatches) {
  const g = {};
  for (const m of mismatches) {
    (g[m.Category] || (g[m.Category] = [])).push(m);
  }
  return g;
}

function renderTable(rows, columns, limit = 500) {
  if (!rows.length) return '<p class="empty">None</p>';
  const show = rows.slice(0, limit);
  let html = '<table><thead><tr>';
  for (const c of columns) html += `<th>${escHtml(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (const r of show) {
    html += '<tr>';
    for (const c of columns) {
      const cls = c === 'Detail' || c === 'Notes' ? ' class="detail"' : '';
      html += `<td${cls}>${escHtml(r[c] ?? '')}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (rows.length > limit) {
    html += `<p class="note">Showing ${limit} of ${rows.length} rows — see mismatches.csv for full list.</p>`;
  }
  return html;
}


function renderCountCheckTable(countCheck) {
  if (!countCheck || !countCheck.rows || !countCheck.rows.length) {
    return '<p class="note">Count check not available.</p>';
  }
  const cols = [
    'Department',
    'Location / bucket',
    'Status count',
    'Allocation count',
    'Difference',
    'Match?',
    'Alloc source',
    'Notes',
  ];
  const field = [
    'Department',
    'LocationBucket',
    'StatusCount',
    'AllocationCount',
    'Difference',
    'Match',
    'AllocSource',
    'Notes',
  ];
  let html = '<div class="count-check-wrap"><table class="count-check"><thead><tr>';
  for (const c of cols) html += '<th>' + escHtml(c) + '</th>';
  html += '</tr></thead><tbody>';
  for (const r of countCheck.rows) {
    const cls = [
      r.isMismatch ? 'mismatch' : '',
      r.isTotal ? 'total-row' : '',
      r.Match === 'YES' ? 'match-yes' : '',
    ]
      .filter(Boolean)
      .join(' ');
    html += '<tr class="' + cls + '">';
    for (const f of field) {
      let val = r[f];
      if (f === 'Match') {
        if (r.Match === 'YES') val = '✓ YES';
        else if (r.Match === 'NO') val = '✗ NO';
      }
      html += '<td>' + escHtml(val ?? '') + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  const st = countCheck.stats || {};
  html +=
    '<p class="note">Buckets matched: <strong>' +
    (st.bucketsMatched || 0) +
    '</strong> · mismatched: <strong>' +
    (st.bucketsMismatched || 0) +
    '</strong> · PMTA Status total ' +
    (st.pmtaStatusTotal || 0) +
    ' vs Alloc ' +
    (st.pmtaAllocTotal || 0) +
    ' · MFU Status ' +
    (st.mfuStatusTotal || 0) +
    ' vs MFG (non-PMTA) ' +
    (st.mfgAllocNonPmta || 0) +
    (countCheck.parsedSummaryFound ? ' · Status sheet Summary blocks detected' : '') +
    '</p>';
  return html;
}

function buildHtml(result) {
  const { summary, mismatches, matches, meta, countCheck } = result;
  const grouped = groupByCategory(mismatches);
  const generated = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Calcutta' });

  const countCards = Object.entries(summary.categories || {})
    .map(
      ([k, v]) =>
        `<div class="card ${v ? 'warn' : 'ok'}"><div class="n">${v}</div><div class="l">${escHtml(k)}</div></div>`
    )
    .join('\n');

  const sections = Object.keys(grouped)
    .sort()
    .map((cat) => {
      const rows = grouped[cat];
      return `
<section>
  <h2>${escHtml(cat)} <span class="badge">${rows.length}</span></h2>
  ${renderTable(rows, MISMATCH_COLUMNS)}
</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Seyenna Manpower Reconciliation Report</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --warn:#fbbf24; --bad:#f87171; --ok:#4ade80; --border:#334155; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin:0; background:var(--bg); color:var(--text); line-height:1.45; }
  header { padding: 1.5rem 2rem; border-bottom:1px solid var(--border); background:linear-gradient(180deg,#1e293b, #0f172a); }
  header h1 { margin:0 0 .35rem; font-size:1.5rem; }
  header p { margin:.2rem 0; color:var(--muted); font-size:.9rem; }
  main { padding: 1.5rem 2rem 3rem; max-width: 1400px; margin:0 auto; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill,minmax(180px,1fr)); gap:.75rem; margin:1rem 0 1.5rem; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:1rem; }
  .card .n { font-size:1.6rem; font-weight:700; }
  .card .l { font-size:.75rem; color:var(--muted); margin-top:.25rem; word-break:break-word; }
  .card.warn .n { color:var(--warn); }
  .card.ok .n { color:var(--ok); }
  .card.meta .n { color:var(--accent); font-size:1.1rem; }
  h2 { margin:2rem 0 .75rem; font-size:1.15rem; display:flex; align-items:center; gap:.5rem; }
  .badge { background:#334155; color:var(--warn); font-size:.8rem; padding:.15rem .5rem; border-radius:999px; }
  table { width:100%; border-collapse:collapse; font-size:.82rem; background:var(--card); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  th, td { padding:.45rem .55rem; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
  th { background:#0b1220; color:var(--muted); font-weight:600; position:sticky; top:0; white-space:nowrap; }
  tr:hover td { background:#243247; }
  td.detail { color:#fecaca; max-width:320px; }
  .empty { color:var(--ok); }
  .note { color:var(--muted); font-size:.85rem; }
  .meta-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.8rem; }
  footer { color:var(--muted); font-size:.8rem; margin-top:2rem; }
  .count-check-wrap { overflow-x:auto; margin:.5rem 0 1rem; }
  table.count-check tr.mismatch td { background:#3f1d1d; color:#fecaca; }
  table.count-check tr.mismatch td:nth-child(6) { color:#f87171; font-weight:700; }
  table.count-check tr.match-yes td:nth-child(6) { color:var(--ok); font-weight:600; }
  table.count-check tr.total-row td { font-weight:700; background:#0b1220; border-top:2px solid var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Seyenna Manpower Reconciliation</h1>
  <p>Generated: ${escHtml(generated)} (Asia/Calcutta)</p>
  <p class="meta-line">Status sheet: ${escHtml(meta.statusSheet)} · PMTA sheet: ${escHtml(meta.pmtaSheet)} · MFG sheet: ${escHtml(meta.mfgSheet)}</p>
  <p class="meta-line">Files — Status: ${escHtml(meta.statusFile)} · PMTA: ${escHtml(meta.pmtaFile)} · MFG: ${escHtml(meta.mfgFile)}</p>
</header>
<main>
  <h2>Summary counts</h2>
  <div class="grid">
    <div class="card meta"><div class="n">${summary.statusCount}</div><div class="l">Status employees</div></div>
    <div class="card meta"><div class="n">${summary.pmtaCount}</div><div class="l">PMTA allocation</div></div>
    <div class="card meta"><div class="n">${summary.mfgCount}</div><div class="l">MFG allocation (latest)</div></div>
    <div class="card ok"><div class="n">${summary.pmtaMatched}</div><div class="l">PMTA matched (Status ∩ PMTA, fields OK)</div></div>
    <div class="card ok"><div class="n">${summary.mfgMatched}</div><div class="l">MFG matched (Status ∩ MFG, fields OK)</div></div>
    <div class="card warn"><div class="n">${mismatches.length}</div><div class="l">Total mismatch rows</div></div>
    ${countCards}
  </div>

  <section>
    <h2>Summary count check (Status vs Allocations) <span class="badge">${(countCheck && countCheck.stats && countCheck.stats.bucketsMismatched) || 0} off</span></h2>
    <p class="note">Compares Status department/location bucket counts with PMTA and Manufacturing allocation counts. Difference = Status − Allocation. Rows with Difference ≠ 0 are highlighted.</p>
    ${renderCountCheckTable(countCheck)}
  </section>

  ${sections || '<p class="empty">No mismatches found.</p>'}

  <section>
    <h2>Matches sample <span class="badge">${matches.length}</span></h2>
    <p class="note">Full list in matches.csv</p>
    ${renderTable(
      matches.slice(0, 50),
      ['EmployeeID', 'Name', 'Scope', 'StatusDept', 'StatusSubDept', 'StatusLocation', 'AllocDept', 'AllocLocation', 'AllocPlanning'],
      50
    )}
  </section>

  <footer>Seyenna PMTA Module · Node.js reconciler · outputs also written as mismatches.csv, matches.csv, summary.json</footer>
</main>
</body>
</html>
`;
}

function writeReports(outDir, result) {
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'report.html');
  const mismPath = path.join(outDir, 'mismatches.csv');
  const matchPath = path.join(outDir, 'matches.csv');
  const sumPath = path.join(outDir, 'summary.json');
  const xlsxPath = path.join(outDir, 'report.xlsx');

  fs.writeFileSync(htmlPath, buildHtml(result), 'utf8');
  fs.writeFileSync(mismPath, toCsv(result.mismatches, MISMATCH_COLUMNS), 'utf8');

  const matchCols = [
    'EmployeeID',
    'Name',
    'Scope',
    'StatusDept',
    'StatusSubDept',
    'StatusLocation',
    'AllocSource',
    'AllocDept',
    'AllocLocation',
    'AllocPlanning',
    'Notes',
  ];
  fs.writeFileSync(matchPath, toCsv(result.matches, matchCols), 'utf8');
  fs.writeFileSync(sumPath, JSON.stringify(result.summary, null, 2) + '\n', 'utf8');

  const summary = result.summary || {};
  const summaryRows = [
    ['Metric', 'Value'],
    ['Generated At', summary.generatedAt || ''],
    ['Status employees', summary.statusCount],
    ['PMTA allocation', summary.pmtaCount],
    ['MFG allocation', summary.mfgCount],
    ['Status sheet', summary.statusSheet || ''],
    ['PMTA sheet', summary.pmtaSheet || ''],
    ['MFG sheet', summary.mfgSheet || ''],
    ['PMTA matched', summary.pmtaMatched],
    ['MFG matched', summary.mfgMatched],
    ['Total mismatch rows', summary.totalMismatches],
    [],
    ['Category', 'Count'],
  ];
  for (const [k, v] of Object.entries(summary.categories || {})) {
    summaryRows.push([k, v]);
  }

  const mismRows = [MISMATCH_COLUMNS.slice()];
  for (const row of result.mismatches) {
    mismRows.push(MISMATCH_COLUMNS.map((c) => row[c] ?? ''));
  }

  const matchRows = [matchCols.slice()];
  for (const row of result.matches) {
    matchRows.push(matchCols.map((c) => row[c] ?? ''));
  }

  const cc = result.countCheck || { columns: [], rows: [] };
  const ccCols = [
    'Department',
    'LocationBucket',
    'StatusCount',
    'AllocationCount',
    'Difference',
    'Match',
    'AllocSource',
    'Notes',
  ];
  const ccRows = [ccCols.slice()];
  for (const row of cc.rows || []) {
    ccRows.push(ccCols.map((c) => (row[c] != null ? row[c] : '')));
  }

  writeXlsx(xlsxPath, [
    { name: 'Summary', rows: summaryRows },
    { name: 'Count Check', rows: ccRows },
    { name: 'Mismatches', rows: mismRows },
    { name: 'Matches', rows: matchRows },
  ]);

  return { htmlPath, mismPath, matchPath, sumPath, xlsxPath };
}

module.exports = { writeReports, MISMATCH_COLUMNS, toCsv };

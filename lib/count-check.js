/**
 * Summary count check: Status location/dept buckets vs PMTA & MFG allocations.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { normText } = require('./loaders');

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Normalize location/bucket labels for fuzzy matching. */
function normLoc(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\u00A0/g, ' ')
    .replace(/[\/\-_,.]+/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\bELITE\s*X\b/g, 'ELITEX')
    .replace(/\bMADINAH\b/g, 'MADINA')
    .replace(/\bVACCATION\b/g, 'VACATION')
    .replace(/\bMANUFACTURING\s+OFFICE\b/g, 'MANUFACTURING OFFICE')
    .replace(/\bMANUFACTURING\s+YARD\b/g, 'MANUFACTURING YARD')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extra Status→Alloc aliases (normalized keys). */
const LOC_ALIASES = {
  BOOKED: ['CAMP', 'BOOKED'],
  'SEYANA MANUFACTURING': ['MANUFACTURING YARD', 'SEYANA MANUFACTURING'],
  'MANUFACTURING OFFICE': ['MANUFACTURING OFFICE'],
  'ELITEX RASTANURA': ['ELITEX RASTANURA'],
  'ELITEX JIZAN': ['ELITEX JIZAN'],
  'ELITEX MADINA': ['ELITEX MADINA'],
  'KANOOZ MADINA': ['KANOOZ MADINA'],
  VACATION: ['VACATION'],
};

function aliasKeys(normKey) {
  if (LOC_ALIASES[normKey]) return LOC_ALIASES[normKey];
  // also try without trailing OFFICE nuances
  return [normKey];
}

function countMapGet(map, key) {
  return map[key] || 0;
}

function addCount(map, key, n = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + n;
}

/**
 * Live Status counts from employee rows, grouped by department family + location.
 */
function liveStatusBuckets(statusRecords) {
  const byDeptLoc = {}; // deptFamily -> { locNorm -> { label, count } }
  const deptTotals = {};

  for (const r of statusRecords) {
    const deptRaw = normText(r.department);
    const family = deptFamily(deptRaw);
    if (!family) continue;
    const locLabel = normText(r.location) || '(blank)';
    const lk = normLoc(locLabel);
    if (!byDeptLoc[family]) byDeptLoc[family] = {};
    if (!byDeptLoc[family][lk]) byDeptLoc[family][lk] = { label: locLabel, count: 0 };
    byDeptLoc[family][lk].count += 1;
    deptTotals[family] = (deptTotals[family] || 0) + 1;
  }
  return { byDeptLoc, deptTotals };
}

function deptFamily(dept) {
  const d = normText(dept).toUpperCase().replace(/\s+/g, '');
  if (!d) return null;
  if (d.includes('PMTA')) return 'PMTA';
  if (d === 'MFU' || d.includes('MANUFACTURING')) return 'MFU';
  if (d === 'CORP') return 'CORP';
  if (d === 'SZ' || d.includes('SAUDI')) return 'SZ';
  return d;
}

/**
 * Parse "Summary: PMTA" style blocks at bottom of Status sheet.
 * Labels in those blocks are often SST indices stored WITHOUT t="s";
 * adjacent count cells are plain numbers.
 *
 * Layout (typical):
 *   A/D  = PMTA label/count
 *   E/G  = MFU label/count
 *   I/K  = SZ (SAUDIZATION) label/count
 *   CORP block may appear under MFU column as "CORP" header then rows.
 */
function parseStatusSheetSummaries(statusPath) {
  const dest = path.join(os.tmpdir(), 'seyenna_sum_' + process.pid);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  try {
    execSync(`unzip -o -q "${statusPath}" -d "${dest}"`, { stdio: 'pipe' });
    const sstPath = path.join(dest, 'xl/sharedStrings.xml');
    const strings = [];
    if (fs.existsSync(sstPath)) {
      const xml = fs.readFileSync(sstPath, 'utf8');
      const siRe = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = siRe.exec(xml))) {
        const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]));
        strings.push(texts.join(''));
      }
    }

    const sheetFile = fs.readdirSync(path.join(dest, 'xl/worksheets')).find((f) => f.endsWith('.xml'));
    const sheetXml = fs.readFileSync(path.join(dest, 'xl/worksheets', sheetFile), 'utf8');

    function resolveLabel(raw) {
      if (raw === '' || raw == null) return '';
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0 && n < strings.length) {
        const s = strings[n];
        if (/[A-Za-z]/.test(s)) return normText(s);
      }
      return normText(raw);
    }
    function asCount(raw) {
      if (raw === '' || raw == null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      // Counts in summary are small integers; SST indices for labels are often >200
      // but some counts like Total=141. Prefer numeric interpretation always for count cols.
      return Math.round(n);
    }

    const rows = new Map();
    const rowRe = /<row[^>]* r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sheetXml))) {
      const r = Number(rm[1]);
      const cells = {};
      const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>(?:[\s\S]*?<v>([\s\S]*?)<\/v>)?/g;
      let cm;
      while ((cm = cellRe.exec(rm[2]))) {
        const attrs = cm[3] || '';
        let val = cm[4] != null ? cm[4] : '';
        if (/t="s"/.test(attrs) && val !== '') val = strings[Number(val)] ?? '';
        cells[cm[1]] = val;
      }
      rows.set(r, cells);
    }

    // Find header row containing "Summary: PMTA"
    let startRow = null;
    for (const [r, cells] of rows) {
      const a = resolveLabel(cells.A);
      if (/^summary\s*:\s*pmta/i.test(a)) {
        startRow = r;
        break;
      }
    }
    if (!startRow) return { found: false, blocks: {} };

    const blocks = { PMTA: [], MFU: [], CORP: [], SZ: [] };
    let mfuMode = 'MFU'; // switches to CORP when we see CORP header in E column

    for (let r = startRow; r <= startRow + 40; r++) {
      const cells = rows.get(r);
      if (!cells) continue;

      // PMTA block: A label, D count
      const pLabel = resolveLabel(cells.A);
      const pCount = asCount(cells.D);
      if (r === startRow) {
        // header only
      } else if (pLabel && pCount != null) {
        const isTotal = /^totals?$/i.test(pLabel);
        blocks.PMTA.push({ label: pLabel, count: pCount, isTotal });
      } else if (pLabel && /^totals?$/i.test(pLabel) && cells.D != null && cells.D !== '') {
        blocks.PMTA.push({ label: pLabel, count: asCount(cells.D) || 0, isTotal: true });
      }

      // MFU / CORP block: E label, G count
      const mLabel = resolveLabel(cells.E);
      const mCount = asCount(cells.G);
      if (r === startRow) {
        // Summary: MFU header in D on some files; E may be empty on header row
      } else if (/^corp$/i.test(mLabel) && (mCount == null || mCount === 0)) {
        mfuMode = 'CORP';
      } else if (mLabel && mCount != null) {
        const isTotal = /^totals?$/i.test(mLabel);
        const target = mfuMode === 'CORP' ? 'CORP' : 'MFU';
        // "Total" under MFG before CORP header belongs to MFU
        blocks[target].push({ label: mLabel, count: mCount, isTotal });
        if (isTotal && mfuMode === 'MFU') {
          // after MFU total, subsequent E labels may be CORP section
          // (CORP header often appears after MFU total without being in count col)
        }
      } else if (/^corp$/i.test(mLabel)) {
        mfuMode = 'CORP';
      }

      // Detect CORP header sitting in E with no count (row after MFU total)
      if (/^corp$/i.test(mLabel)) mfuMode = 'CORP';

      // SZ / SAUDIZATION: I label, K count
      const sLabel = resolveLabel(cells.I);
      const sCount = asCount(cells.K);
      if (r > startRow && sLabel && sCount != null) {
        blocks.SZ.push({ label: sLabel, count: sCount, isTotal: /^totals?$/i.test(sLabel) });
      }
    }

    // CORP rows: look for E=CORP then following E/G pairs that aren't MFU already
    // Re-scan: after seeing CORP in E, collect subsequent until blank
    let corpStarted = false;
    for (let r = startRow; r <= startRow + 40; r++) {
      const cells = rows.get(r);
      if (!cells) continue;
      const mLabel = resolveLabel(cells.E);
      const mCount = asCount(cells.G);
      if (/^corp$/i.test(mLabel)) {
        corpStarted = true;
        blocks.CORP = [];
        continue;
      }
      if (corpStarted && mLabel && mCount != null && !/^totals?$/i.test(mLabel)) {
        blocks.CORP.push({ label: mLabel, count: mCount, isTotal: false });
      } else if (corpStarted && mLabel && /^totals?$/i.test(mLabel)) {
        blocks.CORP.push({ label: mLabel, count: mCount || 0, isTotal: true });
        break;
      }
    }

    // Fix MFU list: remove CORP header and CORP location rows if they leaked
    const corpLabels = new Set(blocks.CORP.map((x) => normLoc(x.label)));
    blocks.MFU = blocks.MFU.filter((x) => {
      if (/^corp$/i.test(x.label)) return false;
      if (corpLabels.has(normLoc(x.label)) && !/^totals?$/i.test(x.label)) {
        // only strip if it appears after total — keep manufacturing ones
        const nl = normLoc(x.label);
        if (nl.includes('SECURITY') || nl.includes('MANUFACTURING') || nl.includes('SEYANA YARD')) {
          // CORP also uses these labels — if count matches CORP block keep in CORP only
          const inCorp = blocks.CORP.find((c) => normLoc(c.label) === nl && c.count === x.count);
          if (inCorp) return false;
        }
      }
      return true;
    });

    return { found: true, blocks, startRow };
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

function buildAllocPmtaMaps(pmtaRecords) {
  const byLocation = {};
  const byPlanning = {};
  for (const r of pmtaRecords) {
    addCount(byLocation, normLoc(r.location) || '(BLANK)');
    addCount(byPlanning, normLoc(r.planning) || '(BLANK)');
  }
  return { byLocation, byPlanning, total: pmtaRecords.length };
}

function buildAllocMfgMaps(mfgRecords) {
  const byDept = {};
  const byLoc = {};
  let nonPmta = 0;
  let pmtaTemp = 0;
  for (const r of mfgRecords) {
    const dept = normText(r.department);
    const dk = normLoc(dept) || '(BLANK)';
    addCount(byDept, dk);
    const loc = normText(r.location);
    if (loc) addCount(byLoc, normLoc(loc));
    if (/^pmta$/i.test(dept)) pmtaTemp += 1;
    else nonPmta += 1;
  }
  return { byDept, byLoc, total: mfgRecords.length, nonPmta, pmtaTemp };
}

/**
 * Find best allocation count for a Status location bucket.
 */
function lookupAllocCount(normKey, locMap, planMap, prefer) {
  const keys = aliasKeys(normKey);
  const maps =
    prefer === 'planning'
      ? [
          ['PLANNING', planMap],
          ['LOCATION', locMap],
        ]
      : [
          ['LOCATION', locMap],
          ['PLANNING', planMap],
        ];

  for (const [source, map] of maps) {
    if (!map) continue;
    let sum = 0;
    let matched = [];
    for (const k of keys) {
      if (map[k] != null) {
        sum += map[k];
        matched.push(k);
      }
    }
    // Deduplicate if aliases point to same key
    if (matched.length > 1) {
      const seen = new Set();
      sum = 0;
      matched = [];
      for (const k of keys) {
        if (map[k] != null && !seen.has(k)) {
          seen.add(k);
          sum += map[k];
          matched.push(k);
        }
      }
    }
    if (matched.length) {
      return { count: sum, source, matchedKey: matched.join('+') };
    }
  }
  return { count: 0, source: '', matchedKey: '' };
}

function lookupMfgCount(normKey, mfgMaps) {
  const keys = [...new Set(aliasKeys(normKey))];
  for (const k of keys) {
    if (mfgMaps.byDept[k] != null) {
      return { count: mfgMaps.byDept[k], source: 'Department', matchedKey: k };
    }
  }
  for (const k of keys) {
    if (mfgMaps.byLoc[k] != null) {
      return { count: mfgMaps.byLoc[k], source: 'Reporting Location', matchedKey: k };
    }
  }
  return { count: 0, source: '', matchedKey: '' };
}

/**
 * Build comparison rows for the report.
 */
function buildCountCheck({ statusRecords, pmtaRecords, mfgRecords, statusPath }) {
  const live = liveStatusBuckets(statusRecords);
  const parsed = statusPath ? parseStatusSheetSummaries(statusPath) : { found: false, blocks: {} };
  const pmtaMaps = buildAllocPmtaMaps(pmtaRecords);
  const mfgMaps = buildAllocMfgMaps(mfgRecords);

  const rows = [];
  const COUNT_CHECK_COLUMNS = [
    'Department',
    'LocationBucket',
    'StatusCount',
    'AllocationCount',
    'Difference',
    'Match',
    'AllocSource',
    'Notes',
  ];

  function pushRow({ department, bucket, statusCount, allocCount, allocSource, notes, isTotal }) {
    const sc = Number(statusCount) || 0;
    const ac = allocCount == null ? null : Number(allocCount) || 0;
    const diff = ac == null ? null : sc - ac;
    const match = ac == null ? 'N/A' : diff === 0 ? 'YES' : 'NO';
    rows.push({
      Department: department,
      LocationBucket: bucket,
      StatusCount: sc,
      AllocationCount: ac == null ? '' : ac,
      Difference: diff == null ? '' : diff,
      Match: match,
      AllocSource: allocSource || '',
      Notes: notes || '',
      isTotal: !!isTotal,
      isMismatch: match === 'NO',
    });
  }

  // Prefer live Status location buckets (always available); annotate if sheet summary total differs
  function sheetTotal(dept) {
    const block = parsed.blocks && parsed.blocks[dept];
    if (!block) return null;
    const t = block.find((x) => x.isTotal);
    return t ? t.count : null;
  }

  // --- PMTA ---
  const pmtaLocs = live.byDeptLoc.PMTA || {};
  const pmtaKeys = Object.keys(pmtaLocs).sort((a, b) =>
    pmtaLocs[a].label.localeCompare(pmtaLocs[b].label)
  );
  let pmtaStatusSum = 0;
  let pmtaAllocSum = 0;
  for (const k of pmtaKeys) {
    const { label, count } = pmtaLocs[k];
    pmtaStatusSum += count;
    const hit = lookupAllocCount(k, pmtaMaps.byLocation, pmtaMaps.byPlanning, 'location');
    pmtaAllocSum += hit.count;
    pushRow({
      department: 'PMTA',
      bucket: label,
      statusCount: count,
      allocCount: hit.count,
      allocSource: hit.source ? `PMTA ${hit.source}` : 'PMTA',
      notes: hit.matchedKey && hit.matchedKey !== k ? `matched as "${hit.matchedKey}"` : '',
    });
  }
  const pmtaSheetTot = sheetTotal('PMTA');
  pushRow({
    department: 'PMTA',
    bucket: 'TOTAL',
    statusCount: live.deptTotals.PMTA || pmtaStatusSum,
    allocCount: pmtaMaps.total,
    allocSource: 'PMTA allocation rows',
    notes:
      pmtaSheetTot != null && pmtaSheetTot !== (live.deptTotals.PMTA || pmtaStatusSum)
        ? `Status sheet Summary Total=${pmtaSheetTot}; live row count=${live.deptTotals.PMTA}`
        : pmtaSheetTot != null
          ? `Status Summary Total=${pmtaSheetTot}`
          : 'Status live department total vs all PMTA allocation rows',
    isTotal: true,
  });

  // --- MFU ---
  const mfuLocs = live.byDeptLoc.MFU || {};
  const mfuKeys = Object.keys(mfuLocs).sort((a, b) =>
    mfuLocs[a].label.localeCompare(mfuLocs[b].label)
  );
  for (const k of mfuKeys) {
    const { label, count } = mfuLocs[k];
    const hit = lookupMfgCount(k, mfgMaps);
    pushRow({
      department: 'MFU',
      bucket: label,
      statusCount: count,
      allocCount: hit.count,
      allocSource: hit.source ? `MFG ${hit.source}` : 'MFG',
      notes: hit.matchedKey && hit.matchedKey !== k ? `matched as "${hit.matchedKey}"` : '',
    });
  }
  const mfuSheetTot = sheetTotal('MFU');
  pushRow({
    department: 'MFU',
    bucket: 'TOTAL (excl. PMTA temps on MFG)',
    statusCount: live.deptTotals.MFU || 0,
    allocCount: mfgMaps.nonPmta,
    allocSource: 'MFG allocation (non-PMTA)',
    notes:
      mfuSheetTot != null
        ? `Status Summary Total=${mfuSheetTot}; MFG also has ${mfgMaps.pmtaTemp} PMTA temps`
        : `MFG also has ${mfgMaps.pmtaTemp} PMTA temps`,
    isTotal: true,
  });
  pushRow({
    department: 'MFU',
    bucket: 'TOTAL (MFG sheet all rows)',
    statusCount: live.deptTotals.MFU || 0,
    allocCount: mfgMaps.total,
    allocSource: 'MFG allocation all',
    notes: 'Includes temporary PMTA manpower on MFG sheet',
    isTotal: true,
  });

  // --- CORP / SZ (optional — no allocation sheet) ---
  if (live.deptTotals.CORP) {
    pushRow({
      department: 'CORP',
      bucket: 'TOTAL',
      statusCount: live.deptTotals.CORP,
      allocCount: null,
      allocSource: '',
      notes: 'No dedicated allocation file',
      isTotal: true,
    });
  }
  if (live.deptTotals.SZ) {
    pushRow({
      department: 'SZ',
      bucket: 'TOTAL',
      statusCount: live.deptTotals.SZ,
      allocCount: null,
      allocSource: '',
      notes: 'No dedicated allocation file',
      isTotal: true,
    });
  }

  // Allocation-only buckets not represented in Status (PMTA LOCATION)
  const statusPmtaNorms = new Set(pmtaKeys);
  const covered = new Set();
  for (const k of pmtaKeys) {
    for (const a of aliasKeys(k)) covered.add(a);
    covered.add(k);
  }
  for (const [lk, c] of Object.entries(pmtaMaps.byLocation)) {
    if (covered.has(lk)) continue;
    // skip if any status key aliases to this
    let hit = false;
    for (const sk of statusPmtaNorms) {
      if (aliasKeys(sk).includes(lk) || sk.includes(lk) || lk.includes(sk)) {
        hit = true;
        break;
      }
    }
    if (hit) continue;
    pushRow({
      department: 'PMTA',
      bucket: `(Alloc only) ${lk}`,
      statusCount: 0,
      allocCount: c,
      allocSource: 'PMTA LOCATION',
      notes: 'Present in PMTA allocation LOCATION but no Status PMTA location bucket',
    });
  }

  const compared = rows.filter((r) => r.Match === 'YES' || r.Match === 'NO');
  const matched = compared.filter((r) => r.Match === 'YES').length;
  const mismatched = compared.filter((r) => r.Match === 'NO').length;

  return {
    columns: COUNT_CHECK_COLUMNS,
    rows,
    parsedSummaryFound: !!parsed.found,
    parsedBlocks: parsed.blocks || {},
    stats: {
      bucketsCompared: compared.length,
      bucketsMatched: matched,
      bucketsMismatched: mismatched,
      pmtaStatusTotal: live.deptTotals.PMTA || 0,
      pmtaAllocTotal: pmtaMaps.total,
      mfuStatusTotal: live.deptTotals.MFU || 0,
      mfgAllocNonPmta: mfgMaps.nonPmta,
      mfgAllocTotal: mfgMaps.total,
    },
  };
}

module.exports = {
  buildCountCheck,
  parseStatusSheetSummaries,
  liveStatusBuckets,
  normLoc,
};

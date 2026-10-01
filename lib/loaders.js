/**
 * Loaders for Employee Status, PMTA allocation, and Manufacturing allocation Excel files.
 */
'use strict';

const { readWorkbook } = require('./xlsx');

function normId(v) {
  const s = String(v ?? '')
    .trim()
    .replace(/\.0$/, '');
  // Keep digit-only IDs; allow leading zeros preservation as string
  if (!s) return '';
  // Strip non-digits only if the value is mostly digits (badge numbers)
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length === s.replace(/\s/g, '').length) return digits;
  if (/^\d+$/.test(s)) return s;
  return s;
}

function normText(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKey(v) {
  return normText(v).toUpperCase();
}

function findHeaderRow(rows, requiredHints) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const joined = rows[i].map((c) => normKey(c)).join('|');
    if (requiredHints.every((h) => joined.includes(normKey(h)))) return i;
  }
  return -1;
}

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const key = normKey(h);
    if (key) map[key] = idx;
  });
  return map;
}

function col(map, ...aliases) {
  for (const a of aliases) {
    const k = normKey(a);
    if (map[k] != null) return map[k];
  }
  // fuzzy: contains
  for (const a of aliases) {
    const k = normKey(a);
    for (const [hk, idx] of Object.entries(map)) {
      if (hk.includes(k) || k.includes(hk)) return idx;
    }
  }
  return -1;
}

function cell(row, idx) {
  if (idx < 0) return '';
  return normText(row[idx]);
}

/**
 * Parse sheet names like "1-10-26", "30-9-26", "1-10-26 " as D-M-YY → Date.
 * Returns null if not a dated sheet.
 */
function parseDatedSheetName(name) {
  const m = String(name).trim().match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (!m) return null;
  let d = Number(m[1]);
  let mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

function pickLatestMfgSheet(workbook) {
  let best = null;
  let bestDate = null;
  for (const name of Object.keys(workbook)) {
    const dt = parseDatedSheetName(name);
    if (!dt) continue;
    if (!bestDate || dt > bestDate) {
      bestDate = dt;
      best = name;
    }
  }
  return best ? { name: best, date: bestDate, rows: workbook[best] } : null;
}

function loadStatus(filePath) {
  const wb = readWorkbook(filePath);
  // Prefer sheet whose name looks like manpower list; else first sheet with Employee ID header
  let chosen = null;
  let chosenName = null;
  for (const [name, rows] of Object.entries(wb)) {
    const hi = findHeaderRow(rows, ['Employee ID']);
    if (hi >= 0) {
      // Prefer "Seyana Manpower list"
      if (!chosen || /manpower\s*list/i.test(name)) {
        chosen = { rows, headerIdx: hi };
        chosenName = name;
        if (/manpower\s*list/i.test(name)) break;
      }
    }
  }
  if (!chosen) throw new Error(`No Employee Status sheet with "Employee ID" header in ${filePath}`);

  const header = chosen.rows[chosen.headerIdx];
  const fmap = mapHeaders(header);
  const iId = col(fmap, 'Employee ID', 'EmployeeID', 'ID');
  const iName = col(fmap, 'Employee Name', 'Name');
  const iDesig = col(fmap, 'Designation');
  const iDept = col(fmap, 'Department');
  const iSub = col(fmap, 'Sub -Dept', 'Sub-Dept', 'Sub Dept', 'SubDept');
  const iLoc = col(fmap, 'Location');
  const iNatId = col(fmap, 'National ID', 'Iqama');
  const iNation = col(fmap, 'Nationality', 'Nation');
  const iSponsor = col(fmap, 'Sponsor Name', 'Sponsor');
  const iRemarks = col(fmap, 'Remarks');

  const byId = new Map();
  const duplicates = [];
  const records = [];

  for (const row of chosen.rows.slice(chosen.headerIdx + 1)) {
    const id = normId(cell(row, iId));
    if (!id) continue;
    // Skip summary/total-like rows without a real name
    const name = cell(row, iName);
    if (!name && !cell(row, iDept)) continue;

    const rec = {
      id,
      name,
      nationalId: cell(row, iNatId),
      designation: cell(row, iDesig),
      department: cell(row, iDept),
      subDept: cell(row, iSub),
      nationality: cell(row, iNation),
      sponsor: cell(row, iSponsor),
      location: cell(row, iLoc),
      remarks: cell(row, iRemarks),
      source: 'Status',
      sheet: chosenName,
    };
    records.push(rec);
    if (byId.has(id)) {
      duplicates.push(id);
    } else {
      byId.set(id, rec);
    }
  }

  return {
    sheetName: chosenName,
    byId,
    records,
    duplicates: [...new Set(duplicates)],
  };
}

function loadPmta(filePath) {
  const wb = readWorkbook(filePath);
  let chosen = null;
  let chosenName = null;
  for (const [name, rows] of Object.entries(wb)) {
    const hi = findHeaderRow(rows, ['Badge No']);
    if (hi < 0) {
      const hi2 = findHeaderRow(rows, ['Badge']);
      if (hi2 >= 0) {
        chosen = { rows, headerIdx: hi2 };
        chosenName = name;
        break;
      }
    } else {
      chosen = { rows, headerIdx: hi };
      chosenName = name;
      if (/manpower\s*planning/i.test(name)) break;
    }
  }
  if (!chosen) throw new Error(`No PMTA sheet with "Badge No" header in ${filePath}`);

  const fmap = mapHeaders(chosen.rows[chosen.headerIdx]);
  const iId = col(fmap, 'Badge No', 'Badge', 'Employee ID', 'ID');
  const iName = col(fmap, 'Name');
  const iIqama = col(fmap, 'Iqama', 'National ID');
  const iDesig = col(fmap, 'Designation');
  const iDiv = col(fmap, 'Division', 'Department');
  const iDep = col(fmap, 'Dep', 'Sub -Dept', 'Sub Dept');
  const iNation = col(fmap, 'Nation', 'Nationality');
  const iSponsor = col(fmap, 'Sponsor');
  const iLoc = col(fmap, 'LOCATION', 'Location');
  const iPlan = col(fmap, 'PLANNING', 'Planning');

  const byId = new Map();
  const duplicates = [];
  const records = [];

  for (const row of chosen.rows.slice(chosen.headerIdx + 1)) {
    const id = normId(cell(row, iId));
    if (!id) continue;
    const rec = {
      id,
      name: cell(row, iName),
      nationalId: cell(row, iIqama),
      designation: cell(row, iDesig),
      division: cell(row, iDiv),
      department: cell(row, iDiv), // Division is usually PMTA
      subDept: cell(row, iDep),
      nationality: cell(row, iNation),
      sponsor: cell(row, iSponsor),
      location: cell(row, iLoc),
      planning: cell(row, iPlan),
      source: 'PMTA',
      sheet: chosenName,
    };
    records.push(rec);
    if (byId.has(id)) duplicates.push(id);
    else byId.set(id, rec);
  }

  return {
    sheetName: chosenName,
    byId,
    records,
    duplicates: [...new Set(duplicates)],
  };
}

function loadMfg(filePath) {
  const wb = readWorkbook(filePath);
  const latest = pickLatestMfgSheet(wb);
  if (!latest) {
    throw new Error(
      `No dated Manufacturing sheet (D-M-YY) found in ${filePath}. Sheets: ${Object.keys(wb).join(', ')}`
    );
  }

  const hi = findHeaderRow(latest.rows, ['ID#']);
  const hi2 = hi >= 0 ? hi : findHeaderRow(latest.rows, ['ID']);
  if (hi2 < 0) {
    throw new Error(`No header row with ID# on MFG sheet "${latest.name}"`);
  }

  const fmap = mapHeaders(latest.rows[hi2]);
  const iId = col(fmap, 'ID#', 'ID', 'Employee ID', 'Badge No');
  const iName = col(fmap, 'Name', 'Employee Name');
  const iIqama = col(fmap, 'Iqama No', 'Iqama', 'National ID');
  const iDesig = col(fmap, 'Designation');
  const iDept = col(fmap, 'Department');
  const iLoc = col(fmap, 'Reporting Location', 'Location');

  const byId = new Map();
  const duplicates = [];
  const records = [];
  let sectionNote = '';

  for (const row of latest.rows.slice(hi2 + 1)) {
    const joined = row.map((c) => normText(c)).join(' ');
    // Section title rows (no ID)
    if (/TEMPORARY\s+MANPOWER/i.test(joined) || /ALLOCATION\s+FROM\s+PMTA/i.test(joined)) {
      sectionNote = normText(joined);
      continue;
    }
    const id = normId(cell(row, iId));
    if (!id) continue;
    // Skip if first col is not a serial-like and name empty
    const name = cell(row, iName);
    if (!name && !cell(row, iDept) && !cell(row, iDesig)) continue;

    const rec = {
      id,
      name,
      nationalId: cell(row, iIqama),
      designation: cell(row, iDesig),
      department: cell(row, iDept),
      location: cell(row, iLoc),
      planning: '',
      subDept: '',
      sectionNote,
      source: 'MFG',
      sheet: latest.name,
    };
    records.push(rec);
    if (byId.has(id)) duplicates.push(id);
    else byId.set(id, rec);
  }

  return {
    sheetName: latest.name,
    sheetDate: latest.date,
    byId,
    records,
    duplicates: [...new Set(duplicates)],
  };
}

function isPmtaDept(dept) {
  return /\bPMTA\b/i.test(normText(dept));
}

function isMfgDept(dept) {
  const d = normKey(dept);
  if (!d) return false;
  if (d === 'MFU' || d.includes('MFU')) return true;
  if (d.includes('MANUFACTURING')) return true;
  if (d.includes('MANUFACTURING OFFICE') || d.includes('MANUFACTURING YARD')) return true;
  return false;
}

function softEqual(a, b) {
  return normKey(a) === normKey(b);
}

module.exports = {
  normId,
  normText,
  normKey,
  softEqual,
  loadStatus,
  loadPmta,
  loadMfg,
  isPmtaDept,
  isMfgDept,
  parseDatedSheetName,
  pickLatestMfgSheet,
};

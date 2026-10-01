/**
 * Core reconciliation logic shared by CLI and web UI.
 */
'use strict';

const path = require('path');
const {
  loadStatus,
  loadPmta,
  loadMfg,
  isPmtaDept,
  isMfgDept,
  softEqual,
  normText,
} = require('./loaders');
const { writeReports } = require('./report');
const { buildCountCheck } = require('./count-check');

function mismatchRow(partial) {
  return {
    Category: partial.Category || '',
    EmployeeID: partial.EmployeeID || '',
    Name: partial.Name || '',
    Detail: partial.Detail || '',
    StatusDept: partial.StatusDept || '',
    StatusSubDept: partial.StatusSubDept || '',
    StatusLocation: partial.StatusLocation || '',
    AllocSource: partial.AllocSource || '',
    AllocDept: partial.AllocDept || '',
    AllocLocation: partial.AllocLocation || '',
    AllocPlanning: partial.AllocPlanning || '',
    Notes: partial.Notes || '',
  };
}

function statusFields(s) {
  if (!s) return { StatusDept: '', StatusSubDept: '', StatusLocation: '' };
  return {
    StatusDept: s.department || '',
    StatusSubDept: s.subDept || '',
    StatusLocation: s.location || '',
  };
}

function allocFields(a, source) {
  if (!a) {
    return { AllocSource: source || '', AllocDept: '', AllocLocation: '', AllocPlanning: '' };
  }
  return {
    AllocSource: source || a.source || '',
    AllocDept: a.department || a.division || a.subDept || '',
    AllocLocation: a.location || '',
    AllocPlanning: a.planning || '',
  };
}

function comparePmtaPair(status, pmta) {
  const diffs = [];
  if (!softEqual(status.name, pmta.name)) {
    diffs.push(`Name: Status="${status.name}" vs PMTA="${pmta.name}"`);
  }
  if (!softEqual(status.designation, pmta.designation)) {
    diffs.push(`Designation: Status="${status.designation}" vs PMTA="${pmta.designation}"`);
  }
  // Status Sub -Dept vs PMTA Dep
  if (!softEqual(status.subDept, pmta.subDept)) {
    diffs.push(`Sub-Dept: Status="${status.subDept}" vs PMTA Dep="${pmta.subDept}"`);
  }
  // Location vs LOCATION and/or PLANNING
  const locOk =
    softEqual(status.location, pmta.location) || softEqual(status.location, pmta.planning);
  if (!locOk) {
    diffs.push(
      `Location: Status="${status.location}" vs PMTA LOCATION="${pmta.location}" / PLANNING="${pmta.planning}"`
    );
  }
  // Department vs Division
  if (!softEqual(status.department, pmta.division) && !softEqual(status.department, pmta.department)) {
    diffs.push(
      `Department/Division: Status="${status.department}" vs PMTA Division="${pmta.division}"`
    );
  }
  return diffs;
}

function compareMfgPair(status, mfg) {
  const diffs = [];
  if (!softEqual(status.name, mfg.name)) {
    diffs.push(`Name: Status="${status.name}" vs MFG="${mfg.name}"`);
  }
  if (!softEqual(status.designation, mfg.designation)) {
    diffs.push(`Designation: Status="${status.designation}" vs MFG="${mfg.designation}"`);
  }
  // Flexible dept compare: Status MFU/Manufacturing* vs MFG department
  const statusDeptKey = normText(status.department).toUpperCase();
  const mfgDeptKey = normText(mfg.department).toUpperCase();
  const deptRelated =
    softEqual(status.department, mfg.department) ||
    (isMfgDept(status.department) && isMfgDept(mfg.department)) ||
    (statusDeptKey.includes('MFU') && (mfgDeptKey.includes('MFU') || mfgDeptKey.includes('MANUFACTURING'))) ||
    (mfgDeptKey === 'PMTA' && isPmtaDept(status.department)); // temp transfer handled separately
  if (!deptRelated && !softEqual(status.department, mfg.department)) {
    diffs.push(`Department: Status="${status.department}" vs MFG="${mfg.department}"`);
  }
  if (mfg.location && !softEqual(status.location, mfg.location)) {
    // Only flag location when MFG has a reporting location column
    diffs.push(`Location: Status="${status.location}" vs MFG="${mfg.location}"`);
  }
  return diffs;
}

/**
 * Run full reconciliation.
 * @param {{ statusPath: string, pmtaPath: string, mfgPath: string, outDir: string }} opts
 */
function runReconcile(opts) {
  const statusPath = path.resolve(opts.statusPath);
  const pmtaPath = path.resolve(opts.pmtaPath);
  const mfgPath = path.resolve(opts.mfgPath);
  const outDir = path.resolve(opts.outDir || './output');

  const status = loadStatus(statusPath);
  const pmta = loadPmta(pmtaPath);
  const mfg = loadMfg(mfgPath);

  const mismatches = [];
  const matches = [];
  const categories = {
    'PMTA: In allocation, missing from Status': 0,
    'PMTA: In Status (PMTA dept), missing from allocation': 0,
    'PMTA: Field mismatch': 0,
    'MFG: In allocation, missing from Status': 0,
    'MFG: In Status (MFU/Manufacturing), missing from allocation': 0,
    'MFG: Field mismatch': 0,
    'Cross: MFG allocation with Department PMTA (temp transfer)': 0,
    'Cross: Same ID in BOTH PMTA and MFG allocations': 0,
    'Duplicate: Employee ID within Status': 0,
    'Duplicate: Employee ID within PMTA': 0,
    'Duplicate: Employee ID within MFG': 0,
  };

  // --- Duplicates ---
  for (const id of status.duplicates) {
    const s = status.byId.get(id) || status.records.find((r) => r.id === id);
    categories['Duplicate: Employee ID within Status']++;
    mismatches.push(
      mismatchRow({
        Category: 'Duplicate: Employee ID within Status',
        EmployeeID: id,
        Name: s ? s.name : '',
        Detail: 'Employee ID appears more than once in Employee Status',
        ...statusFields(s),
        Notes: `sheet=${status.sheetName}`,
      })
    );
  }
  for (const id of pmta.duplicates) {
    const a = pmta.byId.get(id) || pmta.records.find((r) => r.id === id);
    categories['Duplicate: Employee ID within PMTA']++;
    mismatches.push(
      mismatchRow({
        Category: 'Duplicate: Employee ID within PMTA',
        EmployeeID: id,
        Name: a ? a.name : '',
        Detail: 'Employee ID appears more than once in PMTA allocation',
        ...allocFields(a, 'PMTA'),
        Notes: `sheet=${pmta.sheetName}`,
      })
    );
  }
  for (const id of mfg.duplicates) {
    const a = mfg.byId.get(id) || mfg.records.find((r) => r.id === id);
    categories['Duplicate: Employee ID within MFG']++;
    mismatches.push(
      mismatchRow({
        Category: 'Duplicate: Employee ID within MFG',
        EmployeeID: id,
        Name: a ? a.name : '',
        Detail: 'Employee ID appears more than once in Manufacturing allocation',
        ...allocFields(a, 'MFG'),
        Notes: `sheet=${mfg.sheetName}`,
      })
    );
  }

  // --- A. PMTA department ---
  let pmtaMatched = 0;
  for (const [id, a] of pmta.byId) {
    const s = status.byId.get(id);
    if (!s) {
      categories['PMTA: In allocation, missing from Status']++;
      mismatches.push(
        mismatchRow({
          Category: 'PMTA: In allocation, missing from Status',
          EmployeeID: id,
          Name: a.name,
          Detail: 'Present in PMTA allocation but not found in Employee Status',
          ...allocFields(a, 'PMTA'),
          AllocDept: a.subDept || a.division,
          Notes: `Division=${a.division}; Dep=${a.subDept}`,
        })
      );
      continue;
    }
    const diffs = comparePmtaPair(s, a);
    if (diffs.length) {
      categories['PMTA: Field mismatch']++;
      mismatches.push(
        mismatchRow({
          Category: 'PMTA: Field mismatch',
          EmployeeID: id,
          Name: s.name || a.name,
          Detail: diffs.join(' | '),
          ...statusFields(s),
          ...allocFields(a, 'PMTA'),
          AllocDept: a.subDept || a.division,
          Notes: `Division=${a.division}; Dep=${a.subDept}`,
        })
      );
    } else {
      pmtaMatched++;
      matches.push({
        EmployeeID: id,
        Name: s.name,
        Scope: 'Status+PMTA',
        StatusDept: s.department,
        StatusSubDept: s.subDept,
        StatusLocation: s.location,
        AllocSource: 'PMTA',
        AllocDept: a.subDept || a.division,
        AllocLocation: a.location,
        AllocPlanning: a.planning,
        Notes: '',
      });
    }
  }

  for (const [id, s] of status.byId) {
    if (!isPmtaDept(s.department)) continue;
    if (pmta.byId.has(id)) continue;
    categories['PMTA: In Status (PMTA dept), missing from allocation']++;
    mismatches.push(
      mismatchRow({
        Category: 'PMTA: In Status (PMTA dept), missing from allocation',
        EmployeeID: id,
        Name: s.name,
        Detail: 'Status Department contains PMTA but ID not in PMTA allocation',
        ...statusFields(s),
        AllocSource: 'PMTA',
        Notes: '',
      })
    );
  }

  // --- B. Manufacturing department ---
  let mfgMatched = 0;
  for (const [id, a] of mfg.byId) {
    const s = status.byId.get(id);
    if (!s) {
      categories['MFG: In allocation, missing from Status']++;
      mismatches.push(
        mismatchRow({
          Category: 'MFG: In allocation, missing from Status',
          EmployeeID: id,
          Name: a.name,
          Detail: 'Present in Manufacturing allocation but not found in Employee Status',
          ...allocFields(a, 'MFG'),
          AllocDept: a.department,
          Notes: a.sectionNote || '',
        })
      );
      continue;
    }

    // C. Temp transfer flag (MFG dept = PMTA)
    if (isPmtaDept(a.department)) {
      categories['Cross: MFG allocation with Department PMTA (temp transfer)']++;
      mismatches.push(
        mismatchRow({
          Category: 'Cross: MFG allocation with Department PMTA (temp transfer)',
          EmployeeID: id,
          Name: s.name || a.name,
          Detail: `MFG lists Department=PMTA (temp). Status Dept="${s.department}" Loc="${s.location}" vs MFG Desig="${a.designation}"`,
          ...statusFields(s),
          ...allocFields(a, 'MFG'),
          AllocDept: a.department,
          Notes: a.sectionNote || 'Temporary manpower from PMTA to MFU',
        })
      );
    }

    const diffs = compareMfgPair(s, a);
    // For temp PMTA-on-MFG, department mismatch vs Status PMTA is expected — don't double-count as field mismatch for dept alone
    const filtered =
      isPmtaDept(a.department) && isPmtaDept(s.department)
        ? diffs.filter((d) => !d.startsWith('Department:'))
        : diffs;
    if (filtered.length) {
      categories['MFG: Field mismatch']++;
      mismatches.push(
        mismatchRow({
          Category: 'MFG: Field mismatch',
          EmployeeID: id,
          Name: s.name || a.name,
          Detail: filtered.join(' | '),
          ...statusFields(s),
          ...allocFields(a, 'MFG'),
          AllocDept: a.department,
          Notes: a.sectionNote || '',
        })
      );
    } else if (!isPmtaDept(a.department)) {
      mfgMatched++;
      matches.push({
        EmployeeID: id,
        Name: s.name,
        Scope: 'Status+MFG',
        StatusDept: s.department,
        StatusSubDept: s.subDept,
        StatusLocation: s.location,
        AllocSource: 'MFG',
        AllocDept: a.department,
        AllocLocation: a.location,
        AllocPlanning: '',
        Notes: '',
      });
    }
  }

  for (const [id, s] of status.byId) {
    if (!isMfgDept(s.department)) continue;
    if (mfg.byId.has(id)) continue;
    categories['MFG: In Status (MFU/Manufacturing), missing from allocation']++;
    mismatches.push(
      mismatchRow({
        Category: 'MFG: In Status (MFU/Manufacturing), missing from allocation',
        EmployeeID: id,
        Name: s.name,
        Detail: 'Status Department is MFU/Manufacturing but ID not in Manufacturing allocation',
        ...statusFields(s),
        AllocSource: 'MFG',
        Notes: '',
      })
    );
  }

  // --- C. Same ID in BOTH PMTA and MFG ---
  for (const id of pmta.byId.keys()) {
    if (!mfg.byId.has(id)) continue;
    const aP = pmta.byId.get(id);
    const aM = mfg.byId.get(id);
    const s = status.byId.get(id);
    categories['Cross: Same ID in BOTH PMTA and MFG allocations']++;
    mismatches.push(
      mismatchRow({
        Category: 'Cross: Same ID in BOTH PMTA and MFG allocations',
        EmployeeID: id,
        Name: (s && s.name) || aP.name || aM.name,
        Detail: `Listed on both allocations. PMTA Dep=${aP.subDept} Loc=${aP.location}/${aP.planning}; MFG Dept=${aM.department} Loc=${aM.location || 'n/a'}`,
        ...statusFields(s),
        AllocSource: 'PMTA+MFG',
        AllocDept: `PMTA:${aP.subDept}|MFG:${aM.department}`,
        AllocLocation: aP.location || aM.location,
        AllocPlanning: aP.planning,
        Notes: '',
      })
    );
  }

  const countCheck = buildCountCheck({
    statusRecords: status.records,
    pmtaRecords: pmta.records,
    mfgRecords: mfg.records,
    statusPath,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    statusCount: status.byId.size,
    pmtaCount: pmta.byId.size,
    mfgCount: mfg.byId.size,
    statusSheet: status.sheetName,
    pmtaSheet: pmta.sheetName,
    mfgSheet: mfg.sheetName,
    mfgSheetDate: mfg.sheetDate ? mfg.sheetDate.toISOString().slice(0, 10) : null,
    pmtaMatched,
    mfgMatched,
    totalMismatches: mismatches.length,
    categories,
    files: {
      status: statusPath,
      pmta: pmtaPath,
      mfg: mfgPath,
    },
    countCheck: countCheck.stats,
  };

  const result = {
    summary,
    mismatches,
    matches,
    countCheck,
    meta: {
      statusSheet: status.sheetName,
      pmtaSheet: pmta.sheetName,
      mfgSheet: mfg.sheetName,
      statusFile: statusPath,
      pmtaFile: pmtaPath,
      mfgFile: mfgPath,
    },
  };

  const paths = writeReports(outDir, result);
  return { ...result, paths, outDir };
}

module.exports = { runReconcile };

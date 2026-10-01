#!/usr/bin/env node
/**
 * CLI: reconcile Employee Status vs PMTA & Manufacturing daily allocation Excels.
 *
 * Usage:
 *   node src/reconcile.js --status path --pmta path --mfg path [--out output]
 *   node src/reconcile.js   # uses ./input/ defaults
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { runReconcile } = require('../lib/reconcile-core');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    status: path.join(ROOT, 'input', 'Employee_Status.xlsx'),
    pmta: path.join(ROOT, 'input', 'Allocation_PMTA.xlsx'),
    mfg: path.join(ROOT, 'input', 'Allocation_Manufacturing.xlsx'),
    out: path.join(ROOT, 'output'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status' && argv[i + 1]) args.status = argv[++i];
    else if (a === '--pmta' && argv[i + 1]) args.pmta = argv[++i];
    else if (a === '--mfg' && argv[i + 1]) args.mfg = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Seyenna Manpower Reconciler

Usage:
  node src/reconcile.js [--status path] [--pmta path] [--mfg path] [--out dir]

Defaults (relative to project root):
  --status  input/Employee_Status.xlsx
  --pmta    input/Allocation_PMTA.xlsx
  --mfg     input/Allocation_Manufacturing.xlsx
  --out     output/

Also: npm start   or   npm run reconcile
Web UI: node src/server.js  →  http://localhost:3847
`);
    process.exit(0);
  }

  for (const [label, p] of [
    ['status', args.status],
    ['pmta', args.pmta],
    ['mfg', args.mfg],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`Missing ${label} file: ${p}`);
      process.exit(1);
    }
  }

  console.log('Loading…');
  console.log('  Status:', args.status);
  console.log('  PMTA:  ', args.pmta);
  console.log('  MFG:   ', args.mfg);

  const result = runReconcile({
    statusPath: args.status,
    pmtaPath: args.pmta,
    mfgPath: args.mfg,
    outDir: args.out,
  });

  const s = result.summary;
  console.log('\n=== Summary ===');
  console.log(`Status employees:     ${s.statusCount}  (sheet: ${s.statusSheet})`);
  console.log(`PMTA allocation:      ${s.pmtaCount}  (sheet: ${s.pmtaSheet})`);
  console.log(`MFG allocation:       ${s.mfgCount}  (sheet: ${s.mfgSheet})`);
  console.log(`PMTA matched:         ${s.pmtaMatched}`);
  console.log(`MFG matched:          ${s.mfgMatched}`);
  console.log(`Total mismatch rows:  ${s.totalMismatches}`);
  if (result.countCheck && result.countCheck.stats) {
    const c = result.countCheck.stats;
    console.log('\n=== Count check (Status vs Alloc) ===');
    console.log(`PMTA Status total:     ${c.pmtaStatusTotal}  vs Alloc ${c.pmtaAllocTotal}  (diff ${c.pmtaStatusTotal - c.pmtaAllocTotal})`);
    console.log(`MFU Status total:      ${c.mfuStatusTotal}  vs MFG non-PMTA ${c.mfgAllocNonPmta}  (diff ${c.mfuStatusTotal - c.mfgAllocNonPmta})`);
    console.log(`Buckets matched/off:   ${c.bucketsMatched} / ${c.bucketsMismatched}`);
  }
  console.log('\nCategories:');
  for (const [k, v] of Object.entries(s.categories)) {
    if (v) console.log(`  ${v}\t${k}`);
  }
  console.log('\nWrote:');
  console.log(' ', result.paths.htmlPath);
  console.log(' ', result.paths.mismPath);
  console.log(' ', result.paths.matchPath);
  console.log(' ', result.paths.xlsxPath);
  console.log(' ', result.paths.sumPath);
}

main();

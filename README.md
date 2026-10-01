# Seyenna PMTA Module — Manpower Reconciliation

Reconciles three daily Excel manpower files and writes mismatch reports (HTML + CSV).

**Employee ID** is the unique key (normalized as trimmed digit string).

| File | Default name in `input/` |
|------|--------------------------|
| Company Employee Status | `Employee_Status.xlsx` |
| PMTA allocation | `Allocation_PMTA.xlsx` |
| Manufacturing allocation | `Allocation_Manufacturing.xlsx` |

Requires **Node.js 18+**. No `npm install` — pure Node (unzip + OOXML parser).

---

## Quick start (Web UI on localhost)

```bash
cd /Users/apple/Desktop/Seyenna_PMTA_Module
node src/server.js
```

Then open in your browser:

**http://localhost:3847**

1. Upload the three `.xlsx` files  
2. Click **Compare**  
3. View summary counts, then use **Download HTML report** and **Download Excel report (XLSX)** (CSV/JSON also available)

Stop the server with `Ctrl+C`.

Optional: `PORT=4000 node src/server.js` to use another port.

Same via npm scripts (no install needed):

```bash
npm run ui
# or
npm run server
```

---

## CLI (batch / scripting)

Drop daily files into `input/` with the names above, or pass paths:

```bash
cd /Users/apple/Desktop/Seyenna_PMTA_Module

# defaults → input/*.xlsx → output/
node src/reconcile.js

# or explicit paths
node src/reconcile.js \
  --status /path/to/Employee_Status.xlsx \
  --pmta   /path/to/Allocation_PMTA.xlsx \
  --mfg    /path/to/Allocation_Manufacturing.xlsx \
  --out    output
```

Also: `npm start` or `npm run reconcile`.

### Outputs (`output/`)

| File | Contents |
|------|----------|
| `report.html` | Readable HTML summary with counts and mismatch tables |
| `report.xlsx` | Excel workbook with sheets: **Summary**, **Mismatches**, **Matches** |
| `mismatches.csv` | All mismatch rows (Category, EmployeeID, Name, Detail, …) |
| `matches.csv` | IDs consistent across Status + allocation |
| `summary.json` | Machine-readable counts |

---

## Summary count check

The HTML/Excel reports include **Summary count check (Status vs Allocations)** — a table of Department × Location/bucket with Status count, Allocation count, Difference, and Match?.

- Status counts come from employee rows (and Status sheet `Summary: PMTA` / `Summary: MFU` blocks when present).
- PMTA allocation counts use LOCATION (with aliases e.g. BOOKED↔CAMP, ELITE X↔ELITEX); PLANNING as fallback.
- MFG counts use Department (Manufacturing Office/Yard ↔ MFU buckets). Totals compare Status MFU vs MFG non-PMTA rows.

See sheet **Count Check** in `report.xlsx`.

## What each mismatch category means

### PMTA department
- **In allocation, missing from Status** — on PMTA list but not in Employee Status  
- **In Status (PMTA dept), missing from allocation** — Status Department contains “PMTA” but ID not on PMTA allocation  
- **Field mismatch** — same ID in both, but name / designation / sub-dept (Status `Sub -Dept` vs PMTA `Dep`) / location (Status vs PMTA `LOCATION` and/or `PLANNING`) / department-division differs  

### Manufacturing department
- **In allocation, missing from Status** — on MFG list but not in Status  
- **In Status (MFU/Manufacturing), missing from allocation** — Status dept looks like MFU / Manufacturing / Office / Yard but ID not on latest MFG sheet  
- **Field mismatch** — name / designation / department / location (when MFG has Reporting Location)  

### Cross flags
- **MFG allocation with Department PMTA (temp transfer)** — temps from PMTA listed on MFG sheet  
- **Same ID in BOTH PMTA and MFG allocations** — dual listing  
- **Duplicate Employee ID within a source** — same ID twice in one file  

### Matches
IDs present in Status and the relevant allocation with consistent compared fields (counts + `matches.csv`).

---

## Manufacturing sheet selection

The Manufacturing workbook may contain several dated sheets (`20-9-26`, `30-9-26`, `1-10-26 `, …).  
The app picks the **latest** sheet by parsing `D-M-YY` from the sheet name.

---

## Project layout

```
Seyenna_PMTA_Module/
  input/           # drop daily Excels here (samples included)
  output/          # reports written here
  lib/             # xlsx parser, loaders, reconcile core, report writers
  public/          # web UI static files
  src/
    reconcile.js   # CLI
    server.js      # localhost UI (port 3847)
  package.json
  README.md
```

---

## Notes

- macOS/Linux need `unzip` on PATH (standard on Mac).  
- Do not delete the `.git` folder if present.  
- Sample inputs are already copied under `input/` for a first dry run.

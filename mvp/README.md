# Time-Tracking & Retainer Billing MVP — Apps Script modules

Owner-side time tracking, retainer billing, and tenant-isolated invoicing for
Google Sheets + Apps Script. Pure JavaScript modules: they run inside Apps
Script (V8) and as plain Node.js for testing. The pilot tenant is RNM
Enterprise LLC.

## Layout

- `apps-script/` — the 12 shipped modules
  - `TimeMath.js` — shift computation: overnight and multi-day shifts, break
    deductions, daily/weekly overtime, missing clock-outs, implausibility
    guards (spec vectors V1–V7)
  - `rate-catalog.js`, `line-items.js`, `sheet-gate.js` — org-scoped catalog
    lookup, frozen rate snapshots on saved work (V8, V11)
  - `invoice-gen.js`, `invoice-sheet.js` — invoice generation from approved
    work; open/submitted shifts block a period; cent-exact totals; void and
    release (V12)
  - `shift-repo.js`, `line-item-repo.js`, `catalog-repo.js` — tenant-scoped
    repositories; cross-tenant reads and writes fail closed
  - `rbac.js`, `audit-log.js`, `security-edge.js` — session-bound org
    identity, role matrix, audit on every mutation, Apps Script edge adapter
    (V9, V10)
- `tests/` — plain-node suites, no dependencies:
  `TimeMath.test.js`, `run-tests.js`, `invoice-gen.test.js`,
  `run-security-tests.js`

## Running the tests

```bash
node tests/TimeMath.test.js       # 16 tests, 46 assertions
node tests/run-tests.js           # 17 tests (V8, V11)
node tests/invoice-gen.test.js    # 13 tests (V12)
node tests/run-security-tests.js  # 26 tests (V9, V10)
```

Current status: all four suites pass (72 tests total).

## Deploying

The deployment guide recreates the eight-tab Google Sheet, installs these
modules, wires the web app, and walks all twelve acceptance vectors
end to end. See the guide in the Obvious project:
"Deployment Guide & Pilot Checklist — Time-Tracking & Retainer Billing MVP".

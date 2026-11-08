/**
 * InvoiceGen.test.js — acceptance vector V12 plus numbering, totals,
 * void/release, and cent-exactness coverage. Dependency-free; run with:
 *   node invoice-gen.test.js
 *
 * Fixtures mirror the seeded pilot workbook (RNM Enterprise LLC, week
 * 2026-11-01 .. 2026-11-07): three time-log rows (one submitted, one open,
 * one approved) and two unbilled lines.
 */
'use strict';

const assert = require('assert');
const InvoiceGen = require('../apps-script/invoice-gen.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + e.message);
  }
}

function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected,
    label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// ---- Fixtures (seeded workbook values) -------------------------------------

const ORG_RNM = {
  OrgID: 'org-rnm', LegalName: 'RNM Enterprise LLC', DBAName: null,
  BillingEmail: 'billing@rnmenterprise.com', BillingAddress: '123 Main St, Houston, TX',
  Timezone: 'America/Chicago', WeekStartDay: '0', OTDailyHours: '8.0',
  OTWeeklyHours: '40.0', InvoicePrefix: 'RNM', InvoiceSeq: '1', IsActive: 'TRUE'
};

function timeLogRow(shiftId, techId, workDate, netHours, status) {
  return {
    ShiftID: shiftId, OrgID: 'org-rnm', TechnicianID: techId, WorkDate: workDate,
    ClockIn: workDate + 'T08:00:00-06:00', ClockOut: workDate + 'T16:00:00-06:00',
    BreakMin: '0', RawHours: '8.00', NetHours: netHours,
    CrossMidnight: 'FALSE', OTFlag: '', Status: status, ApprovedBy: '', Notes: ''
  };
}

function timeLogFixture() {
  return [
    timeLogRow('shf-rnm-001', 'usr-rnm-tech-1', '2026-11-02', '12.00', 'submitted'), // overnight shift
    timeLogRow('shf-rnm-002', 'usr-rnm-tech-2', '2026-11-03', '', 'open'),           // missing clock-out
    timeLogRow('shf-rnm-003', 'usr-rnm-tech-1', '2026-11-04', '7.50', 'approved')
  ];
}

function lineFixture() {
  return [
    { LineID: 'lin-rnm-001', OrgID: 'org-rnm', ShiftID: 'shf-rnm-001', WorkDate: '2026-11-02',
      TaskKey: 'svc-rnm-001', TaskName: 'General Labor', TaskType: 'hourly', Quantity: '12.00',
      UnitLabel: 'hr', RateSnapshot: '65.00', LineTotal: '780.00', Category: 'Services', InvoiceID: null },
    { LineID: 'lin-rnm-002', OrgID: 'org-rnm', ShiftID: 'shf-rnm-003', WorkDate: '2026-11-04',
      TaskKey: 'svc-rnm-002', TaskName: 'Filter Change', TaskType: 'unit_flat', Quantity: '4.00',
      UnitLabel: 'unit', RateSnapshot: '18.00', LineTotal: '72.00', Category: 'Maintenance', InvoiceID: '' }
  ];
}

const WEEK = ['2026-11-01', '2026-11-07']; // Sunday .. Saturday
const manager = { userId: 'usr-rnm-mgr', orgId: 'org-rnm', role: 'manager' };

console.log('InvoiceGen unit tests — V12 + invoice section (spec art_SHLLdADT)');
console.log('node ' + process.version + '\n');

// ─── V12: generation refuses while shifts are unapproved ─────────────────────

console.log('V12 — invoice guard against unapproved work');

test('V12: generation blocked while a submitted shift exists; blocking rows listed by technician and date', () => {
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLogFixture(), lineRows: lineFixture(), existingInvoices: []
  });
  eq(result.ok, false, 'ok');
  eq(result.error, 'BLOCKING_SHIFTS', 'error');
  eq(result.blocking, [
    { shiftId: 'shf-rnm-001', technicianId: 'usr-rnm-tech-1', workDate: '2026-11-02', status: 'submitted' },
    { shiftId: 'shf-rnm-002', technicianId: 'usr-rnm-tech-2', workDate: '2026-11-03', status: 'open' }
  ], 'blocking rows name technician and date');
  eq(result.invoice, undefined, 'no invoice is produced');
});

test('V12: after approval the same period generates cleanly', () => {
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'approved'; // manager approved the overnight shift
  timeLog[1].Status = 'approved'; // open shift closed and approved too
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLog, lineRows: lineFixture(), existingInvoices: []
  });
  eq(result.ok, true, 'ok');
  eq(result.invoice.status, 'draft', 'status');
  eq(result.invoiceLines.length, 2, 'both lines materialize');
});

test('V12: rejected shifts do not block; their lines are not billed', () => {
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'rejected';
  timeLog[1].Status = 'approved';
  const lines = lineFixture();
  lines[0].ShiftID = 'shf-rnm-001'; // line on the rejected shift
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLog, lineRows: lines, existingInvoices: []
  });
  eq(result.ok, true, 'ok');
  eq(result.invoiceLines.length, 1, 'only the approved-shift line bills');
  eq(result.invoiceLines[0].lineId, 'lin-rnm-002', 'the rejected shift line is excluded');
});

test('V12: guard is org-scoped — another org\'s open shift never blocks RNM', () => {
  const timeLog = timeLogFixture().concat([
    timeLogRow('shf-org-b-1', 'usr-org-b-tech', '2026-11-05', '8.00', 'open')
  ]);
  timeLog[timeLog.length - 1].OrgID = 'org-b';
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLog, lineRows: lineFixture(), existingInvoices: []
  });
  // Only RNM's own rows remain blocking (the fixture's open/submitted RNM rows).
  eq(result.blocking.every((b) => b.shiftId.indexOf('org-b') === -1), true,
    'org-b rows must not appear in RNM blocking list');
});

// ─── Header totals & cent-exactness ─────────────────────────────────────────

console.log('\nHeader totals — SUMIFS equivalents, cent-exact gross');

test('billableHours counts APPROVED frozen NetHours only', () => {
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'approved'; // 12.00 now approved
  timeLog[1].Status = 'approved'; // 0 hours on the closed-out shift
  const hours = InvoiceGen.sumBillableHours(timeLog, 'org-rnm', WEEK[0], WEEK[1]);
  eq(hours, 19.5, '12.00 + 7.50');
});

test('header gross is cent-exact against the sum of printed invoice lines', () => {
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'approved';
  timeLog[1].Status = 'approved';
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLog, lineRows: lineFixture(), existingInvoices: []
  });
  eq(result.ok, true, 'ok');
  const printedSum = result.invoiceLines.reduce((s, l) => s + l.lineTotal, 0);
  eq(result.invoice.grossPayout, 852, '780 + 72');
  eq(result.invoice.grossPayout, Math.round(printedSum * 100) / 100, 'gross === sum of lines');
  eq(result.invoice.hourlyPayout, 780, 'hourly lines → HourlyPayout');
  eq(result.invoice.categoryTotals, { Maintenance: 72 }, 'non-hourly lines itemize by category');
});

test('cent-exactness holds for fraction-of-a-cent line products with a negative adjustment', () => {
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'approved';
  timeLog[1].Status = 'approved';
  const lines = lineFixture().concat([
    { LineID: 'lin-rnm-003', OrgID: 'org-rnm', ShiftID: '', WorkDate: '2026-11-05',
      TaskKey: 'svc-rnm-003', TaskName: 'Refrigerant R-410A', TaskType: 'material',
      Quantity: '0.333', UnitLabel: 'lb', RateSnapshot: '14.00', LineTotal: '4.66',
      Category: 'Materials', InvoiceID: null }
  ]);
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLog, lineRows: lines, existingInvoices: [],
    adjustment: -25.00, adjustmentNote: 'Damage credit'
  });
  const printedSum = result.invoiceLines.reduce((s, l) => s + l.lineTotal, 0);
  eq(result.invoice.grossPayout, Math.round(printedSum * 100) / 100 - 25,
    'gross = rounded line sum + adjustment, never re-rounded lines');
  eq(result.invoice.grossPayout, 831.66, '780 + 72 + 4.66 - 25');
});

test('already-stamped lines are excluded — no double billing', () => {
  const lines = lineFixture();
  lines[0].InvoiceID = 'RNM-2026-0001';
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'approved';
  timeLog[1].Status = 'approved';
  const picked = InvoiceGen.eligibleLines(lines, 'org-rnm', WEEK[0], WEEK[1], timeLog);
  eq(picked.map((l) => l.LineID), ['lin-rnm-002'], 'stamped line is out');
});

// ─── Numbering ───────────────────────────────────────────────────────────────

console.log('\nNumbering — RNM-YYYY-NNN');

test('first invoice for RNM is RNM-2026-0001; sequence advances', () => {
  const result = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLogFixture(), lineRows: lineFixture(), existingInvoices: []
  });
  // Guard blocks, so numbering is asserted via the pure helper instead:
  const numbered = InvoiceGen.nextInvoiceNumber(ORG_RNM, [], '2026-11-07');
  eq(numbered.invoiceNumber, 'RNM-2026-0001', 'first number');
  eq(numbered.invoiceSeq, 2, 'seq advanced');
  eq(InvoiceGen.nextInvoiceNumber(ORG_RNM, [{ InvoiceNumber: 'RNM-2026-0001' }], '2026-11-07').invoiceNumber,
    'RNM-2026-0002', 'existing numbers are skipped');
  eq(InvoiceGen.isoWeekNumber('2026-11-07'), 45, 'ISO week of period end');
});

// ─── Authorization & validation ───────────────────────────────────────────────

console.log('\nAuthorization & validation');

test('technicians cannot generate invoices', () => {
  const result = InvoiceGen.generateWeeklyInvoice(
    { userId: 'usr-rnm-tech-1', orgId: 'org-rnm', role: 'technician' },
    WEEK[0], WEEK[1],
    { org: ORG_RNM, timeLogRows: [], lineRows: [], existingInvoices: [] });
  eq(result.error, 'FORBIDDEN_ROLE', 'error');
});

test('unscoped or invalid calls fail closed', () => {
  assert.throws(() => InvoiceGen.findBlockingShifts([], null, WEEK[0], WEEK[1]), /ORG_SCOPE_REQUIRED/);
  assert.throws(() => InvoiceGen.generateWeeklyInvoice({ role: 'manager' }, WEEK[0], WEEK[1], {}), /ORG_SCOPE_REQUIRED/);
  const badPeriod = InvoiceGen.generateWeeklyInvoice(manager, WEEK[1], WEEK[0], {
    org: ORG_RNM, timeLogRows: [], lineRows: [], existingInvoices: [] });
  eq(badPeriod.error, 'INVALID_PERIOD', 'start after end rejected');
});

// ─── Void / release ───────────────────────────────────────────────────────────

console.log('\nVoid / release path');

test('void sets status and releases every line back to unbilled', () => {
  const timeLog = timeLogFixture();
  timeLog[0].Status = 'approved';
  timeLog[1].Status = 'approved';
  const generated = InvoiceGen.generateWeeklyInvoice(manager, WEEK[0], WEEK[1], {
    org: ORG_RNM, timeLogRows: timeLog, lineRows: lineFixture(), existingInvoices: []
  });
  eq(generated.ok, true, 'ok');
  const voided = InvoiceGen.voidInvoice(generated.invoice, generated.invoiceLines);
  eq(voided.ok, true, 'ok');
  eq(voided.invoice.status, 'void', 'status');
  eq(voided.releasedLineIds, ['lin-rnm-001', 'lin-rnm-002'], 'all lines released');
  eq(voided.invoice.invoiceNumber, generated.invoice.invoiceNumber, 'number preserved');
});

test('a voided invoice cannot be voided twice', () => {
  const invoice = { invoiceNumber: 'RNM-2026-0001', status: 'void' };
  const result = InvoiceGen.voidInvoice(invoice, [{ lineId: 'lin-1' }]);
  eq(result.ok, false, 'ok');
  eq(result.error, 'ALREADY_VOID', 'error');
});

// ---- Summary ----------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

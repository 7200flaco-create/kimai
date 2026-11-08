/**
 * Unit tests for the rate-catalog / line-item snapshot module.
 * Run: node tests/run-tests.js   (plain node, no dependencies)
 *
 * Spec vectors under test:
 *   V8  — Org A "Repair" = $65/hr; Org B "Repair" = $90/hr: each lookup
 *         resolves by OrgID|TaskName; no path returns the other org's price.
 *   V11 — Manager edits the catalog rate after work is approved/saved:
 *         existing line items and invoice totals are unchanged (frozen
 *         snapshots).
 */
'use strict';

var assert = require('assert');
var RateCatalog = require('../apps-script/rate-catalog.js');
var LineItems = require('../apps-script/line-items.js');

// ---- Fixtures -------------------------------------------------------------
// Two tenant rows plus the real pilot (RNM) rows from the seeded workbook.

function catalogRow(orgId, svcId, taskName, taskType, unit, rate, category) {
  return {
    OrgID: orgId, ServiceID: svcId, TaskName: taskName, TaskType: taskType,
    UnitLabel: unit, Rate: rate, Category: category, Billable: 'TRUE',
    IsActive: 'TRUE'
  };
}

function fixtureCatalog() {
  return [
    // V8 collision pair: same task name, two tenants, different rates.
    catalogRow('org-a', 'svc-a-repair', 'Repair', 'hourly', 'hr', 65, 'Services'),
    catalogRow('org-b', 'svc-b-repair', 'Repair', 'hourly', 'hr', 90, 'Services'),
    // org-b-only task — must never appear in org-a's dropdown payload.
    catalogRow('org-b', 'svc-b-secret', 'Confidential Inspection', 'hourly', 'hr', 120, 'Services'),
    // Pilot tenant rows (workbook seed).
    catalogRow('org-rnm', 'svc-rnm-001', 'General Labor', 'hourly', 'hr', 65, 'Services'),
    catalogRow('org-rnm', 'svc-rnm-002', 'Filter Change', 'unit_flat', 'unit', 18, 'Maintenance'),
    catalogRow('org-rnm', 'svc-rnm-003', 'Refrigerant R-410A', 'material', 'lb', 14, 'Materials'),
    catalogRow('org-rnm', 'svc-rnm-004', 'Equipment Install Package', 'job_fixed', 'job', 850, 'Installations')
  ];
}

function ctxFor(orgId) {
  return { userId: 'usr-' + orgId, orgId: orgId, role: 'technician' };
}

// ---- Tiny harness ----------------------------------------------------------

var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name: name, err: err });
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

// ---- V8: cross-tenant task-name collision ----------------------------------

console.log('\nV8 — task name collision across tenants (OrgID|TaskName key)');

test('V8: composite keys for the same task name differ per org', function () {
  var keyA = RateCatalog.catalogKey('org-a', 'Repair');
  var keyB = RateCatalog.catalogKey('org-b', 'Repair');
  assert.notStrictEqual(keyA, keyB);
  assert.strictEqual(keyA, 'org-a|Repair');
  assert.strictEqual(keyB, 'org-b|Repair');
});

test('V8: lookup by name resolves each org to its OWN price', function () {
  var rows = fixtureCatalog();
  var a = RateCatalog.findActiveByTaskName(rows, 'org-a', 'Repair');
  var b = RateCatalog.findActiveByTaskName(rows, 'org-b', 'Repair');
  assert.strictEqual(a.rate, 65, 'org-a Repair should be $65/hr');
  assert.strictEqual(b.rate, 90, 'org-b Repair should be $90/hr');
  assert.strictEqual(a.serviceId, 'svc-a-repair');
  assert.strictEqual(b.serviceId, 'svc-b-repair');
});

test('V8: dropdown payload for org-a contains zero org-b task names', function () {
  var rows = fixtureCatalog();
  var payload = RateCatalog.catalogForOrg(rows, 'org-a');
  assert.ok(payload.length > 0, 'payload must not be empty');
  payload.forEach(function (item) {
    assert.strictEqual(item.serviceId.indexOf('svc-b-'), -1,
      'org-a payload leaked an org-b serviceId');
    assert.notStrictEqual(item.taskName, 'Confidential Inspection');
    // Every same-named task carries org-a's price, never org-b's.
    if (item.taskName === 'Repair') {
      assert.strictEqual(item.rate, 65);
    }
  });
});

test('V8: a name lookup for a task only org-b defines returns null (no leak)', function () {
  var rows = fixtureCatalog();
  assert.strictEqual(RateCatalog.findActiveByTaskName(rows, 'org-a', 'Confidential Inspection'), null);
});

test('V8: cross-tenant write attempt — org-b tech submits org-a serviceId', function () {
  var rows = fixtureCatalog();
  var result = LineItems.buildLineItem(ctxFor('org-b'), {
    serviceId: 'svc-a-repair', workDate: '2026-11-04', quantity: 2
  }, rows);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'SERVICE_NOT_IN_YOUR_CATALOG');
});

test('V8: unknown serviceId and foreign serviceId produce the SAME error (no existence leak)', function () {
  var rows = fixtureCatalog();
  var foreign = LineItems.buildLineItem(ctxFor('org-a'), { serviceId: 'svc-b-repair', workDate: '2026-11-04', quantity: 1 }, rows);
  var unknown = LineItems.buildLineItem(ctxFor('org-a'), { serviceId: 'svc-nope', workDate: '2026-11-04', quantity: 1 }, rows);
  assert.strictEqual(foreign.error, unknown.error);
});

test('V8: lookups without an org scope fail closed', function () {
  var rows = fixtureCatalog();
  assert.throws(function () { RateCatalog.catalogForOrg(rows, ''); }, /ORG_SCOPE_REQUIRED/);
  assert.throws(function () { RateCatalog.findActiveByTaskName(rows, null, 'Repair'); }, /ORG_SCOPE_REQUIRED/);
  assert.throws(function () { RateCatalog.findActiveByServiceId(rows, undefined, 'svc-a-repair'); }, /ORG_SCOPE_REQUIRED/);
  assert.throws(function () { LineItems.buildLineItem({ role: 'technician' }, { serviceId: 'svc-a-repair', quantity: 1 }, rows); }, /ORG_SCOPE_REQUIRED/);
});

// ---- Line math (all four task types) ---------------------------------------

console.log('\nLine math — all four task types');

test('hourly / unit_flat / material price quantity × rate', function () {
  assert.strictEqual(RateCatalog.computeLineTotal('hourly', 12, 65), 780);
  assert.strictEqual(RateCatalog.computeLineTotal('unit_flat', 4, 18), 72);
  assert.strictEqual(RateCatalog.computeLineTotal('material', 1.5, 14), 21);
});

test('job_fixed ignores quantity — the rate IS the job price', function () {
  assert.strictEqual(RateCatalog.computeLineTotal('job_fixed', 1, 850), 850);
  assert.strictEqual(RateCatalog.computeLineTotal('job_fixed', 99, 850), 850);
});

test('unknown task type throws loudly, never silently prices 0', function () {
  assert.throws(function () { RateCatalog.computeLineTotal('retainer', 1, 100); }, /UNKNOWN_TASK_TYPE/);
});

test('lines round to cents at the line level', function () {
  // 0.333 lb × $14 = $4.662 → $4.66; a fraction-of-a-cent product must not
  // flow into the invoice unrounded.
  assert.strictEqual(RateCatalog.computeLineTotal('material', 0.333, 14), 4.66);
  assert.strictEqual(RateCatalog.computeLineTotal('material', 0.001, 14), 0.01);
});

// ---- V11: freeze — rate change after save cannot re-price -------------------

console.log('\nV11 — rate change after approval cannot re-price saved lines');

test('V11: snapshot frozen at save; catalog edit leaves item and invoice total untouched', function () {
  var rows = fixtureCatalog();
  var result = LineItems.buildLineItem(ctxFor('org-a'), {
    serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 12, shiftId: 'shf-1'
  }, rows, { lineId: 'lin-1' });
  assert.strictEqual(result.ok, true);
  var saved = result.item;
  assert.strictEqual(saved.rateSnapshot, 65);
  assert.strictEqual(saved.lineTotal, 780);

  // Manager edits the rate on Tuesday — the catalog row now says $90.
  rows[0].Rate = 90;

  // The saved line item is untouched...
  assert.strictEqual(saved.rateSnapshot, 65, 'snapshot must not track live catalog');
  assert.strictEqual(saved.lineTotal, 780, 'frozen total must not re-price');
  // ...and the invoice rollup — which only reads frozen line values — too.
  var invoice = LineItems.sumFrozenLineTotals([saved]);
  assert.strictEqual(invoice, 780, 'invoice total re-priced from live catalog!');
});

test('V11: rate change re-prices only NEW work, never the old line', function () {
  var rows = fixtureCatalog();
  var before = LineItems.buildLineItem(ctxFor('org-a'), { serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 12 }, rows, { lineId: 'lin-1' }).item;
  rows[0].Rate = 90; // mid-week rate edit
  var after = LineItems.buildLineItem(ctxFor('org-a'), { serviceId: 'svc-a-repair', workDate: '2026-11-05', quantity: 12 }, rows, { lineId: 'lin-2' }).item;
  assert.strictEqual(before.lineTotal, 780);
  assert.strictEqual(after.lineTotal, 1080, 'new work should price at the new rate');
});

test('V11: a stamped (invoiced) line is excluded from the next unbilled run — no double billing', function () {
  var billed = { lineId: 'lin-1', lineTotal: 780, invoiceId: 'inv-001' };
  var unbilled = { lineId: 'lin-2', lineTotal: 1080, invoiceId: null };
  assert.strictEqual(LineItems.sumFrozenLineTotals([billed, unbilled], null), 1080);
  assert.strictEqual(LineItems.sumFrozenLineTotals([billed, unbilled], 'inv-001'), 780);
});

test('V11: rollup sums rounded lines — cent-exact with the printed invoice', function () {
  var lines = [
    { lineId: 'l1', lineTotal: RateCatalog.computeLineTotal('hourly', 1.005, 65), invoiceId: null },
    { lineId: 'l2', lineTotal: RateCatalog.computeLineTotal('hourly', 0.005, 65), invoiceId: null }
  ];
  var sum = LineItems.sumFrozenLineTotals(lines, null);
  assert.strictEqual(sum, RateCatalog.round2(lines[0].lineTotal + lines[1].lineTotal));
});

// ---- Input validation -------------------------------------------------------

console.log('\nInput validation');

test('quantity must be positive', function () {
  var rows = fixtureCatalog();
  [0, -1, 'abc', null].forEach(function (q) {
    var r = LineItems.buildLineItem(ctxFor('org-a'), { serviceId: 'svc-a-repair', workDate: '2026-11-04', quantity: q }, rows);
    assert.strictEqual(r.error, 'INVALID_QUANTITY', 'quantity ' + q + ' should be rejected');
  });
});

test('inactive catalog entries cannot be picked or saved against', function () {
  var rows = fixtureCatalog();
  rows[0].IsActive = 'FALSE';
  assert.strictEqual(RateCatalog.findActiveByTaskName(rows, 'org-a', 'Repair'), null);
  var r = LineItems.buildLineItem(ctxFor('org-a'), { serviceId: 'svc-a-repair', workDate: '2026-11-04', quantity: 1 }, rows);
  assert.strictEqual(r.error, 'SERVICE_NOT_IN_YOUR_CATALOG');
});

// ---- Summary ----------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  process.exit(1);
}

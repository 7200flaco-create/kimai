/**
 * Unit tests for the security layer (spec art_SHLLdADT, "Access control" +
 * verification vectors). Run: node tests/run-security-tests.js — plain node,
 * no dependencies.
 *
 * Acceptance vectors under test:
 *   V9  — cross-tenant WRITE denied: an org-a technician submits a
 *         serviceId belonging to org-b → SERVICE_NOT_IN_YOUR_CATALOG,
 *         nothing persisted, denial audited.
 *   V10 — cross-tenant READ denied: an org-b manager requests an org-a
 *         shift id directly → zero rows, the same NOT_FOUND as a missing
 *         id, no error text reveals the other org.
 * Plus: session-bound org identity, the permission matrix, audit-on-every-
 * mutation (success AND denial), audit-reader scoping, and the sheet
 * adapter glue under mocked SpreadsheetApp/Session.
 */
'use strict';

// The pure modules are standalone IIFEs; recreate the Apps Script shared
// global scope before loading the edge (which wires these as globals).
globalThis.RateCatalog = require('../apps-script/rate-catalog.js');
globalThis.LineItems = require('../apps-script/line-items.js');
globalThis.Rbac = require('../apps-script/rbac.js');
globalThis.AuditLog = require('../apps-script/audit-log.js');
globalThis.ShiftRepo = require('../apps-script/shift-repo.js');
globalThis.LineItemRepo = require('../apps-script/line-item-repo.js');
globalThis.CatalogAdmin = require('../apps-script/catalog-repo.js');
// Load-safe at require time: the edge only references the Google services
// inside function bodies, never at load. Mocks are installed below before
// any handler runs.
var SecurityEdge = require('../apps-script/security-edge.js');

var assert = require('assert');

// ---- Fixtures --------------------------------------------------------------

var CLOCK = new Date('2026-11-08T12:00:00Z');
var idSeq = 0;

function userRow(userId, email, orgId, role, isActive) {
  return { UserID: userId, Email: email, FullName: userId,
           OrgID: orgId, Role: role, IsActive: isActive || 'TRUE' };
}

function catalogRow(orgId, svcId, taskName, taskType, rate) {
  return { OrgID: orgId, ServiceID: svcId, TaskName: taskName, TaskType: taskType,
           UnitLabel: taskType === 'hourly' ? 'hr' : 'unit', Rate: rate,
           Category: 'Services', Billable: 'TRUE', IsActive: 'TRUE' };
}

function shiftRow(shiftId, orgId, techId, status) {
  return { ShiftID: shiftId, OrgID: orgId, TechnicianID: techId,
           WorkDate: '2026-11-02',
           ClockIn: '2026-11-02T19:00:00-06:00', ClockOut: '2026-11-03T07:00:00-06:00',
           BreakMin: 0, RawHours: '', NetHours: '', CrossMidnight: '', OTFlag: '',
           Status: status, ApprovedBy: '', Notes: '' };
}

function freshSeed() {
  return {
    users: [
      userRow('usr-a-tech', 'tech@a.example', 'org-a', 'technician'),
      userRow('usr-a-tech2', 'tech2@a.example', 'org-a', 'technician'),
      userRow('usr-a-mgr', 'mgr@a.example', 'org-a', 'manager'),
      userRow('usr-a-adm', 'adm@a.example', 'org-a', 'admin'),
      userRow('usr-b-tech', 'tech@b.example', 'org-b', 'technician'),
      userRow('usr-b-mgr', 'mgr@b.example', 'org-b', 'manager'),
      userRow('usr-root', 'root@platform.example', '', 'platform_admin'),
      userRow('usr-ghost', 'ghost@a.example', 'org-a', 'technician', 'FALSE'),
      userRow('usr-broken', 'broken@a.example', '', 'technician')
    ],
    catalog: [
      catalogRow('org-a', 'svc-a-repair', 'Repair', 'hourly', 65),
      catalogRow('org-b', 'svc-b-repair', 'Repair', 'hourly', 90)
    ],
    shifts: [
      shiftRow('shf-a-1', 'org-a', 'usr-a-tech', 'submitted'),
      shiftRow('shf-a-2', 'org-a', 'usr-a-tech', 'open'),
      shiftRow('shf-a-3', 'org-a', 'usr-a-tech2', 'submitted'),
      shiftRow('shf-b-1', 'org-b', 'usr-b-tech', 'submitted')
    ],
    lineItems: [],
    audit: []
  };
}

/** Same interface as SecurityEdge.AppsScriptData — that's the contract. */
function inMemoryData(seed) {
  return {
    getRows: function (tab) { return seed[tab]; },
    appendRow: function (tab, row) { seed[tab].push(row); return row; },
    updateRows: function (tab, matchFn, patch) {
      var updated = 0;
      seed[tab].forEach(function (row) {
        if (!matchFn(row)) return;
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) row[k] = patch[k];
        }
        updated++;
      });
      return updated;
    }
  };
}

function freshDeps(seed) {
  var data = inMemoryData(seed);
  return {
    data: data,
    audit: AuditLog.createWriter(data, function () { return CLOCK; }),
    rbac: Rbac,
    buildLineItem: LineItems.buildLineItem,
    computeLineTotal: RateCatalog.computeLineTotal,
    newId: function () { return 'gen-' + (++idSeq); },
    clock: function () { return CLOCK; }
  };
}

function ctxFor(userId, email, orgId, role) {
  return { userId: userId, email: email, orgId: orgId, role: role };
}

function techA() { return ctxFor('usr-a-tech', 'tech@a.example', 'org-a', 'technician'); }
function mgrA()  { return ctxFor('usr-a-mgr', 'mgr@a.example', 'org-a', 'manager'); }
function admA()  { return ctxFor('usr-a-adm', 'adm@a.example', 'org-a', 'admin'); }
function mgrB()  { return ctxFor('usr-b-mgr', 'mgr@b.example', 'org-b', 'manager'); }
function root()  { return ctxFor('usr-root', 'root@platform.example', null, 'platform_admin'); }

var FROZEN = { rawHours: 12, netHours: 12, otFlag: 'DAILY' };

// ---- Tiny harness (same shape as run-tests.js) ------------------------------

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
    console.log('        ' + (err && err.message));
  }
}

// ---- Session gate — session-bound org identity ------------------------------

console.log('\nSession gate — every request resolves to exactly one org');

test('gate binds the session to one org and lowercases the email', function () {
  var seen = null;
  var gate = Rbac.withAuth(
    { resolveEmail: function () { return 'MGR@A.Example'; },
      loadUsers: function () { return freshSeed().users; } },
    function (ctx, payload) { seen = { ctx: ctx, payload: payload }; return { ok: true }; }
  );
  var res = gate({});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(seen.ctx.orgId, 'org-a');
  assert.strictEqual(seen.ctx.role, 'manager');
  assert.strictEqual(seen.ctx.email, 'mgr@a.example');
});

test('unknown email fails closed — handler never runs', function () {
  var called = false;
  var gate = Rbac.withAuth(
    { resolveEmail: function () { return 'nobody@nowhere.example'; },
      loadUsers: function () { return freshSeed().users; } },
    function () { called = true; return { ok: true }; }
  );
  var res = gate({});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'ACCESS_DENIED');
  assert.strictEqual(called, false);
});

test('inactive user fails closed', function () {
  var gate = Rbac.withAuth(
    { resolveEmail: function () { return 'ghost@a.example'; },
      loadUsers: function () { return freshSeed().users; } },
    function () { return { ok: true }; }
  );
  assert.strictEqual(gate({}).error, 'ACCESS_DENIED');
});

test('corrupt tenant row (no OrgID) fails closed', function () {
  var gate = Rbac.withAuth(
    { resolveEmail: function () { return 'broken@a.example'; },
      loadUsers: function () { return freshSeed().users; } },
    function () { return { ok: true }; }
  );
  assert.strictEqual(gate({}).error, 'ACCESS_DENIED');
});

test('payload orgId/userId are stripped — the org comes from the session', function () {
  var seen = null;
  var gate = Rbac.withAuth(
    { resolveEmail: function () { return 'tech@a.example'; },
      loadUsers: function () { return freshSeed().users; } },
    function (ctx, payload) { seen = { ctx: ctx, payload: payload }; return { ok: true }; }
  );
  gate({ serviceId: 'svc-a-repair', orgId: 'org-b', userId: 'usr-b-tech' });
  assert.strictEqual(seen.ctx.orgId, 'org-a');
  assert.strictEqual(seen.payload.orgId, undefined);
  assert.strictEqual(seen.payload.userId, undefined);
  assert.strictEqual(seen.payload.serviceId, 'svc-a-repair');
});

// ---- V9 — cross-tenant write denied ------------------------------------------

console.log('\nV9 — cross-tenant write attempt (audit row, nothing persisted)');

test('V9: org-a technician submitting org-b serviceId is rejected and audited', function () {
  var seed = freshSeed();
  var repos = { lines: LineItemRepo.create(freshDeps(seed)) };

  var res = repos.lines.save(techA(), {
    serviceId: 'svc-b-repair', workDate: '2026-11-04', quantity: 2
  });

  assert.strictEqual(res.ok, false, 'the write must be rejected');
  assert.strictEqual(res.error, 'SERVICE_NOT_IN_YOUR_CATALOG');
  assert.strictEqual(seed.lineItems.length, 0, 'no line item may be persisted');

  assert.strictEqual(seed.audit.length, 1, 'the denial must be audited');
  var row = seed.audit[0];
  assert.strictEqual(row.Action, 'access_denied');
  assert.strictEqual(row.Entity, 'line_item');
  assert.strictEqual(row.OrgID, 'org-a');
  assert.strictEqual(row.ActorEmail, 'tech@a.example');
  assert.strictEqual(row.Timestamp, CLOCK);
  var after = JSON.parse(row.After);
  assert.strictEqual(after.reason, 'SERVICE_NOT_IN_YOUR_CATALOG');
  assert.strictEqual(after.entityId, 'svc-b-repair');
});

test('V9: the same denial through the session gate, with a spoofed payload orgId', function () {
  var seed = freshSeed();
  var lines = LineItemRepo.create(freshDeps(seed));
  var gate = Rbac.withAuth(
    { resolveEmail: function () { return 'tech@a.example'; },
      loadUsers: function () { return seed.users; } },
    function (ctx, payload) { return lines.save(ctx, payload); }
  );
  var res = gate({ serviceId: 'svc-b-repair', workDate: '2026-11-04', quantity: 1, orgId: 'org-b' });
  assert.strictEqual(res.error, 'SERVICE_NOT_IN_YOUR_CATALOG');
  assert.strictEqual(seed.lineItems.length, 0);
  assert.strictEqual(seed.audit[0].OrgID, 'org-a', 'the spoofed org must be ignored');
});

test('V9: foreign and unknown serviceIds produce the SAME error (no existence leak)', function () {
  var seed = freshSeed();
  var lines = LineItemRepo.create(freshDeps(seed));
  var foreign = lines.save(techA(), { serviceId: 'svc-b-repair', workDate: '2026-11-04', quantity: 1 });
  var unknown = lines.save(techA(), { serviceId: 'svc-nope', workDate: '2026-11-04', quantity: 1 });
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(foreign.error, unknown.error);
});

// ---- V10 — cross-tenant read denied ------------------------------------------

console.log('\nV10 — cross-tenant read attempt (zero rows, no leak)');

test('V10: org-b manager reading an org-a shift id gets null — same as a missing id', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  assert.strictEqual(shifts.findById(mgrB(), 'shf-a-1'), null);
  assert.strictEqual(shifts.findById(mgrB(), 'no-such-shift'), null);
});

test('V10: org-b manager approving an org-a shift gets the same NOT_FOUND as a missing shift', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));

  var foreign = shifts.approve(mgrB(), 'shf-a-1', FROZEN);
  var missing = shifts.approve(mgrB(), 'no-such-shift', FROZEN);

  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(foreign.error, missing.error, 'identical responses — no leak');
  assert.strictEqual(foreign.error, 'NOT_FOUND');

  // The foreign row is untouched.
  assert.strictEqual(seed.shifts[0].Status, 'submitted');
  assert.strictEqual(seed.shifts[0].ApprovedBy, '');
});

test('V10: org-scoped listing never contains another org\'s rows', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  var visible = shifts.findVisible(mgrB());
  assert.strictEqual(visible.length, 1);
  visible.forEach(function (r) { assert.strictEqual(r.OrgID, 'org-b'); });
});

test('V10: technician sees only their own rows', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  var visible = shifts.findVisible(techA());
  assert.strictEqual(visible.length, 2); // shf-a-1 + shf-a-2, not tech2's shf-a-3
  visible.forEach(function (r) {
    assert.strictEqual(r.TechnicianID, 'usr-a-tech');
  });
  assert.strictEqual(shifts.findById(techA(), 'shf-b-1'), null);
  assert.strictEqual(shifts.findById(techA(), 'shf-a-3'), null, 'another technician\'s shift is invisible too');
});

test('V10: reads are not mutations — no audit rows are written by find*', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  shifts.findById(mgrB(), 'shf-a-1');
  shifts.findVisible(mgrB());
  shifts.findVisible(techA());
  assert.strictEqual(seed.audit.length, 0);
});

// ---- Permission matrix -------------------------------------------------------

console.log('\nPermission matrix — role checks per the spec table');

test('every capability matches the spec matrix for all four roles', function () {
  var samples = { technician: techA(), manager: mgrA(), admin: admA(), platform_admin: root() };
  var matrix = {
    logTime:          { technician: true,  manager: true,  admin: true,  platform_admin: true },
    logWork:          { technician: true,  manager: true,  admin: true,  platform_admin: true },
    viewOwnShifts:    { technician: true,  manager: true,  admin: true,  platform_admin: true },
    viewAllOrgShifts: { technician: false, manager: true,  admin: true,  platform_admin: true },
    approveShifts:    { technician: false, manager: true,  admin: true,  platform_admin: true },
    generateInvoices: { technician: false, manager: true,  admin: true,  platform_admin: true },
    editRateCard:     { technician: false, manager: false, admin: true,  platform_admin: true },
    editOrgSettings:  { technician: false, manager: false, admin: true,  platform_admin: true },
    manageUsers:      { technician: false, manager: false, admin: true,  platform_admin: true },
    seeAllOrgs:       { technician: false, manager: false, admin: false, platform_admin: true }
  };
  Object.keys(matrix).forEach(function (cap) {
    Object.keys(matrix[cap]).forEach(function (role) {
      assert.strictEqual(Rbac.can(samples[role], cap), matrix[cap][role],
        role + '.' + cap + ' should be ' + matrix[cap][role]);
    });
  });
});

test('unknown capability throws loudly; absent or unknown role fails closed', function () {
  assert.throws(function () { Rbac.can(techA(), 'fly'); }, /UNKNOWN_CAPABILITY/);
  assert.strictEqual(Rbac.can(null, 'logTime'), false);
  assert.strictEqual(Rbac.can({ role: 'intern' }, 'logTime'), false);
});

test('technician approving a shift is denied — and the denial is audited', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  var res = shifts.approve(techA(), 'shf-a-1', FROZEN);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'DENIED');
  assert.strictEqual(seed.shifts[0].Status, 'submitted', 'row must be untouched');
  assert.strictEqual(seed.audit.length, 1);
  assert.strictEqual(seed.audit[0].Action, 'access_denied');
  var after = JSON.parse(seed.audit[0].After);
  assert.strictEqual(after.reason, 'DENIED:approveShifts');
});

test('technician submitting someone else\'s shift is NOT_FOUND — no leak, audited', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  var res = shifts.submit(techA(), 'shf-a-3'); // tech2's shift, same org
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'NOT_FOUND');
  assert.strictEqual(seed.shifts[2].Status, 'submitted', 'row must be untouched');
  assert.strictEqual(seed.audit.length, 1);
  assert.strictEqual(seed.audit[0].Action, 'access_denied');
});

test('manager is read-only on the rate card; the denial is audited', function () {
  var seed = freshSeed();
  var catalog = CatalogAdmin.create(freshDeps(seed));
  var res = catalog.changeRate(mgrA(), 'svc-a-repair', 90);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'DENIED');
  assert.strictEqual(seed.catalog[0].Rate, 65, 'rate must be untouched');
  assert.strictEqual(seed.audit.length, 1);
  assert.strictEqual(seed.audit[0].Action, 'access_denied');
});

test('admin changes the rate inside own org; foreign serviceId is NOT_FOUND', function () {
  var seed = freshSeed();
  var catalog = CatalogAdmin.create(freshDeps(seed));

  var res = catalog.changeRate(admA(), 'svc-a-repair', 70);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(seed.catalog[0].Rate, 70);

  var foreign = catalog.changeRate(admA(), 'svc-b-repair', 50);
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.error, 'NOT_FOUND', 'must be the same as an unknown id');
  assert.strictEqual(seed.catalog[1].Rate, 90, 'org-b rate must be untouched');
});

test('platform admin mutates only with a named org scope; audit names the TARGET org', function () {
  var seed = freshSeed();
  var shifts = ShiftRepo.create(freshDeps(seed));
  var catalog = CatalogAdmin.create(freshDeps(seed));

  var noScope = shifts.approve(root(), 'shf-b-1', FROZEN);
  assert.strictEqual(noScope.ok, false);
  assert.strictEqual(noScope.error, 'ORG_SCOPE_REQUIRED');
  assert.strictEqual(seed.shifts[3].Status, 'submitted');

  var ok = shifts.approve(root(), 'shf-b-1', FROZEN, 'org-b');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(seed.shifts[3].Status, 'approved');
  assert.strictEqual(seed.shifts[3].ApprovedBy, 'usr-root');

  var rate = catalog.changeRate(root(), 'svc-a-repair', 55, 'org-a');
  assert.strictEqual(rate.ok, true);

  var approveRow = seed.audit[1];
  assert.strictEqual(approveRow.Action, 'approve');
  assert.strictEqual(approveRow.OrgID, 'org-b', 'platform-admin mutations attribute to the target org');
  assert.strictEqual(approveRow.ActorEmail, 'root@platform.example');
});

// ---- Audit completeness — every mutating call emits exactly one row ---------

console.log('\nAudit completeness — every mutating function emits an audit row');

test('a full mutation scenario leaves one audit row per call, in order', function () {
  var seed = freshSeed();
  var deps = freshDeps(seed);
  var shifts = ShiftRepo.create(deps);
  var lines = LineItemRepo.create(deps);
  var catalog = CatalogAdmin.create(deps);

  shifts.insert(techA(), { workDate: '2026-11-03', clockIn: '2026-11-03T08:00:00-06:00', clockOut: '2026-11-03T17:00:00-06:00' }); // 1 create
  shifts.submit(techA(), 'gen-1');                                                                                              // 2 submit
  shifts.approve(mgrA(), 'gen-1', FROZEN);                                                                                      // 3 approve
  shifts.insert(techA(), { workDate: '2026-11-04', clockIn: '2026-11-04T08:00:00-06:00' });                                     // 4 create
  shifts.submit(techA(), 'gen-2');                                                                                              // 5 submit
  shifts.reject(mgrA(), 'gen-2', 'wrong date');                                                                                 // 6 reject
  lines.save(techA(), { serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 2, shiftId: 'gen-1' });                     // 7 create
  lines.save(techA(), { serviceId: 'svc-b-repair', workDate: '2026-11-03', quantity: 1 });                                      // 8 access_denied (V9)
  lines.save(ctxFor('usr-b-tech', 'tech@b.example', 'org-b', 'technician'), { serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 1 }); // 9 access_denied
  lines.update(mgrA(), 'gen-3', { Quantity: 5 });                                                                               // 10 update
  catalog.changeRate(admA(), 'svc-a-repair', 70);                                                                               // 11 rate_change

  var actions = seed.audit.map(function (r) { return r.Action; });
  assert.deepStrictEqual(actions, [
    'create', 'submit', 'approve', 'create', 'submit', 'reject',
    'create', 'access_denied', 'access_denied', 'update', 'rate_change'
  ]);

  seed.audit.forEach(function (r) {
    assert.strictEqual(r.Timestamp, CLOCK, 'every row carries a timestamp');
    assert.ok(r.ActorEmail, 'every row names its actor');
    assert.ok(r.OrgID, 'every row names its org');
  });

  // Successful mutations carry the entity id and the before/after values.
  var approveRow = seed.audit[2];
  assert.strictEqual(approveRow.Entity, 'shift');
  var before = JSON.parse(approveRow.Before);
  var after = JSON.parse(approveRow.After);
  assert.strictEqual(before.Status, 'submitted');
  assert.strictEqual(after.Status, 'approved');
  assert.strictEqual(after.RawHours, 12, 'frozen hours land on the row');
  assert.strictEqual(after.NetHours, 12);
  assert.strictEqual(after.ApprovedBy, 'usr-a-mgr');
  assert.strictEqual(after.ApprovedAt, CLOCK.toISOString());

  // Quantity edits re-price from the FROZEN snapshot (2×65 → 5×65), never the live catalog.
  var line = seed.lineItems[0];
  assert.strictEqual(line.Quantity, 5);
  assert.strictEqual(line.RateSnapshot, 65);
  assert.strictEqual(line.LineTotal, 325);
});

test('updates on protected or frozen lines are denied and audited', function () {
  var seed = freshSeed();
  var deps = freshDeps(seed);
  var lines = LineItemRepo.create(deps);
  var billed = lines.save(techA(), { serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 2, shiftId: 'shf-a-1' });
  var unbilled = lines.save(techA(), { serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 2, shiftId: 'shf-a-1' });
  assert.strictEqual(billed.ok, true, JSON.stringify(billed));
  assert.strictEqual(unbilled.ok, true, JSON.stringify(unbilled));
  // save() returns the sheet-shaped row copy — the id is LineID.
  var billedId = billed.item.LineID;
  var unbilledId = unbilled.item.LineID;
  assert.ok(billedId, 'save() must return the persisted LineID');
  assert.ok(unbilledId, 'save() must return the persisted LineID');
  seed.lineItems[0].InvoiceID = 'inv-001'; // stamp the first line as billed

  // A billed line is frozen entirely.
  var frozen = lines.update(mgrA(), billedId, { Quantity: 3 });
  assert.strictEqual(frozen.ok, false);
  assert.strictEqual(frozen.error, 'INVOICE_FROZEN');

  // On an UNBILLED line: rate/type/total are never client-editable —
  // for any role.
  var protectedField = lines.update(mgrA(), unbilledId, { RateSnapshot: 999 });
  assert.strictEqual(protectedField.ok, false);
  assert.strictEqual(protectedField.error, 'FIELD_NOT_EDITABLE');

  // Quantity is the one editable field: the technician fixes their own
  // line, and the total re-prices from the FROZEN snapshot (3×65), never
  // the live catalog.
  var techQty = lines.update(techA(), unbilledId, { Quantity: 3 });
  assert.strictEqual(techQty.ok, true, JSON.stringify(techQty));

  var line1 = seed.lineItems[0];
  var line2 = seed.lineItems[1];
  assert.strictEqual(line1.LineTotal, 130, 'billed line never changed');
  assert.strictEqual(line2.LineTotal, 195, 're-priced from the frozen snapshot');
  assert.strictEqual(line2.RateSnapshot, 65, 'the snapshot itself never moves');

  // Two creates + two denied mutations + one update → five audit rows.
  assert.strictEqual(seed.audit.length, 5);
  assert.deepStrictEqual(seed.audit.map(function (r) { return r.Action; }),
    ['create', 'create', 'access_denied', 'access_denied', 'update']);
});

test('shiftless lines: a technician cannot prove ownership — fail closed; a manager may edit', function () {
  var seed = freshSeed();
  var deps = freshDeps(seed);
  var lines = LineItemRepo.create(deps);
  // Material lines may exist without a shift, and Work Performed carries no
  // technician column — so a technician cannot PROVE ownership of one.
  // Fail closed: their update is the same NOT_FOUND as a foreign row, audited.
  var saved = lines.save(techA(), { serviceId: 'svc-a-repair', workDate: '2026-11-03', quantity: 1 });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved));
  var lineId = saved.item.LineID;

  var techUpdate = lines.update(techA(), lineId, { Quantity: 4 });
  assert.strictEqual(techUpdate.ok, false);
  assert.strictEqual(techUpdate.error, 'NOT_FOUND');
  assert.strictEqual(seed.audit[seed.audit.length - 1].Action, 'access_denied');
  assert.strictEqual(seed.lineItems[0].Quantity, 1, 'nothing may change');

  // A manager's org-wide scope may edit the same line — quantity only,
  // re-priced from the frozen snapshot (1×65 → 2×65).
  var mgrUpdate = lines.update(mgrA(), lineId, { Quantity: 2 });
  assert.strictEqual(mgrUpdate.ok, true, JSON.stringify(mgrUpdate));
  assert.strictEqual(seed.lineItems[0].Quantity, 2);
  assert.strictEqual(seed.lineItems[0].LineTotal, 130);
  assert.strictEqual(seed.audit[seed.audit.length - 1].Action, 'update');
});

test('audit reads are org-scoped: org-a manager cannot see org-b entries', function () {
  var seed = freshSeed();
  var deps = freshDeps(seed);
  var shifts = ShiftRepo.create(deps);
  shifts.approve(mgrA(), 'shf-a-1', FROZEN);  // org-a entry
  shifts.approve(mgrB(), 'shf-b-1', FROZEN);  // org-b entry

  var forMgrA = AuditLog.listForOrg(deps.data, mgrA());
  assert.strictEqual(forMgrA.length, 1);
  assert.strictEqual(forMgrA[0].OrgID, 'org-a');

  var forRoot = AuditLog.listForOrg(deps.data, root());
  assert.strictEqual(forRoot.length, 2, 'only the platform admin sees across orgs');
});

// ---- Edge adapter under mocked SpreadsheetApp --------------------------------

console.log('\nEdge adapter — Apps Script glue under mocked services');

test('AppsScriptData maps sheet values to rows and back; doPost routes and filters', function () {
  var usersSheet = fakeSheet(
    ['UserID', 'Email', 'FullName', 'OrgID', 'Role', 'IsActive'],
    [['usr-b-mgr', 'mgr@b.example', 'Mgr B', 'org-b', 'manager', 'TRUE']]
  );
  var timeLogSheet = fakeSheet(
    ['ShiftID', 'OrgID', 'TechnicianID', 'WorkDate', 'ClockIn', 'ClockOut', 'BreakMin',
     'RawHours', 'NetHours', 'CrossMidnight', 'OTFlag', 'Status', 'ApprovedBy', 'Notes'],
    [['shf-b-1', 'org-b', 'usr-b-tech', '2026-11-02', 'in', 'out', 0, '', '', '', '', 'submitted', '', '']]
  );
  var auditSheet = fakeSheet(['Timestamp', 'ActorEmail', 'OrgID', 'Entity', 'Action', 'Before', 'After'], []);
  var workSheet = fakeSheet(['LineID', 'OrgID', 'ShiftID', 'WorkDate', 'TaskKey', 'TaskName',
    'TaskType', 'Quantity', 'UnitLabel', 'RateSnapshot', 'LineTotal', 'Category', 'InvoiceID'], []);
  var catalogSheet = fakeSheet(['OrgID', 'ServiceID', 'TaskName', 'TaskType', 'UnitLabel',
    'Rate', 'Category', 'Billable', 'IsActive'], []);

  global.SpreadsheetApp = { getActive: function () {
    return { getSheetByName: function (name) {
      return { 'Users': usersSheet, 'Time Log': timeLogSheet, 'Audit Log': auditSheet,
               'Work Performed': workSheet, 'Service Catalog': catalogSheet }[name];
    } };
  } };
  global.Session = { getActiveUser: function () {
    return { getEmail: function () { return 'mgr@b.example'; } };
  } };
  global.Utilities = { getUuid: function () { return 'uuid-' + (++idSeq); } };
  global.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: function (s) { return { content: s, setMimeType: function () { return this; } }; }
  };

  // Read path: the gate + org filter run end-to-end through doPost.
  var listRes = SecurityEdge.doPost({ parameter: { action: 'listShifts' } });
  var listBody = JSON.parse(listRes.content);
  assert.strictEqual(listBody.ok, true);
  assert.strictEqual(listBody.shifts.length, 1);
  assert.strictEqual(listBody.shifts[0].OrgID, 'org-b');

  // Mutating path: approval through the edge writes the audit row to the sheet.
  var approveRes = SecurityEdge.doPost({ parameter: {
    action: 'approveShift', shiftId: 'shf-b-1',
    frozen: JSON.stringify({ rawHours: 12, netHours: 12, otFlag: 'DAILY' })
  } });
  var approveBody = JSON.parse(approveRes.content);
  assert.strictEqual(approveBody.ok, true, JSON.stringify(approveBody));
  assert.strictEqual(timeLogSheet._rows()[0][11], 'approved');
  assert.strictEqual(auditSheet._rows().length, 1, 'the mutation is audited');
  assert.strictEqual(auditSheet._rows()[0][4], 'approve');
  assert.strictEqual(auditSheet._rows()[0][2], 'org-b');
});

test('doPost rejects unknown actions', function () {
  var res = SecurityEdge.doPost({ parameter: { action: 'dropTable' } });
  assert.strictEqual(JSON.parse(res.content).error, 'UNKNOWN_ACTION');
});

// ---- Fake sheet ---------------------------------------------------------------

function fakeSheet(headers, rows) {
  // Internally header-inclusive, exactly like a real sheet's value grid —
  // updateRows round-trips [headers].concat(data) through setValues.
  var all = [headers.slice()].concat(rows.map(function (r) { return r.slice(); }));
  return {
    getLastColumn: function () { return headers.length; },
    getDataRange: function () {
      return { getValues: function () { return all.map(function (r) { return r.slice(); }); } };
    },
    getRange: function (row, col, numRows) {
      return {
        getValues: function () {
          if (row === 1 && numRows === 1) return [all[0].slice()];
          return all.slice(row - 1, row - 1 + (numRows || 1)).map(function (r) { return r.slice(); });
        },
        setValues: function (v) {
          for (var i = 0; i < v.length; i++) {
            all[row - 1 + i] = v[i].slice();
          }
        }
      };
    },
    appendRow: function (arr) { all.push(arr.slice()); },
    _rows: function () { return all.slice(1); } // data rows only
  };
}

// ---- Summary ------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  failures.forEach(function (f) {
    console.log('  FAILED: ' + f.name + ' — ' + f.err.message);
  });
  process.exit(1);
}

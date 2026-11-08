/**
 * TimeMath.test.js — acceptance vectors V1–V7 from spec art_SHLLdADT plus
 * edge-case and helper coverage. Dependency-free; run with:
 *   node TimeMath.test.js
 */
'use strict';

const assert = require('assert');
const {
  computeShift, deriveShiftStatus, weeklyNetHours, weekStartFor, makeWeekPeriod,
} = require('../apps-script/TimeMath.js');

let assertions = 0;
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
  assertions++;
  assert.deepStrictEqual(actual, expected, label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function ok(cond, label) {
  assertions++;
  assert.ok(cond, label);
}

function defaults() {
  return { dailyHours: 8, weeklyHours: 40, netHoursPriorInWeek: 0 };
}

console.log('TimeMath unit tests — spec vectors V1–V7 (spec art_SHLLdADT)');
console.log('node ' + process.version + '\n');

// ─── Spec acceptance vectors ────────────────────────────────────────────────

test('V1  overnight 19:00→07:00 → raw 12.00, net 12.00, crossesMidnight', () => {
  const c = computeShift({ clockIn: '2026-11-06T19:00', clockOut: '2026-11-07T07:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, 12, 'raw');
  eq(c.netHours, 12, 'net');
  eq(c.crossesMidnight, true, 'crossesMidnight');
  eq(c.errors, [], 'no errors');
  eq(deriveShiftStatus(c), 'OK', 'status');
});

test('V1b offset-aware overnight (primary entry format) → 12 h, crossesMidnight on its own wall clock', () => {
  const c = computeShift({ clockIn: '2026-11-06T19:00:00-06:00', clockOut: '2026-11-07T07:00:00-06:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, 12, 'raw');
  eq(c.crossesMidnight, true, 'crossesMidnight');
});

test('V2  equal time-only 19:00→19:00 → raw 24.00 — NOT MOD(0,1)=0', () => {
  const c = computeShift({ clockIn: '19:00', clockOut: '19:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, 24, 'raw must be exactly 24, never the MOD-folded 0');
  eq(c.netHours, 24, 'net');
  eq(c.crossesMidnight, true, 'crossesMidnight');
  eq(c.errors, [], 'no errors (24 h is within the 36 h plausibility guard)');
  eq(deriveShiftStatus(c), 'OK', 'status');
});

test('V3  multi-day Mon 07:00→Wed 15:00 → raw 56.00, IMPLAUSIBLE_SHIFT → REVIEW', () => {
  const c = computeShift({ clockIn: '2026-11-02T07:00', clockOut: '2026-11-04T15:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, 56, 'raw via direct datetime diff (not a MOD fold)');
  eq(c.netHours, 56, 'net');
  eq(c.crossesMidnight, true, 'crossesMidnight');
  ok(c.errors.indexOf('IMPLAUSIBLE_SHIFT') !== -1, 'must carry IMPLAUSIBLE_SHIFT (> 36 h)');
  eq(deriveShiftStatus(c), 'REVIEW', 'status — flagged for manager review, hours still visible');
});

test('V4  missing clock-out → null hours, MISSING_CLOCK_OUT, status OPEN', () => {
  const c = computeShift({ clockIn: '2026-11-06T19:00', clockOut: null, breakMinutes: 0 }, defaults());
  eq(c.rawHours, null, 'no duration is ever guessed');
  eq(c.netHours, null, 'net null too');
  eq(c.crossesMidnight, false, 'crossesMidnight');
  eq(c.errors, ['MISSING_CLOCK_OUT'], 'errors (invoice generator refuses the period on this code)');
  eq(deriveShiftStatus(c), 'OPEN', 'status');
});

test('V5  raw 0.5 h with 60-min break → net 0.00, never negative', () => {
  const c = computeShift({ clockIn: '2026-11-06T10:00', clockOut: '2026-11-06T10:30', breakMinutes: 60 }, defaults());
  eq(c.rawHours, 0.5, 'raw');
  eq(c.netHours, 0, 'net floors at zero');
  eq(deriveShiftStatus(c), 'OK', 'status');
});

test('V6  net 9.5 h vs 8 h daily threshold → DAILY', () => {
  const c = computeShift({ clockIn: '2026-11-06T09:00', clockOut: '2026-11-06T18:30', breakMinutes: 0 },
    { dailyHours: 8, weeklyHours: 40, netHoursPriorInWeek: 0 });
  eq(c.netHours, 9.5, 'net');
  eq(c.otFlag, 'daily', 'flag');
});

test('V7  five 8.5 h shifts, weekly threshold 40 → shifts 5+ flag WEEKLY', () => {
  // Daily threshold 9 (per-org setting) keeps each shift under the daily rule
  // so the vector isolates the weekly path. With the 8 h default each 8.5 h
  // shift also flags DAILY — daily is checked first in the spec's formula
  // (pinned by V7b below).
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const flags = [];
  let prior = 0;
  for (const d of days) {
    const c = computeShift({ clockIn: d + 'T07:00', clockOut: d + 'T15:30', breakMinutes: 0 },
      { dailyHours: 9, weeklyHours: 40, netHoursPriorInWeek: prior });
    flags.push(c.otFlag);
    prior += c.netHours;
  }
  eq(flags, ['none', 'none', 'none', 'none', 'weekly'], 'flags by shift');
  ok(prior > 40, 'weekly net total must cross 40 h');
  eq(prior, 42.5, 'weekly total');
});

// ─── Supplementary behavior locks ───────────────────────────────────────────

test('V7b defaults (8/40): each 8.5 h shift flags DAILY (daily first per spec formula); week still crosses 40', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const flags = [];
  let prior = 0;
  for (const d of days) {
    const c = computeShift({ clockIn: d + 'T07:00', clockOut: d + 'T15:30', breakMinutes: 0 },
      { dailyHours: 8, weeklyHours: 40, netHoursPriorInWeek: prior });
    flags.push(c.otFlag);
    prior += c.netHours;
  }
  eq(flags, ['daily', 'daily', 'daily', 'daily', 'daily'], 'daily priority');
  ok(prior > 40, 'weekly total crosses 40 h');
});

test('weeklyNetHours skips open shifts (null net) and out-of-week dates', () => {
  const week = makeWeekPeriod(weekStartFor('2026-11-04', 0));
  eq(week.start, '2026-11-01', 'Wednesday resolves to Sunday week start');
  const sum = weeklyNetHours([
    { workDate: '2026-11-02', netHours: 8.5 },
    { workDate: '2026-11-05', netHours: null }, // open shift — V4 semantics
    { workDate: '2026-11-07', netHours: 7 },
    { workDate: '2026-11-08', netHours: 9 }, // next week
  ], week);
  eq(sum, 15.5, 'sum of in-week frozen nets only');
});

test('weekStartFor anchors 0=Sunday per organizations.week_start_day', () => {
  eq(weekStartFor('2026-11-07', 0), '2026-11-01', 'Saturday → Sunday');
  eq(weekStartFor('2026-11-08', 0), '2026-11-08', 'Sunday → itself');
  eq(weekStartFor('2026-11-08', 1), '2026-11-02', 'Monday week start → Monday');
});

test('equal datetimes (primary path) are a zero-length shift, not a wrap', () => {
  const c = computeShift({ clockIn: '2026-11-06T19:00', clockOut: '2026-11-06T19:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, 0, 'raw');
  eq(c.errors, [], 'no errors');
});

test('mixed entry (datetime in, time-only out) fails loudly: INVALID_CLOCK_OUT, no numbers', () => {
  const c = computeShift({ clockIn: '2026-11-06T19:00', clockOut: '07:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, null, 'raw');
  eq(c.errors, ['INVALID_CLOCK_OUT'], 'errors');
});

test('unparseable clock-in fails closed: INVALID_CLOCK_IN, no numbers', () => {
  const c = computeShift({ clockIn: 'not-a-time', clockOut: '2026-11-07T07:00', breakMinutes: 0 }, defaults());
  eq(c.rawHours, null, 'raw');
  eq(deriveShiftStatus(c), 'REVIEW', 'unknown data state fails toward human review');
});

test('time-only 12-hour + overnight wrap: 11:00 PM → 7:00 AM = 8 h', () => {
  const c = computeShift({ clockIn: '11:00 PM', clockOut: '7:00 AM', breakMinutes: 0 }, defaults());
  eq(c.rawHours, 8, 'raw');
  eq(c.crossesMidnight, true, 'crossesMidnight');
});

test('Sheets time-only Date cells (1899 epoch) take the time-only path', () => {
  const c = computeShift(
    { clockIn: new Date(1899, 11, 30, 19, 0, 0), clockOut: new Date(1899, 11, 30, 19, 0, 0), breakMinutes: 0 },
    defaults());
  eq(c.rawHours, 24, 'equal sheet times wrap to exactly 24');
});

console.log('\n' + (passed + failed) + ' tests, ' + assertions + ' assertions: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
console.log('ALL PASS');

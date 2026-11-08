/**
 * TimeMath — canonical time-calculation engine for the Time-Tracking & Retainer
 * Billing MVP.
 *
 * Source of truth: spec art_SHLLdADT — "Equivalent TypeScript engine" section
 * and acceptance vectors V1–V7. Pure functions, no I/O; the same file runs in
 * both runtimes so the MVP and the future Next.js API share one implementation:
 *
 *  - Google Apps Script: paste as a script file named `TimeMath` (V8 runtime).
 *    Call sites use the `TimeMath.*` namespace.
 *  - Node (unit tests now, Next.js API later): require('./TimeMath.js').
 *
 * Entry contract (spec locked decision "Full datetime entry"):
 *  - PRIMARY: ISO 8601 datetimes, offset-aware preferred
 *    ("2026-11-06T19:00:00-06:00").
 *  - FALLBACK: time-only strings ("19:00", "7:00 PM") or Sheets time-only Date
 *    cells (1899 epoch) — the MOD path, trusted only under 24 h, with an
 *    explicit equal-times branch that resolves to exactly 24 h. That branch is
 *    the guard against the MOD(0,1)=0 trap: an exact 24-hour time-only shift
 *    would otherwise be paid as zero (vector V2).
 */

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;

/**
 * Continuous-shift guard (spec V3 / 03_TimeLog status column): spans beyond
 * 36 h keep their computed hours but are flagged for manager review — never
 * silently truncated by a MOD wrap.
 */
const MAX_PLAUSIBLE_HOURS = 36;

/** Spec defaults; per-org overrides live in organizations.ot_daily_hours / ot_weekly_hours. */
const DEFAULT_THRESHOLDS = { dailyHours: 8, weeklyHours: 40, netHoursPriorInWeek: 0 };

/** @typedef {'none'|'daily'|'weekly'} OtFlag */
/** @typedef {'INVALID_CLOCK_IN'|'INVALID_CLOCK_OUT'|'MISSING_CLOCK_OUT'|'IMPLAUSIBLE_SHIFT'} ShiftError */
/** @typedef {{clockIn: string|Date, clockOut: string|Date|null, breakMinutes: number}} ShiftEntry */
/** @typedef {{dailyHours: number, weeklyHours: number, netHoursPriorInWeek: number}} OtThresholds */
/** @typedef {{rawHours: number|null, netHours: number|null, crossesMidnight: boolean, otFlag: OtFlag, errors: ShiftError[]}} ShiftComputation */

/**
 * Computes raw/net hours, midnight crossing, and the OT flag for one shift.
 * Never guesses: an open shift returns null hours with MISSING_CLOCK_OUT (V4);
 * an implausible span returns its hours AND IMPLAUSIBLE_SHIFT so the manager
 * sees real numbers under a REVIEW flag (V3), never a MOD-folded zero.
 *
 * @param {ShiftEntry} entry
 * @param {Partial<OtThresholds>} [thresholds] per-org settings; defaults 8 / 40 / 0
 * @returns {ShiftComputation}
 */
function computeShift(entry, thresholds) {
  const errors = [];
  const inAt = parseClockValue(entry ? entry.clockIn : null);
  if (!inAt) errors.push('INVALID_CLOCK_IN');

  // Open shift — no duration is ever guessed (V4). The invoice generator keys
  // on MISSING_CLOCK_OUT to refuse the period.
  if (!entry || entry.clockOut === null || entry.clockOut === undefined || entry.clockOut === '') {
    errors.push('MISSING_CLOCK_OUT'); // any INVALID_CLOCK_IN is carried through
    return { rawHours: null, netHours: null, crossesMidnight: false, otFlag: 'none', errors };
  }

  const outAt = parseClockValue(entry.clockOut);
  if (!outAt) errors.push('INVALID_CLOCK_OUT');
  if (!inAt || !outAt) {
    return { rawHours: null, netHours: null, crossesMidnight: false, otFlag: 'none', errors };
  }

  let rawHours;
  let crossesMidnight;

  if (inAt.kind === 'datetime' && outAt.kind === 'datetime') {
    // Primary path: direct datetime difference — safe across midnight, 24 h,
    // and multi-day spans (V1, V3).
    rawHours = (outAt.date.getTime() - inAt.date.getTime()) / MS_PER_HOUR;
    crossesMidnight =
      dayNumberOf(entry.clockIn, inAt.date) !== dayNumberOf(entry.clockOut, outAt.date) ||
      rawHours >= 24;
  } else if (inAt.kind === 'timeOnly' && outAt.kind === 'timeOnly') {
    // Legacy fallback (03_TimeLog H2 wrap rule), trusted only under 24 h.
    const a = inAt.seconds;
    const b = outAt.seconds;
    if (b === a) {
      rawHours = 24; // V2: equal time-only values are a full 24-hour shift — NOT MOD(0,1)=0
      crossesMidnight = true;
    } else if (b > a) {
      rawHours = (b - a) / 3600;
      crossesMidnight = false;
    } else {
      rawHours = (b - a + SECONDS_PER_DAY) / 3600; // overnight wrap
      crossesMidnight = true;
    }
  } else {
    // Mixed datetime/time-only entry is a data defect — fail loudly instead of
    // guessing which calendar day the time-only side belongs to.
    errors.push('INVALID_CLOCK_OUT');
    return { rawHours: null, netHours: null, crossesMidnight: false, otFlag: 'none', errors };
  }

  if (rawHours < 0 || rawHours > MAX_PLAUSIBLE_HOURS) {
    errors.push('IMPLAUSIBLE_SHIFT'); // clock skew or multi-day misuse → REVIEW (V3)
  }

  const breakMin = Math.max(0, Number(entry.breakMinutes) || 0);
  const netHours = Math.max(0, rawHours - breakMin / 60); // never negative (V5)

  const t = normalizeThresholds(thresholds);
  const otFlag =
    netHours > t.dailyHours ? 'daily'
      : netHours + t.netHoursPriorInWeek > t.weeklyHours ? 'weekly'
        : 'none';

  return { rawHours: round2(rawHours), netHours: round2(netHours), crossesMidnight, otFlag, errors };
}

/**
 * Maps a computation onto the sheet's Status guard (03_TimeLog column L):
 * OPEN while the clock-out is missing, REVIEW for implausible or unparseable
 * data (fail toward human review), OK otherwise.
 * @param {ShiftComputation|null} comp
 * @returns {'OPEN'|'REVIEW'|'OK'}
 */
function deriveShiftStatus(comp) {
  if (!comp) return 'REVIEW';
  const errs = comp.errors || [];
  if (errs.indexOf('MISSING_CLOCK_OUT') !== -1) return 'OPEN';
  if (errs.length > 0) return 'REVIEW'; // IMPLAUSIBLE_SHIFT, INVALID_CLOCK_*
  return 'OK';
}

/**
 * Sum of frozen net hours for shifts inside one org-week (spec weekly
 * aggregation helper). Open shifts carry netHours null and contribute nothing —
 * an open shift can never inflate a weekly OT total.
 * @param {{netHours: number|null, workDate: string}[]} shifts
 * @param {{contains: (workDate: string) => boolean}} week
 * @returns {number}
 */
function weeklyNetHours(shifts, week) {
  let sum = 0;
  for (const s of shifts || []) {
    if (s && s.netHours !== null && s.netHours !== undefined && week.contains(s.workDate)) {
      sum += s.netHours;
    }
  }
  return sum;
}

/**
 * Org-week anchor for a work date (03_TimeLog column J intent).
 * weekStartDay follows organizations.week_start_day: 0=Sunday … 6=Saturday.
 *
 * Spec correction: the blueprint's J2 formula combines 1-based WEEKDAY() with
 * the 0-based setting and anchors one day early (a Sunday would resolve to
 * Saturday); this helper implements the DDL's 0=Sunday convention directly.
 *
 * @param {string} workDate 'YYYY-MM-DD'
 * @param {number} [weekStartDay]
 * @returns {string} 'YYYY-MM-DD' of that week's start day
 */
function weekStartFor(workDate, weekStartDay) {
  const n = Number(weekStartDay);
  const wsd = Number.isFinite(n) ? ((n % 7) + 7) % 7 : 0;
  const d = new Date(String(workDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new Error('Invalid workDate: ' + workDate);
  const daysBack = (d.getUTCDay() - wsd + 7) % 7;
  return new Date(d.getTime() - daysBack * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * @param {string} weekStart 'YYYY-MM-DD' (see weekStartFor)
 * @returns {{start: string, contains: (workDate: string) => boolean}}
 */
function makeWeekPeriod(weekStart) {
  const startMs = Date.parse(String(weekStart).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(startMs)) throw new Error('Invalid weekStart: ' + weekStart);
  return {
    start: String(weekStart).slice(0, 10),
    contains: (workDate) => {
      const t = Date.parse(String(workDate).slice(0, 10) + 'T00:00:00Z');
      return !Number.isNaN(t) && t >= startMs && t <= startMs + 6 * MS_PER_DAY;
    },
  };
}

/**
 * Parses a clock value into a datetime or a time-only value.
 * @param {string|Date|null|undefined} value
 * @returns {{kind:'datetime', date: Date}|{kind:'timeOnly', seconds: number}|null}
 */
function parseClockValue(value) {
  if (value instanceof Date) {
    // Sheets represents a time-only cell as a Date on the 1899 epoch.
    if (value.getFullYear() === 1899) {
      return { kind: 'timeOnly', seconds: value.getHours() * 3600 + value.getMinutes() * 60 + value.getSeconds() };
    }
    return { kind: 'datetime', date: value };
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  return parseTimeOnly(value.trim()) || parseDatetime(value.trim());
}

/** Time-only strings: "19:00", "07:00:00", "7:00 PM". */
function parseTimeOnly(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]\.?M\.?)?$/i.exec(s);
  if (!m) return null;
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  if (min > 59 || sec > 59) return null;
  let h = Number(m[1]);
  const meridiem = m[4] ? m[4].replace(/\./g, '').toUpperCase() : null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    if (meridiem === 'PM' && h !== 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return { kind: 'timeOnly', seconds: h * 3600 + min * 60 + sec };
}

/** Spec's parseIso, widened to report what it parsed. */
function parseDatetime(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : { kind: 'datetime', date: d };
}

/**
 * Calendar day number in the entry's own wall clock: the string's UTC offset
 * when it carries one, the host's local day for offset-naive strings, the
 * script's calendar for Sheet Date values. The spec sketch compared
 * getUTCDate(), which misclassifies overnight spans whenever the host is not
 * on the entry's wall clock; comparing day numbers is exact for both entry
 * kinds (pinned by tests V1/V1b).
 */
function dayNumberOf(raw, date) {
  if (typeof raw === 'string') {
    if (/Z$/i.test(raw)) return Math.floor(date.getTime() / MS_PER_DAY);
    const m = /([+-])(\d{2}):?(\d{2})?$/.exec(raw);
    const offsetMs = m
      ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000
      : -date.getTimezoneOffset() * 60000;
    return Math.floor((date.getTime() + offsetMs) / MS_PER_DAY);
  }
  return Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / MS_PER_DAY);
}

/** Per-org OT thresholds; falls back to the spec defaults (8 / 40 / 0). */
function normalizeThresholds(t) {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    dailyHours: num(t ? t.dailyHours : undefined, DEFAULT_THRESHOLDS.dailyHours),
    weeklyHours: num(t ? t.weeklyHours : undefined, DEFAULT_THRESHOLDS.weeklyHours),
    netHoursPriorInWeek: num(t ? t.netHoursPriorInWeek : undefined, DEFAULT_THRESHOLDS.netHoursPriorInWeek),
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

const TimeMath = Object.freeze({
  MS_PER_HOUR,
  MAX_PLAUSIBLE_HOURS,
  computeShift,
  deriveShiftStatus,
  weeklyNetHours,
  weekStartFor,
  makeWeekPeriod,
  parseClockValue,
});

// Node interop (tests now, Next.js API later). Apps Script has no `module` and skips this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TimeMath;
}

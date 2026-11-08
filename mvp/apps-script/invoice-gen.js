/**
 * Invoice generation — weekly engine (spec art_SHLLdADT, invoice section).
 * Google Apps Script / Node shared module. Pure core: no I/O. Rows arrive
 * as plain objects in the sheet column order; results are plain values.
 * Sheet, session, and audit access live in invoice-sheet.js.
 *
 * Invariants implemented here:
 *  - Guard (V12): generation refuses while any shift in the period is
 *    `open` or `submitted`, and returns the blocking rows by technician
 *    and date instead of quietly under-billing.
 *  - Frozen data only: header totals read frozen NetHours (approved time
 *    log rows) and frozen line snapshots. No catalog argument exists in
 *    this module, so re-pricing history is unrepresentable.
 *  - Cent-exact gross: gross = round2(hourlyPayout + category totals +
 *    adjustment), where hourlyPayout and each category total are sums of
 *    already-rounded line totals. Every billable line appears exactly
 *    once: hourly lines roll into HourlyPayout, all other task types
 *    itemize under their category — nothing is double counted.
 *  - Numbering: `{prefix}-YYYY-{seq}` per org (RNM-2026-0001), unique
 *    against existing invoices; the seed sequence comes from the org row.
 *  - Void releases: a voided invoice sets status `void` and releases its
 *    lines back to invoiceId = null so the next run picks them up —
 *    nothing is ever double-billed.
 */
var InvoiceGen = (function () {
  'use strict';

  // Apps Script: RateCatalog arrives as a global from rate-catalog.js.
  // Node (tests): each file is its own module scope, so resolve it explicitly.
  var RC = typeof RateCatalog !== 'undefined'
    ? RateCatalog
    : (typeof require === 'function' ? require('./rate-catalog.js') : null);

  var MANAGER_ROLES = ['manager', 'admin', 'platform_admin'];
  // Spec guard names `open` and `submitted`; `rejected` is also unbilled
  // (its lines stay unbilled) but does not block the period.
  var BLOCKING_STATUSES = ['open', 'submitted'];

  function assertCtx(ctx) {
    if (!ctx || typeof ctx.orgId !== 'string' || !ctx.orgId) {
      // ctx.orgId comes from the authenticated session, never the payload.
      throw new Error('ORG_SCOPE_REQUIRED');
    }
  }

  function normDate(value) {
    if (value instanceof Date) {
      // Sheets dates are script-timezone wall clocks; local parts, not UTC.
      var m = ('0' + (value.getMonth() + 1)).slice(-2);
      var d = ('0' + value.getDate()).slice(-2);
      return value.getFullYear() + '-' + m + '-' + d;
    }
    return String(value == null ? '' : value).slice(0, 10);
  }

  function inRange(dateStr, periodStart, periodEnd) {
    var d = normDate(dateStr);
    return d !== '' && d >= periodStart && d <= periodEnd;
  }

  function isApproved(status) {
    return String(status).toLowerCase() === 'approved';
  }

  // ---- V12: the approval guard ---------------------------------------------

  /**
   * Shifts in the period that are not yet approved. Returned rows name the
   * technician, date, and status so the manager can clear them by hand.
   */
  function findBlockingShifts(timeLogRows, orgId, periodStart, periodEnd) {
    if (typeof orgId !== 'string' || !orgId) throw new Error('ORG_SCOPE_REQUIRED');
    return timeLogRows
      .filter(function (r) {
        return r.OrgID === orgId &&
          inRange(r.WorkDate, periodStart, periodEnd) &&
          BLOCKING_STATUSES.indexOf(String(r.Status).toLowerCase()) !== -1;
      })
      .map(function (r) {
        return {
          shiftId: r.ShiftID,
          technicianId: r.TechnicianID,
          workDate: normDate(r.WorkDate),
          status: String(r.Status).toLowerCase()
        };
      });
  }

  // ---- Header totals (SUMIFS equivalents) -----------------------------------

  /**
   * Spec SUMIFS #1: total billable hours from APPROVED time log rows in the
   * period — frozen NetHours, never a recomputation.
   */
  function sumBillableHours(timeLogRows, orgId, periodStart, periodEnd) {
    var sum = 0;
    timeLogRows.forEach(function (r) {
      if (r.OrgID === orgId && inRange(r.WorkDate, periodStart, periodEnd) &&
          isApproved(r.Status) && r.NetHours !== '' && r.NetHours != null) {
        sum += Number(r.NetHours);
      }
    });
    return RC.round2(sum);
  }

  /**
   * Billable lines for this invoice: unbilled, in the period, org-scoped,
   * and attached to an APPROVED shift (or to no shift at all).
   */
  function eligibleLines(lineRows, orgId, periodStart, periodEnd, timeLogRows) {
    var approvedShift = {};
    timeLogRows.forEach(function (r) {
      if (r.OrgID === orgId && isApproved(r.Status)) approvedShift[r.ShiftID] = true;
    });
    return lineRows.filter(function (l) {
      var unbilled = l.InvoiceID == null || String(l.InvoiceID) === '';
      return l.OrgID === orgId && unbilled;
    }).filter(function (l) {
      return inRange(l.WorkDate, periodStart, periodEnd);
    }).filter(function (l) {
      return l.ShiftID === '' || l.ShiftID == null || approvedShift[l.ShiftID] === true;
    });
  }

  /**
   * Spec SUMIFS #2/#3 equivalents. Hourly lines price into HourlyPayout;
   * every other task type itemizes under its category, so each line
   * contributes to exactly one printed number.
   */
  function computeHeaderTotals(totalsInput) {
    var orgId = totalsInput.orgId;
    if (typeof orgId !== 'string' || !orgId) throw new Error('ORG_SCOPE_REQUIRED');
    var lines = totalsInput.lines;
    var adjustment = RC.round2(Number(totalsInput.adjustment) || 0);

    var hourlyPayout = 0;
    var categoryTotals = {};
    lines.forEach(function (l) {
      var total = Number(l.LineTotal);
      if (String(l.TaskType).toLowerCase() === 'hourly') {
        hourlyPayout += total;
      } else {
        var cat = l.Category || 'Services';
        categoryTotals[cat] = RC.round2((categoryTotals[cat] || 0) + total);
      }
    });
    hourlyPayout = RC.round2(hourlyPayout);

    var linesSum = 0;
    lines.forEach(function (l) { linesSum += Number(l.LineTotal); });

    return {
      billableHours: sumBillableHours(totalsInput.timeLogRows, orgId,
        totalsInput.periodStart, totalsInput.periodEnd),
      hourlyPayout: hourlyPayout,
      categoryTotals: categoryTotals,
      adjustment: adjustment,
      // Cent-exact: sum of the printed (already rounded) lines + adjustment.
      grossPayout: RC.round2(RC.round2(linesSum) + adjustment)
    };
  }

  // ---- Numbering --------------------------------------------------------------

  /** ISO 8601 week number of a date string — the spec's ISOWEEKNUM. */
  function isoWeekNumber(dateStr) {
    var d = new Date(normDate(dateStr) + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) throw new Error('INVALID_PERIOD_END: ' + dateStr);
    var target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    target.setUTCDate(target.getUTCDate() - ((target.getUTCDay() + 6) % 7) + 3);
    var jan4 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
    return 1 + Math.round((target - jan4) / (7 * 24 * 3600 * 1000));
  }

  /**
   * `{prefix}-YYYY-{seq}` per org. Starts at the org's seed sequence and
   * skips any number already present, so a stale seed cannot double-issue.
   */
  function nextInvoiceNumber(org, existingInvoices, periodEnd) {
    var year = normDate(periodEnd).slice(0, 4);
    var prefix = String(org.InvoicePrefix || 'INV');
    var taken = {};
    existingInvoices.forEach(function (inv) { taken[inv.InvoiceNumber] = true; });
    var seq = Math.max(1, Math.floor(Number(org.InvoiceSeq) || 1));
    var number = prefix + '-' + year + '-' + pad4_(seq);
    while (taken[number]) {
      seq += 1;
      number = prefix + '-' + year + '-' + pad4_(seq);
    }
    return { invoiceNumber: number, invoiceSeq: seq + 1 };
  }

  function pad4_(n) {
    return String(n).length >= 4 ? String(n) : ('000' + n).slice(-4);
  }

  // ---- Generation ---------------------------------------------------------------

  /**
   * Weekly generator. `data` = { org, timeLogRows, lineRows, existingInvoices,
   * adjustment, adjustmentNote }. Returns
   *   { ok:true, invoice, invoiceLines, nextInvoiceSeq }  or
   *   { ok:false, error:'BLOCKING_SHIFTS', blocking:[...] }  or
   *   { ok:false, error:'FORBIDDEN_ROLE' | 'INVALID_PERIOD' }.
   */
  function generateWeeklyInvoice(ctx, periodStart, periodEnd, data) {
    assertCtx(ctx);
    if (MANAGER_ROLES.indexOf(ctx.role) === -1) {
      return { ok: false, error: 'FORBIDDEN_ROLE' };
    }
    var start = normDate(periodStart);
    var end = normDate(periodEnd);
    if (!start || !end || start > end) {
      return { ok: false, error: 'INVALID_PERIOD' };
    }

    // Guard first: refuse while unapproved work exists (V12). Blocking rows
    // are reported by technician and date, never silently skipped.
    var blocking = findBlockingShifts(data.timeLogRows, ctx.orgId, start, end);
    if (blocking.length > 0) {
      return { ok: false, error: 'BLOCKING_SHIFTS', blocking: blocking };
    }

    var lines = eligibleLines(data.lineRows, ctx.orgId, start, end, data.timeLogRows);
    var totals = computeHeaderTotals({
      orgId: ctx.orgId,
      lines: lines,
      timeLogRows: data.timeLogRows,
      periodStart: start,
      periodEnd: end,
      adjustment: data.adjustment,
      adjustmentNote: data.adjustmentNote
    });

    var numbered = nextInvoiceNumber(data.org, data.existingInvoices || [], end);

    // Materialize: stamp every picked line with the invoice number. The
    // frozen snapshots travel with the line — nothing is re-priced here.
    var invoiceLines = lines.map(function (l) {
      return {
        lineId: l.LineID,
        orgId: l.OrgID,
        category: l.Category || 'Services',
        taskName: l.TaskName,
        quantity: Number(l.Quantity),
        unitLabel: l.UnitLabel,
        rateSnapshot: Number(l.RateSnapshot),
        lineTotal: Number(l.LineTotal),
        invoiceId: numbered.invoiceNumber
      };
    });

    var invoice = {
      invoiceNumber: numbered.invoiceNumber,
      orgId: ctx.orgId,
      periodStart: start,
      periodEnd: end,
      weekNumber: isoWeekNumber(end),
      billableHours: totals.billableHours,
      hourlyPayout: totals.hourlyPayout,
      adjustment: totals.adjustment,
      adjustmentNote: data.adjustmentNote || '',
      grossPayout: totals.grossPayout,
      categoryTotals: totals.categoryTotals,
      status: 'draft'
    };
    return { ok: true, invoice: invoice, invoiceLines: invoiceLines, nextInvoiceSeq: numbered.invoiceSeq };
  }

  // ---- Void / release ------------------------------------------------------------

  /**
   * A voided invoice releases its lines back to invoiceId = null so the
   * next run picks them up — nothing is ever double-billed.
   */
  function voidInvoice(invoice, invoiceLines) {
    if (invoice.status === 'void') {
      return { ok: false, error: 'ALREADY_VOID' };
    }
    return {
      ok: true,
      invoice: Object.assign({}, invoice, { status: 'void' }),
      releasedLineIds: invoiceLines.map(function (l) { return l.lineId; })
    };
  }

  return {
    findBlockingShifts: findBlockingShifts,
    eligibleLines: eligibleLines,
    computeHeaderTotals: computeHeaderTotals,
    sumBillableHours: sumBillableHours,
    nextInvoiceNumber: nextInvoiceNumber,
    isoWeekNumber: isoWeekNumber,
    generateWeeklyInvoice: generateWeeklyInvoice,
    voidInvoice: voidInvoice
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = InvoiceGen;
}

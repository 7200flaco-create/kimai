/**
 * Line items — work performed, with save-time rate snapshots (spec
 * art_SHLLdADT, "Dependent dropdown — web app" section). Apps Script / Node
 * shared module. Pure core; sheet, session, and audit I/O live in
 * sheet-gate.js.
 *
 * Freeze invariant (spec vector V11): rate, task type, unit, and line total
 * are copied onto the line item at save. Invoice totals sum the frozen
 * LineTotal column only — the rollup function below does not even accept a
 * catalog argument, so re-pricing a saved line from live rates is
 * unrepresentable in this module.
 */
var LineItems = (function () {
  'use strict';


  // Apps Script: RateCatalog arrives as a global from rate-catalog.js.
  // Node (tests): each file is its own module scope, so resolve it explicitly.
  var RC = typeof RateCatalog !== 'undefined'
    ? RateCatalog
    : (typeof require === 'function' ? require('./rate-catalog.js') : null);

  function assertCtx(ctx) {
    if (!ctx || typeof ctx.orgId !== 'string' || !ctx.orgId) {
      // ctx.orgId comes from the authenticated session, never the payload.
      throw new Error('ORG_SCOPE_REQUIRED');
    }
  }

  /**
   * Build a frozen line item from a submission.
   * Returns { ok: true, item } or { ok: false, error }.
   *
   * The catalog lookup is scoped to ctx.orgId: a serviceId belonging to
   * another org resolves to null and yields the SAME error as an unknown
   * serviceId — no error text reveals the other org's catalog (spec V9/V10).
   */
  function buildLineItem(ctx, input, catalogRows, options) {
    assertCtx(ctx);
    options = options || {};

    var qty = Number(input.quantity);
    if (!(qty > 0)) {
      return { ok: false, error: 'INVALID_QUANTITY' };
    }

    var svc = RC.findActiveByServiceId(catalogRows, ctx.orgId, input.serviceId);
    if (!svc) {
      return { ok: false, error: 'SERVICE_NOT_IN_YOUR_CATALOG' };
    }

    var item = {
      lineId: options.lineId || null,
      orgId: ctx.orgId,
      shiftId: input.shiftId || '',
      workDate: input.workDate,
      taskKey: svc.serviceId,
      taskName: svc.taskName,
      // Everything below is the frozen snapshot — never re-read later.
      taskType: svc.taskType,
      quantity: qty,
      unitLabel: svc.unitLabel,
      rateSnapshot: svc.rate,
      lineTotal: RC.computeLineTotal(svc.taskType, qty, svc.rate),
      category: svc.category,
      invoiceId: null
    };
    return { ok: true, item: item };
  }

  /**
   * Invoice rollup reads ONLY frozen line values. invoiceId == null sums
   * unbilled lines (the pre-generation preview); otherwise only lines
   * stamped with that invoice.
   */
  function sumFrozenLineTotals(lineItems, invoiceId) {
    var sum = 0;
    for (var i = 0; i < lineItems.length; i++) {
      var inScope = invoiceId == null ? lineItems[i].invoiceId == null
                                      : lineItems[i].invoiceId === invoiceId;
      if (inScope) {
        sum += lineItems[i].lineTotal;
      }
    }
    return RC.round2(sum);
  }

  return {
    buildLineItem: buildLineItem,
    sumFrozenLineTotals: sumFrozenLineTotals
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LineItems;
}

/**
 * Line-item repository — the tenant-scoped write path for work performed
 * (spec art_SHLLdADT, "Dependent dropdown — web app" + vector V9). Google
 * Apps Script / Node shared module. Pure over injected collaborators.
 *
 * Validation and snapshot math are NOT duplicated here: the builder
 * (deps.buildLineItem — the LineItems.buildLineItem pure module) scopes the
 * catalog lookup to ctx.orgId, so a foreign serviceId resolves to the SAME
 * error as an unknown one (V9: SERVICE_NOT_IN_YOUR_CATALOG, no existence
 * leak). This repo adds what the builder must not do: persistence, role and
 * ownership enforcement, and the audit row on EVERY path — success or
 * denial.
 *
 * Field-edit rule (spec matrix, "Log work performed (line items)"): a
 * technician cannot edit rate/type/total — and neither can anyone: rate,
 * type, and total are snapshots frozen at save; updates touch only
 * description (technician) and quantity (manager/admin, with the total
 * recomputed from the FROZEN snapshot, never from the live catalog).
 *
 * deps: {
 *   data             — row backend (getRows / appendRow / updateRows)
 *   audit            — AuditLog.createWriter(...) instance
 *   rbac             — the Rbac module (injected, not a free variable)
 *   buildLineItem    — LineItems.buildLineItem(ctx, input, catalogRows)
 *   computeLineTotal — RateCatalog.computeLineTotal(taskType, qty, rate)
 *   newId()          — id generator (Utilities.getUuid in the deployment)
 *   clock()          — Date source
 * }
 */
var LineItemRepo = (function () {
  'use strict';

  function requireDeps(deps) {
    var keys = ['data', 'audit', 'rbac', 'buildLineItem', 'computeLineTotal', 'newId', 'clock'];
    var missing = [];
    for (var i = 0; i < keys.length; i++) {
      if (deps == null || deps[keys[i]] == null) missing.push(keys[i]);
    }
    if (missing.length) {
      throw new Error('DEPS_MISSING: ' + missing.join(','));
    }
  }

  function shallowCopy(row) {
    var out = {};
    for (var k in row) {
      if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
    }
    return out;
  }

  function denied(error) {
    return { ok: false, error: error };
  }

  function create(deps) {
    requireDeps(deps);
    var data = deps.data;
    var audit = deps.audit;
    var rbac = deps.rbac;
    var buildLineItem = deps.buildLineItem;
    var computeLineTotal = deps.computeLineTotal;
    var newId = deps.newId;
    var clock = deps.clock;

    function actorFor(ctx) {
      return { email: ctx.email, orgId: ctx.orgId == null ? '' : ctx.orgId };
    }

    function auditDenial(ctx, entity, entityId, attempt, reason) {
      // The attempted entity id rides in the After blob — the sheet's
      // 7-column audit projection folds entity_id into the JSON values.
      audit.write(actorFor(ctx), entity, entityId, 'access_denied', null,
        { attempted: attempt, entityId: entityId || '', reason: reason });
    }

    /** Maps the builder's camelCase item onto Work Performed's columns. */
    function toRow(item) {
      return {
        LineID: item.lineId || newId(),
        OrgID: item.orgId,
        ShiftID: item.shiftId || '',
        WorkDate: item.workDate || '',
        TaskKey: item.taskKey,
        TaskName: item.taskName,
        TaskType: item.taskType,
        Quantity: item.quantity,
        UnitLabel: item.unitLabel,
        RateSnapshot: item.rateSnapshot,
        LineTotal: item.lineTotal,
        Category: item.category,
        InvoiceID: item.invoiceId == null ? '' : item.invoiceId
      };
    }

    function findRow(orgId, lineId) {
      var rows = data.getRows('lineItems');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].OrgID === orgId && rows[i].LineID === lineId) return rows[i];
      }
      return null;
    }

    function findShift(orgId, shiftId) {
      var rows = data.getRows('shifts');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].OrgID === orgId && rows[i].ShiftID === shiftId) return rows[i];
      }
      return null;
    }

    /**
     * Save work performed. V9 lives here: the builder's catalog lookup is
     * scoped to ctx.orgId, so a serviceId belonging to another org is
     * rejected with SERVICE_NOT_IN_YOUR_CATALOG — and the denial is
     * audited. No row is written either way.
     */
    function save(ctx, input) {
      input = input || {};
      var g = rbac.check(ctx, 'logWork');
      if (!g.ok) {
        auditDenial(ctx, 'line_item', input.serviceId || '', 'save', 'DENIED:' + g.capability);
        return denied('DENIED');
      }
      var built = buildLineItem(ctx, input, data.getRows('catalog'));
      if (!built.ok) {
        // V9: cross-tenant (and unknown) serviceId — same error either way,
        // the attempted write is on the audit trail, nothing persisted.
        auditDenial(ctx, 'line_item', input.serviceId || '', 'save', built.error);
        return denied(built.error);
      }
      // Technician ownership (matrix: "create, own only"): a line attached
      // to a shift must attach to THEIR shift. A foreign shiftId is the
      // same NOT_FOUND as a missing one — no leak.
      if (ctx.role === 'technician' && input.shiftId) {
        var shift = findShift(ctx.orgId, input.shiftId);
        if (!shift || shift.TechnicianID !== ctx.userId) {
          auditDenial(ctx, 'line_item', input.shiftId, 'save', 'NOT_FOUND');
          return denied('NOT_FOUND');
        }
      }
      var row = toRow(built.item);
      data.appendRow('lineItems', row);
      audit.write(actorFor(ctx), 'line_item', row.LineID, 'create', null, shallowCopy(row));
      return { ok: true, item: shallowCopy(row) };
    }

    /**
     * Update an unbilled line. Quantity is the ONLY post-save edit — for
     * any role — and re-prices from the frozen RateSnapshot, never the
     * live catalog. Rate/type/total are never client-editable (the
     * snapshot is only ever written by save()); invoiced lines are frozen
     * entirely (spec: history is immutable; corrections are new lines).
     */
    function update(ctx, lineId, patch) {
      patch = patch || {};
      var g = rbac.check(ctx, 'logWork');
      if (!g.ok) {
        auditDenial(ctx, 'line_item', lineId, 'update', 'DENIED:' + g.capability);
        return denied('DENIED');
      }
      var row = findRow(ctx.orgId, lineId);
      if (!row) {
        auditDenial(ctx, 'line_item', lineId, 'update', 'NOT_FOUND');
        return denied('NOT_FOUND');
      }
      if (row.InvoiceID) {
        auditDenial(ctx, 'line_item', lineId, 'update', 'INVOICE_FROZEN');
        return denied('INVOICE_FROZEN');
      }
      // Technicians own their lines (matrix: "create, own only") —
      // ownership resolves through the line's shift; a shiftless line
      // proves nothing, so their update fails closed like a foreign row.
      if (ctx.role === 'technician') {
        var shift = row.ShiftID ? findShift(ctx.orgId, row.ShiftID) : null;
        if (!shift || shift.TechnicianID !== ctx.userId) {
          auditDenial(ctx, 'line_item', lineId, 'update', 'NOT_FOUND');
          return denied('NOT_FOUND');
        }
      }
      // The only editable field for any role. The matrix forbids editing
      // rate/type/total, and the Work Performed sheet has no description
      // column — so quantity is what remains.
      var allowed = { Quantity: true };
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && !allowed[key]) {
          // Includes the snapshot fields (RateSnapshot, TaskType, LineTotal)
          // and anything else not on the whitelist — refuse loudly, audit.
          auditDenial(ctx, 'line_item', lineId, 'update', 'FIELD_NOT_EDITABLE:' + key);
          return denied('FIELD_NOT_EDITABLE');
        }
      }
      var clean = {};
      if (patch.Quantity != null) {
        var qty = Number(patch.Quantity);
        if (!(qty > 0)) {
          auditDenial(ctx, 'line_item', lineId, 'update', 'INVALID_QUANTITY');
          return denied('INVALID_QUANTITY');
        }
        clean.Quantity = qty;
        // Total follows quantity, priced from the FROZEN snapshot.
        clean.LineTotal = computeLineTotal(row.TaskType, qty, row.RateSnapshot);
      }
      if (Object.keys(clean).length === 0) {
        return { ok: true, item: shallowCopy(row) }; // nothing to change — no mutation, no audit
      }
      var before = shallowCopy(row);
      data.updateRows('lineItems', function (r) {
        return r.OrgID === ctx.orgId && r.LineID === lineId;
      }, clean);
      for (var k in clean) {
        if (Object.prototype.hasOwnProperty.call(clean, k)) row[k] = clean[k];
      }
      audit.write(actorFor(ctx), 'line_item', lineId, 'update', before, shallowCopy(row));
      return { ok: true, item: shallowCopy(row) };
    }

    return { save: save, update: update };
  }

  return { create: create };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LineItemRepo;
}

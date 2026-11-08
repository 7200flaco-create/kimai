/**
 * Shift repository — tenant-scoped reads and writes over the canonical
 * shift rows (spec art_SHLLdADT, "Layer 2 — repository scoping"; vector
 * V10). Google Apps Script / Node shared module. Pure over the injected
 * row backend — no SpreadsheetApp / Session references here.
 *
 * Scope rule: the org comes from the session ctx (ctx.orgId), never from a
 * request parameter. Tenant roles are PINNED to ctx.orgId — a differing
 * requestedOrgId is ignored, never honored. Only platform_admin may pass an
 * explicit scopeOrgId (the matrix's "See other organizations" path).
 *
 * Fail closed (V10): a foreign shiftId is indistinguishable from a missing
 * one — zero rows and the same NOT_FOUND result either way; no error text
 * names the other org or reveals that the id exists elsewhere.
 *
 * Audit rule: every MUTATING call — success or denial — writes exactly one
 * audit row through the injected writer. Pure reads (findVisible,
 * findById) write nothing.
 *
 * deps: {
 *   data    — row backend: getRows(tab), appendRow(tab,row),
 *             updateRows(tab, matchFn, patch)
 *   audit   — AuditLog.createWriter(...) instance
 *   rbac    — the Rbac module (injected, not a free variable: node modules
 *             have no shared global scope)
 *   newId() — id generator (Utilities.getUuid in the deployment)
 *   clock() — Date source for frozen approval timestamps
 * }
 */
var ShiftRepo = (function () {
  'use strict';

  function requireDeps(deps) {
    var keys = ['data', 'audit', 'rbac', 'newId', 'clock'];
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
    var newId = deps.newId;
    var clock = deps.clock;

    /** The audit actor: for platform-admin mutations the org is the TARGET
     *  org (they have none of their own). */
    function actorFor(ctx, orgId) {
      return { email: ctx.email, orgId: orgId == null ? '' : orgId };
    }

    function auditDenial(actor, entity, entityId, attempt, reason) {
      // The attempted entity id rides in the After blob — the sheet's
      // 7-column audit projection folds entity_id into the JSON values.
      audit.write(actor, entity, entityId, 'access_denied', null,
        { attempted: attempt, entityId: entityId || '', reason: reason });
    }

    /** Capability gate — a denial is audited and returned as a value. */
    function guard(ctx, capability, entity, entityId, attempt, orgId) {
      var check = rbac.check(ctx, capability);
      if (!check.ok) {
        auditDenial(actorFor(ctx, orgId), entity, entityId, attempt,
          'DENIED:' + check.capability);
        return denied('DENIED');
      }
      return null;
    }

    /**
     * Tenant roles: always the session org. Platform admin: the explicitly
     * requested org (mutations REQUIRE one — null scope means reads across
     * orgs only).
     */
    function resolveScope(ctx, requestedOrgId) {
      if (ctx.role === 'platform_admin') {
        return requestedOrgId || null;
      }
      return ctx.orgId;
    }

    function findRow(orgId, shiftId) {
      if (!orgId) return null;
      var rows = data.getRows('shifts');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].OrgID === orgId && rows[i].ShiftID === shiftId) {
          return rows[i];
        }
      }
      return null;
    }

    function findUser(orgId, userId) {
      var rows = data.getRows('users');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].OrgID === orgId && rows[i].UserID === userId &&
            String(rows[i].IsActive).toUpperCase() === 'TRUE') {
          return rows[i];
        }
      }
      return null;
    }

    /**
     * Role-filtered visibility (spec matrix "View own shift history"):
     * technician → own rows; manager/admin → all org rows; platform admin →
     * every org (optionally narrowed by requestedOrgId).
     */
    function findVisible(ctx, requestedOrgId) {
      var scope = resolveScope(ctx, requestedOrgId);
      var rows = data.getRows('shifts');
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (ctx.role === 'platform_admin') {
          if (scope && r.OrgID !== scope) continue;
        } else {
          // V10: the org filter is in the query — other orgs' rows are
          // never present in the result at all.
          if (r.OrgID !== ctx.orgId) continue;
          if (ctx.role === 'technician' && r.TechnicianID !== ctx.userId) continue;
        }
        out.push(r);
      }
      return out;
    }

    /** V10 path: foreign or missing id → null either way. */
    function findById(ctx, shiftId, requestedOrgId) {
      var scope = resolveScope(ctx, requestedOrgId);
      if (ctx.role === 'platform_admin') {
        if (!scope) {
          var all = data.getRows('shifts');
          for (var i = 0; i < all.length; i++) {
            if (all[i].ShiftID === shiftId) return all[i];
          }
          return null;
        }
        return findRow(scope, shiftId);
      }
      var row = findRow(scope, shiftId);
      if (!row) return null;
      if (ctx.role === 'technician' && row.TechnicianID !== ctx.userId) return null;
      return row;
    }

    /**
     * Clock-in. Technicians own every shift they create (input.technicianId
     * is ignored for them); manager/admin may log for a technician of the
     * SAME org only — a foreign technicianId is rejected and audited.
     */
    function insert(ctx, input, requestedOrgId) {
      input = input || {};
      var scope = resolveScope(ctx, requestedOrgId);
      var g = guard(ctx, 'logTime', 'shift', '', 'insert', scope);
      if (g) return g;
      if (!scope) {
        auditDenial(actorFor(ctx, ''), 'shift', '', 'insert', 'ORG_SCOPE_REQUIRED');
        return denied('ORG_SCOPE_REQUIRED');
      }
      var techId = ctx.role === 'technician' ? ctx.userId : (input.technicianId || ctx.userId);
      if (ctx.role !== 'technician' && !findUser(scope, techId)) {
        auditDenial(actorFor(ctx, scope), 'shift', '', 'insert', 'TECHNICIAN_NOT_IN_ORG');
        return denied('TECHNICIAN_NOT_IN_ORG');
      }
      var row = {
        ShiftID: newId(),
        OrgID: scope,
        TechnicianID: techId,
        WorkDate: input.workDate || '',
        ClockIn: input.clockIn || '',
        ClockOut: input.clockOut || '',
        BreakMin: input.breakMinutes == null ? 0 : input.breakMinutes,
        RawHours: '',
        NetHours: '',
        CrossMidnight: '',
        OTFlag: '',
        Status: 'open',
        ApprovedBy: '',
        Notes: input.notes || ''
      };
      data.appendRow('shifts', row);
      audit.write(actorFor(ctx, scope), 'shift', row.ShiftID, 'create', null, shallowCopy(row));
      return { ok: true, shift: shallowCopy(row) };
    }

    /**
     * Submit for approval. Technician: own shifts only (a foreign id —
     * whether another technician's or another org's — is the same
     * NOT_FOUND, audited, no leak).
     */
    function submit(ctx, shiftId) {
      var scope = resolveScope(ctx, null);
      var g = guard(ctx, 'logTime', 'shift', shiftId, 'submit', scope);
      if (g) return g;
      var row = findRow(scope, shiftId);
      if (!row || (ctx.role === 'technician' && row.TechnicianID !== ctx.userId)) {
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'submit', 'NOT_FOUND');
        return denied('NOT_FOUND');
      }
      if (row.Status !== 'open') {
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'submit', 'INVALID_STATUS:' + row.Status);
        return denied('INVALID_STATUS');
      }
      var before = shallowCopy(row);
      data.updateRows('shifts', function (r) {
        return r.OrgID === scope && r.ShiftID === shiftId;
      }, { Status: 'submitted' });
      row.Status = 'submitted';
      audit.write(actorFor(ctx, scope), 'shift', shiftId, 'submit', before, shallowCopy(row));
      return { ok: true, shift: shallowCopy(row) };
    }

    /**
     * Approve — freezes the hours the time engine computed (rawHours,
     * netHours, otFlag are written to the row at approval and the invoice
     * reads only these frozen values; spec "Freeze on approval"). Requires
     * the submitted status and the approveShifts capability.
     */
    function approve(ctx, shiftId, frozen, requestedOrgId) {
      frozen = frozen || {};
      var scope = resolveScope(ctx, requestedOrgId);
      var g = guard(ctx, 'approveShifts', 'shift', shiftId, 'approve', scope);
      if (g) return g;
      if (!scope) {
        auditDenial(actorFor(ctx, ''), 'shift', shiftId, 'approve', 'ORG_SCOPE_REQUIRED');
        return denied('ORG_SCOPE_REQUIRED');
      }
      if (frozen.rawHours == null || frozen.netHours == null) {
        // Approving without frozen hours would bill nothing — refuse loudly.
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'approve', 'FROZEN_HOURS_REQUIRED');
        return denied('FROZEN_HOURS_REQUIRED');
      }
      var row = findRow(scope, shiftId);
      if (!row) {
        // V10: foreign-org id and unknown id are the same outcome —
        // NOT_FOUND, audited, and no hint the other org exists.
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'approve', 'NOT_FOUND');
        return denied('NOT_FOUND');
      }
      if (row.Status !== 'submitted') {
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'approve', 'NOT_SUBMITTED:' + row.Status);
        return denied('NOT_SUBMITTED');
      }
      var before = shallowCopy(row);
      var patch = {
        Status: 'approved',
        ApprovedBy: ctx.userId,
        ApprovedAt: clock().toISOString(),
        RawHours: frozen.rawHours,
        NetHours: frozen.netHours,
        OTFlag: frozen.otFlag || ''
      };
      data.updateRows('shifts', function (r) {
        return r.OrgID === scope && r.ShiftID === shiftId;
      }, patch);
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) row[k] = patch[k];
      }
      audit.write(actorFor(ctx, scope), 'shift', shiftId, 'approve', before, shallowCopy(row));
      return { ok: true, shift: shallowCopy(row) };
    }

    /** Reject — same guards as approve; the reason lands in Notes and the audit row. */
    function reject(ctx, shiftId, reason, requestedOrgId) {
      var scope = resolveScope(ctx, requestedOrgId);
      var g = guard(ctx, 'approveShifts', 'shift', shiftId, 'reject', scope);
      if (g) return g;
      if (!scope) {
        auditDenial(actorFor(ctx, ''), 'shift', shiftId, 'reject', 'ORG_SCOPE_REQUIRED');
        return denied('ORG_SCOPE_REQUIRED');
      }
      var row = findRow(scope, shiftId);
      if (!row) {
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'reject', 'NOT_FOUND');
        return denied('NOT_FOUND');
      }
      if (row.Status !== 'submitted') {
        auditDenial(actorFor(ctx, scope), 'shift', shiftId, 'reject', 'NOT_SUBMITTED:' + row.Status);
        return denied('NOT_SUBMITTED');
      }
      var before = shallowCopy(row);
      var patch = {
        Status: 'rejected',
        ApprovedBy: ctx.userId,
        Notes: (row.Notes ? row.Notes + ' | ' : '') + 'Rejected: ' + (reason || '')
      };
      data.updateRows('shifts', function (r) {
        return r.OrgID === scope && r.ShiftID === shiftId;
      }, patch);
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) row[k] = patch[k];
      }
      audit.write(actorFor(ctx, scope), 'shift', shiftId, 'reject', before, shallowCopy(row));
      return { ok: true, shift: shallowCopy(row) };
    }

    return {
      findVisible: findVisible,
      findById: findById,
      insert: insert,
      submit: submit,
      approve: approve,
      reject: reject
    };
  }

  return { create: create };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ShiftRepo;
}

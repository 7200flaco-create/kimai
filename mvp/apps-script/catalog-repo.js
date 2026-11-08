/**
 * Catalog admin — rate-card mutations under the permission matrix (spec
 * art_SHLLdADT, "Edit rate card & org settings": admin own org, platform
 * admin; manager READ-ONLY). Google Apps Script / Node shared module.
 *
 * The change itself is a plain field update; the security content is the
 * capability gate (a manager calling this is denied and audited), the org
 * scope (a foreign ServiceID is the same NOT_FOUND as a missing one — V10
 * shape), and the 'rate_change' audit row with before/after rates. Existing
 * line items keep their frozen RateSnapshot regardless — repricing touches
 * only NEW work (spec vector V11).
 *
 * deps: {
 *   data   — row backend (getRows / appendRow / updateRows)
 *   audit  — AuditLog.createWriter(...) instance
 *   rbac   — the Rbac module (injected, not a free variable)
 *   clock()— Date source
 * }
 */
var CatalogAdmin = (function () {
  'use strict';

  function requireDeps(deps) {
    var keys = ['data', 'audit', 'rbac', 'clock'];
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
    var clock = deps.clock;

    function actorFor(ctx, orgId) {
      return { email: ctx.email, orgId: orgId == null ? '' : orgId };
    }

    function auditDenial(actor, serviceId, attempt, reason) {
      // The attempted serviceId rides in the After blob — the sheet's
      // 7-column audit projection folds entity_id into the JSON values.
      audit.write(actor, 'service_catalog', serviceId, 'access_denied', null,
        { attempted: attempt, entityId: serviceId || '', reason: reason });
    }

    /**
     * Change a catalog rate. Tenant admins are pinned to ctx.orgId;
     * platform admin must name the org. The composite key (org AND
     * serviceId) is the same discipline as the lookup path (V8) — matching
     * on serviceId alone would be a cross-tenant pricing bug.
     */
    function changeRate(ctx, serviceId, newRate, requestedOrgId) {
      var scope = ctx.role === 'platform_admin' ? (requestedOrgId || null) : ctx.orgId;
      var g = rbac.check(ctx, 'editRateCard');
      if (!g.ok) {
        auditDenial(actorFor(ctx, scope), serviceId || '', 'changeRate', 'DENIED:' + g.capability);
        return denied('DENIED');
      }
      if (!scope) {
        auditDenial(actorFor(ctx, ''), serviceId || '', 'changeRate', 'ORG_SCOPE_REQUIRED');
        return denied('ORG_SCOPE_REQUIRED');
      }
      var rate = Number(newRate);
      if (!(typeof rate === 'number' && isFinite(rate) && rate >= 0)) {
        auditDenial(actorFor(ctx, scope), serviceId || '', 'changeRate', 'INVALID_RATE');
        return denied('INVALID_RATE');
      }
      var rows = data.getRows('catalog');
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].OrgID === scope && rows[i].ServiceID === serviceId) {
          row = rows[i];
          break;
        }
      }
      if (!row || String(row.IsActive).toUpperCase() !== 'TRUE') {
        // V10 shape: foreign and unknown ids are the same NOT_FOUND.
        auditDenial(actorFor(ctx, scope), serviceId || '', 'changeRate', 'NOT_FOUND');
        return denied('NOT_FOUND');
      }
      var before = shallowCopy(row);
      var previousRate = row.Rate;
      data.updateRows('catalog', function (r) {
        return r.OrgID === scope && r.ServiceID === serviceId;
      }, { Rate: rate });
      row.Rate = rate;
      var after = shallowCopy(row);
      audit.write(actorFor(ctx, scope), 'service_catalog', serviceId, 'rate_change', before, after);
      return { ok: true, catalog: after, previousRate: previousRate };
    }

    return { changeRate: changeRate };
  }

  return { create: create };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CatalogAdmin;
}

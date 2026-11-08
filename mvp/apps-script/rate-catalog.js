/**
 * Rate catalog — the only place tasks and prices live (spec art_SHLLdADT,
 * "rate-lookup" section). Google Apps Script / Node shared module.
 *
 * Pure core: no I/O. Rows arrive as plain objects in the Service Catalog
 * sheet's column order; results are plain values. Sheet and session access
 * live in sheet-gate.js.
 *
 * Tenancy rule: every lookup carries the caller's orgId. The composite
 * OrgID|TaskName key is what lets two orgs both define "Repair" at different
 * rates (spec vector V8) — any lookup on task name alone is a cross-tenant
 * pricing bug.
 */
var RateCatalog = (function () {
  'use strict';

  var TASK_TYPES = ['hourly', 'unit_flat', 'material', 'job_fixed'];

  // Fail closed: an unscoped query would fan out across tenants.
  function assertOrgScope(orgId) {
    if (typeof orgId !== 'string' || !orgId) {
      throw new Error('ORG_SCOPE_REQUIRED');
    }
  }

  function isTrue(value) {
    return String(value).toUpperCase() === 'TRUE';
  }

  /**
   * All active catalog rows for exactly one org — the dropdown payload.
   * The org filter is in the query, not the UI: Org B's task names are never
   * present in the returned array at all (spec vector V8).
   */
  function catalogForOrg(rows, orgId) {
    assertOrgScope(orgId);
    return rows
      .filter(function (r) { return r.OrgID === orgId && isTrue(r.IsActive); })
      .map(toCatalogItem);
  }

  function toCatalogItem(row) {
    return {
      serviceId: row.ServiceID,
      taskName: row.TaskName,
      taskType: row.TaskType,
      unitLabel: row.UnitLabel,
      rate: Number(row.Rate),
      category: row.Category,
      billable: isTrue(row.Billable)
    };
  }

  function catalogKey(orgId, taskName) {
    return orgId + '|' + taskName;
  }

  /**
   * Composite-key lookup: resolves by org AND task name, so colliding task
   * names across orgs stay distinct (V8). Exact match; "not found" surfaces
   * loudly as null — callers own the error.
   */
  function findActiveByTaskName(rows, orgId, taskName) {
    assertOrgScope(orgId);
    var key = catalogKey(orgId, taskName);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (catalogKey(r.OrgID, r.TaskName) === key && isTrue(r.IsActive)) {
        return toCatalogItem(r);
      }
    }
    return null;
  }

  /** Org-scoped lookup by ServiceID — validates a submitted TaskKey. */
  function findActiveByServiceId(rows, orgId, serviceId) {
    assertOrgScope(orgId);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.OrgID === orgId && r.ServiceID === serviceId && isTrue(r.IsActive)) {
        return toCatalogItem(r);
      }
    }
    return null;
  }

  /**
   * Line math for all four task types (spec "The lookup model" table).
   * job_fixed ignores quantity — the rate IS the job price.
   */
  function computeLineTotal(taskType, quantity, rate) {
    if (TASK_TYPES.indexOf(taskType) === -1) {
      throw new Error('UNKNOWN_TASK_TYPE: ' + taskType);
    }
    if (taskType === 'job_fixed') {
      return round2(rate);
    }
    return round2(quantity * rate);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  return {
    TASK_TYPES: TASK_TYPES,
    catalogKey: catalogKey,
    catalogForOrg: catalogForOrg,
    findActiveByTaskName: findActiveByTaskName,
    findActiveByServiceId: findActiveByServiceId,
    computeLineTotal: computeLineTotal,
    round2: round2
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RateCatalog;
}

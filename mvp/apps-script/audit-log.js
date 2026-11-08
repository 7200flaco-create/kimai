/**
 * Audit log — append-only record of every mutation and every denied write
 * (spec art_SHLLdADT: "There is no code path that mutates a shift, a rate,
 * or an invoice without an audit row — the MVP treats 'unaudited change' as
 * a bug class, not a nice-to-have").
 *
 * Google Apps Script / Node shared module. Pure over the injected row
 * backend: sheet I/O goes through `data` (InMemoryData under test,
 * AppsScriptData in the deployment), never through SpreadsheetApp here.
 *
 * Columns match the Audit Log sheet exactly: Timestamp | ActorEmail | OrgID |
 * Entity | Action | Before | After. The entity id rides inside the
 * Before/After JSON — the sheet projection folds audit_log.entity_id into
 * those blobs rather than adding a column.
 */
var AuditLog = (function () {
  'use strict';

  /**
   * createWriter(data, clock) → { write(actor, entity, entityId, action,
   * beforeVal, afterVal) }.
   *
   * `actor` is { email, orgId } — the REPO supplies the org, which for a
   * platform-admin mutation is the target org, not the actor's (the actor
   * has none). Mutating functions pass their own ctx through actorFor();
   * there is deliberately no way to write a row without an actor.
   */
  function createWriter(data, clock) {
    function write(actor, entity, entityId, action, beforeVal, afterVal) {
      var row = {
        Timestamp: clock(),
        ActorEmail: actor.email,
        OrgID: actor.orgId == null ? '' : actor.orgId,
        Entity: entity,
        Action: action,
        Before: beforeVal == null ? '' : JSON.stringify(beforeVal),
        After: afterVal == null ? '' : JSON.stringify(afterVal)
      };
      data.appendRow('audit', row);
      return row;
    }
    return { write: write };
  }

  /**
   * Org-scoped reader. Tenant roles see only their org's entries; a query
   * for another org's rows returns nothing at all — same fail-closed shape
   * as every other cross-tenant read (V10). Only the platform admin sees
   * across orgs (spec matrix, "See other organizations").
   * filters: { entity, action } — both optional.
   */
  function listForOrg(data, ctx, filters) {
    filters = filters || {};
    var rows = data.getRows('audit');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (ctx.role !== 'platform_admin' && r.OrgID !== ctx.orgId) {
        continue;
      }
      if (filters.entity && r.Entity !== filters.entity) {
        continue;
      }
      if (filters.action && r.Action !== filters.action) {
        continue;
      }
      out.push(r);
    }
    return out;
  }

  return { createWriter: createWriter, listForOrg: listForOrg };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AuditLog;
}

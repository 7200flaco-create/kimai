/**
 * Apps Script edge layer — the ONLY file that touches SpreadsheetApp,
 * Session, or Utilities. Pure logic lives in rate-catalog.js and
 * line-items.js. Deploy order in the Apps Script project: rate-catalog.js,
 * line-items.js, then this file (the globals below reference those).
 *
 * Boundary invariant (spec "Access control"): every web-app handler funnels
 * through withAuth; end users never receive spreadsheet URLs or raw sheet
 * access. The workbook is never shared with tenant users.
 */

var SESSION = (function () {
  'use strict';

  var ROLES = ['platform_admin', 'admin', 'manager', 'technician'];

  /**
   * Session gate (spec Layer 1). Identity source is Google SSO during the
   * MVP; the same handler signature works with NextAuth sessions later.
   * Fails closed: unknown or inactive email → ACCESS_DENIED, and any
   * client-supplied orgId/userId fields are stripped from the payload.
   */
  function withAuth(handler) {
    return function (e) {
      var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
      var user = findActiveUserByEmail(email);
      if (!user) {
        return json_({ error: 'ACCESS_DENIED' });
      }
      var ctx = {
        userId: user.UserID,
        orgId: user.OrgID || null,
        role: user.Role
      };
      var payload = (e && e.parameter) || {};
      delete payload.orgId;   // defense in depth: the org comes from ctx
      delete payload.userId;
      return handler(ctx, payload);
    };
  }

  function findActiveUserByEmail(email) {
    var rows = readSheet_('Users');
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].Email).toLowerCase() === email &&
          String(rows[i].IsActive).toUpperCase() === 'TRUE') {
        return rows[i];
      }
    }
    return null;
  }

  function json_(obj) {
    return ContentService
      .createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return { withAuth: withAuth, ROLES: ROLES };
})();

var SheetCatalogRepo = (function () {
  'use strict';

  /** All catalog rows, keyed like the Service Catalog sheet headers. */
  function readAll() {
    return readSheet_('Service Catalog');
  }

  /** Dropdown payload for one session: own org's active tasks only. */
  function findActiveForSession(ctx) {
    return RateCatalog.catalogForOrg(readAll(), ctx.orgId);
  }

  return { readAll: readAll, findActiveForSession: findActiveForSession };
})();

var SheetLineItemRepo = (function () {
  'use strict';

  /**
   * Scoped write: the item carries its own orgId (from ctx at build time).
   * Columns follow the Work Performed sheet order.
   */
  function insert(item) {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Work Performed');
    if (item.lineId == null) {
      item.lineId = Utilities.getUuid();
    }
    sheet.appendRow([
      item.lineId, item.orgId, item.shiftId, item.workDate, item.taskKey,
      item.taskName, item.taskType, item.quantity, item.unitLabel,
      item.rateSnapshot, item.lineTotal, item.category, item.invoiceId
    ]);
    return item;
  }

  return { insert: insert };
})();

var SheetAuditLog = (function () {
  'use strict';

  /**
   * One row per mutation, before/after values included. There is no code
   * path below that mutates data without writing here (spec: "unaudited
   * change" is a bug class).
   */
  function write(ctx, entity, entityId, action, beforeVal, afterVal) {
    SpreadsheetApp.getActive().getSheetByName('Audit Log').appendRow([
      new Date(), Session.getActiveUser().getEmail(), ctx.orgId,
      entity, entityId, action,
      beforeVal == null ? '' : JSON.stringify(beforeVal),
      afterVal == null ? '' : JSON.stringify(afterVal)
    ]);
  }

  return { write: write };
})();

/**
 * Web-app save path: build (pure, snapshot-freezing) → persist → audit,
 * in one handler. Rate/type/total on the saved row can never be edited by
 * the submitting user; corrections create a new line with a new audit row.
 */
var saveLineItem = SESSION.withAuth(function (ctx, payload) {
  var result = LineItems.buildLineItem(ctx, payload, SheetCatalogRepo.readAll());
  if (!result.ok) {
    SheetAuditLog.write(ctx, 'line_item', payload.taskKey || '', 'save_rejected', null, { error: result.error });
    return { ok: false, error: result.error };
  }
  var saved = SheetLineItemRepo.insert(result.item);
  SheetAuditLog.write(ctx, 'line_item', saved.lineId, 'create', null, saved);
  return { ok: true, item: saved };
});

/** Web-app dropdown endpoint: only the caller's own active catalog rows. */
var getCatalogForSession = SESSION.withAuth(function (ctx) {
  return { ok: true, tasks: SheetCatalogRepo.findActiveForSession(ctx) };
});

/** Column headers each sheet's rows are zipped against. */
function readSheet_(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue; // skip blank rows
    var row = {};
    for (var c = 0; c < headers.length; c++) {
      row[headers[c]] = values[i][c];
    }
    rows.push(row);
  }
  return rows;
}

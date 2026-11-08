/**
 * Security edge — wires the pure security modules to Google Apps Script
 * (spec art_SHLLdADT, Layers 1–3). This is the ONLY file in the security
 * layer that touches SpreadsheetApp / Session / Utilities / ContentService;
 * it is deploy-glue and is intentionally NOT unit-tested under node (the
 * five pure modules carry the logic and the tests).
 *
 * Deploy order in the Apps Script project: rbac.js, audit-log.js,
 * shift-repo.js, line-item-repo.js, catalog-repo.js, rate-catalog.js,
 * line-items.js, then this file.
 *
 * Boundary invariant: end users reach data only through these handlers —
 * the workbook is never shared with tenant users, and protected ranges
 * backstop direct-edit accidents (spec Layer 3).
 */
var SecurityEdge = (function () {
  'use strict';

  /** Logical tab → physical sheet name (matches the MVP workbook). */
  var LOGICAL_TABS = {
    users: 'Users',
    shifts: 'Time Log',          // canonical shift rows incl. computed + approval columns
    lineItems: 'Work Performed',
    catalog: 'Service Catalog',
    audit: 'Audit Log'
  };

  /**
   * Row backend backed by the live workbook. Same interface the tests run
   * against (getRows / appendRow / updateRows). updateRows writes only
   * patch keys that exist in the sheet header and warns about the rest —
   * e.g. ApprovedAt needs a column added to Time Log (see README).
   */
  function AppsScriptData(tabs) {
    this.tabs = tabs || LOGICAL_TABS;
  }

  AppsScriptData.prototype.sheet = function (logical) {
    return SpreadsheetApp.getActive().getSheetByName(this.tabs[logical]);
  };

  AppsScriptData.prototype.getRows = function (logical) {
    var values = this.sheet(logical).getDataRange().getValues();
    var headers = values[0] || [];
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      if (values[i].join('') === '') continue;
      var row = {};
      for (var c = 0; c < headers.length; c++) {
        row[headers[c]] = values[i][c];
      }
      rows.push(row);
    }
    return rows;
  };

  AppsScriptData.prototype.appendRow = function (logical, row) {
    var sh = this.sheet(logical);
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.appendRow(headers.map(function (h) {
      return row[h] == null ? '' : row[h];
    }));
    return row;
  };

  AppsScriptData.prototype.updateRows = function (logical, matchFn, patch) {
    var sh = this.sheet(logical);
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var values = sh.getDataRange().getValues();
    var updated = 0;
    var dropped = {};
    for (var i = 1; i < values.length; i++) {
      if (values[i].join('') === '') continue;
      var row = {};
      for (var c = 0; c < headers.length; c++) {
        row[headers[c]] = values[i][c];
      }
      if (!matchFn(row)) continue;
      for (var h = 0; h < headers.length; h++) {
        var header = headers[h];
        if (Object.prototype.hasOwnProperty.call(patch, header)) {
          values[i][h] = patch[header];
        }
      }
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key) &&
            headers.indexOf(key) === -1) {
          dropped[key] = true;
        }
      }
      updated++;
    }
    if (updated) {
      sh.getRange(1, 1, values.length, headers.length).setValues(values);
    }
    for (var d in dropped) {
      if (Object.prototype.hasOwnProperty.call(dropped, d)) {
        // Never silently swallow a field the schema can't hold yet.
        console.warn('SecurityEdge: no column for "' + d + '" on sheet "' +
          this.tabs[logical] + '" — add it to keep the audit trail complete.');
      }
    }
    return updated;
  };

  function json_(obj) {
    return ContentService
      .createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  /** Session-bound deps for the Rbac gate: Google SSO identity + Users rows. */
  function sessionDeps() {
    var data = new AppsScriptData();
    return {
      resolveEmail: function () {
        return Session.getActiveUser().getEmail();
      },
      loadUsers: function () {
        return data.getRows('users');
      }
    };
  }

  /** Fresh deps + repos per request — no shared mutable state across calls. */
  function buildRepos() {
    var data = new AppsScriptData();
    var deps = {
      data: data,
      audit: AuditLog.createWriter(data, function () { return new Date(); }),
      rbac: Rbac,
      buildLineItem: LineItems.buildLineItem,
      computeLineTotal: RateCatalog.computeLineTotal,
      newId: function () { return Utilities.getUuid(); },
      clock: function () { return new Date(); }
    };
    return {
      data: data,
      shifts: ShiftRepo.create(deps),
      lines: LineItemRepo.create(deps),
      catalog: CatalogAdmin.create(deps)
    };
  }

  /** Wrap a handler: session gate → repos → JSON. Denied sessions and
   *  denied mutations both come back as {ok:false, error} — the client
   *  never sees which. */
  function handle(handlerFn) {
    return function (payload) {
      var outcome = Rbac.withAuth(sessionDeps(), function (ctx, cleanPayload) {
        var repos = buildRepos();
        return handlerFn(ctx, cleanPayload, repos);
      })(payload || {});
      return json_(outcome);
    };
  }

  var api = {
    saveShift: handle(function (ctx, p, repos) {
      return repos.shifts.insert(ctx, p);
    }),
    submitShift: handle(function (ctx, p, repos) {
      return repos.shifts.submit(ctx, p.shiftId);
    }),
    approveShift: handle(function (ctx, p, repos) {
      // e.parameter values arrive as strings — JSON payloads included.
      var frozen = typeof p.frozen === 'string' ? JSON.parse(p.frozen) : (p.frozen || {});
      return repos.shifts.approve(ctx, p.shiftId, frozen, p.orgScope);
    }),
    rejectShift: handle(function (ctx, p, repos) {
      return repos.shifts.reject(ctx, p.shiftId, p.reason, p.orgScope);
    }),
    listShifts: handle(function (ctx, p, repos) {
      return { ok: true, shifts: repos.shifts.findVisible(ctx, p.orgScope) };
    }),
    saveLineItem: handle(function (ctx, p, repos) {
      return repos.lines.save(ctx, p);
    }),
    updateLineItem: handle(function (ctx, p, repos) {
      var patch = typeof p.patch === 'string' ? JSON.parse(p.patch) : (p.patch || {});
      return repos.lines.update(ctx, p.lineId, patch);
    }),
    changeRate: handle(function (ctx, p, repos) {
      return repos.catalog.changeRate(ctx, p.serviceId, p.rate, p.orgScope);
    }),
    listAudit: handle(function (ctx, p, repos) {
      return { ok: true, entries: AuditLog.listForOrg(repos.data, ctx, p) };
    })
  };

  /** Web-app entry: e.parameter.action selects the handler. */
  function doPost(e) {
    var params = (e && e.parameter) || {};
    var fn = api[params.action];
    if (!fn) {
      return json_({ ok: false, error: 'UNKNOWN_ACTION' });
    }
    return fn(params);
  }

  function doGet() {
    return json_({ ok: true, service: 'security-layer', actions: Object.keys(api) });
  }

  return {
    LOGICAL_TABS: LOGICAL_TABS,
    AppsScriptData: AppsScriptData,
    api: api,
    doPost: doPost,
    doGet: doGet
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SecurityEdge;
}

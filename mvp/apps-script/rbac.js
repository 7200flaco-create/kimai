/**
 * RBAC — role and capability checks for the four spec roles (spec
 * art_SHLLdADT, "Permission matrix"). Google Apps Script / Node shared
 * module. Pure: no I/O, no globals beyond the module itself.
 *
 * The matrix is DATA — capability → roles allowed — so a role below the
 * matrix can never reach a mutating code path, and adding a role is a
 * one-line change, not a grep for ifs.
 *
 * Injection note: withAuth takes its collaborators (identity source, user
 * rows) via a deps object, so the identical gate runs under Google SSO
 * (wired in security-edge.js) and under node tests. No free-variable
 * cross-references: this file loads and tests standalone.
 */
var Rbac = (function () {
  'use strict';

  var ROLES = ['platform_admin', 'admin', 'manager', 'technician'];

  // Spec permission matrix, verbatim:
  //  - clock in/out + submit shifts ........ technician (own only) and up
  //  - log work performed (line items) ...... technician (create, own only) and up
  //  - view shift history ................... technician own rows; manager+ org rows
  //  - approve / reject shifts .............. manager and up
  //  - generate invoices / export ........... manager and up
  //  - edit rate card & org settings ........ admin and up (manager read-only)
  //  - create users / assign roles .......... admin (own org, never
  //                                           platform_admin) and platform admin
  //  - see other organizations .............. platform admin only
  var CAPABILITIES = {
    logTime:          ['technician', 'manager', 'admin', 'platform_admin'],
    logWork:          ['technician', 'manager', 'admin', 'platform_admin'],
    viewOwnShifts:    ['technician', 'manager', 'admin', 'platform_admin'],
    viewAllOrgShifts: ['manager', 'admin', 'platform_admin'],
    approveShifts:    ['manager', 'admin', 'platform_admin'],
    generateInvoices: ['manager', 'admin', 'platform_admin'],
    editRateCard:     ['admin', 'platform_admin'],
    editOrgSettings:  ['admin', 'platform_admin'],
    manageUsers:      ['admin', 'platform_admin'],
    seeAllOrgs:       ['platform_admin']
  };

  function isKnownRole(role) {
    return ROLES.indexOf(role) !== -1;
  }

  /** True when ctx's role holds the capability. Unknown capability throws —
   *  a typo in a capability name must be loud, never a silent deny. */
  function can(ctx, capability) {
    var allowed = CAPABILITIES[capability];
    if (!allowed) {
      throw new Error('UNKNOWN_CAPABILITY: ' + capability);
    }
    if (!ctx || !isKnownRole(ctx.role)) {
      return false; // no session context → no capability (fail closed)
    }
    return allowed.indexOf(ctx.role) !== -1;
  }

  /**
   * Result-style check — {ok:true} or {ok:false, error:'DENIED'}. Repos use
   * this so denial is a value they can audit, not an exception to catch.
   */
  function check(ctx, capability) {
    if (can(ctx, capability)) {
      return { ok: true };
    }
    return { ok: false, error: 'DENIED', capability: capability };
  }

  /**
   * Session gate (spec Layer 1). deps: {
   *   resolveEmail(): string        — identity source (Google SSO in the
   *                                   deployment, a test stub under node)
   *   loadUsers(): rows[]           — Users tab rows, sheet-shaped
   * }
   *
   * Every request resolves to exactly one organization: unknown or inactive
   * email → ACCESS_DENIED (fail closed); a tenant role with a blank OrgID
   * (corrupt row) → ACCESS_DENIED. Client-supplied orgId / userId are
   * stripped from the payload — the org comes from the session, never the
   * request (spec: "No handler ever trusts a client-supplied orgId").
   */
  function withAuth(deps, handler) {
    return function (payload) {
      var email = String(deps.resolveEmail() || '').toLowerCase();
      var rows = deps.loadUsers() || [];
      var user = null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].Email).toLowerCase() === email &&
            String(rows[i].IsActive).toUpperCase() === 'TRUE') {
          user = rows[i];
          break;
        }
      }
      if (!user || (user.Role !== 'platform_admin' && !user.OrgID)) {
        // Session-level denials carry no org, so the tenant audit log
        // (whose rows are org-scoped) cannot attribute them — the gate
        // response itself is the record.
        return { ok: false, error: 'ACCESS_DENIED' };
      }
      var ctx = {
        userId: user.UserID,
        orgId: user.OrgID || null,
        role: user.Role,
        email: email
      };
      payload = payload || {};
      delete payload.orgId;   // defense in depth (spec Layer 1)
      delete payload.userId;
      return handler(ctx, payload);
    };
  }

  return {
    ROLES: ROLES,
    CAPABILITIES: CAPABILITIES,
    can: can,
    check: check,
    withAuth: withAuth
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Rbac;
}

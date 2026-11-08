/**
 * Invoice edge layer — the ONLY invoice file that touches SpreadsheetApp,
 * Session, or Utilities. Pure logic lives in invoice-gen.js. Deploy order
 * in the Apps Script project: rate-catalog.js, invoice-gen.js, then this
 * file (the globals below reference those, plus SESSION from sheet-gate.js).
 *
 * Same boundary rules as sheet-gate.js: handlers funnel through withAuth,
 * the org comes from the session (never the payload), and every mutation
 * writes exactly one audit row in the same logical step.
 */

var SheetInvoiceRepo = (function () {
  'use strict';

  function readAll() {
    return readSheet_('Invoices');
  }

  /** Header row follows the Invoices sheet column order. */
  function insert(invoice) {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Invoices');
    sheet.appendRow([
      invoice.invoiceNumber, invoice.orgId, invoice.periodStart,
      invoice.periodEnd, invoice.weekNumber, invoice.billableHours,
      invoice.hourlyPayout, invoice.adjustment, invoice.adjustmentNote,
      invoice.grossPayout, invoice.status, invoice.issuedAt || ''
    ]);
    return invoice;
  }

  return { readAll: readAll, insert: insert };
})();

/** Stamps InvoiceID on the picked Work Performed rows — the materialization. */
function stampLines_(lineIds, invoiceNumber) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Work Performed');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('LineID');
  var invCol = headers.indexOf('InvoiceID');
  var stamped = [];
  for (var r = 1; r < values.length; r++) {
    if (lineIds.indexOf(values[r][idCol]) !== -1) {
      sheet.getRange(r + 1, invCol + 1).setValue(invoiceNumber);
      stamped.push(values[r][idCol]);
    }
  }
  return stamped;
}

/** Advances the org's InvoiceSeq so the next generation starts past this one. */
function advanceInvoiceSeq_(orgId, nextSeq) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Organizations');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var orgCol = headers.indexOf('OrgID');
  var seqCol = headers.indexOf('InvoiceSeq');
  for (var r = 1; r < values.length; r++) {
    if (values[r][orgCol] === orgId) {
      sheet.getRange(r + 1, seqCol + 1).setValue(nextSeq);
      return;
    }
  }
}

/**
 * Web-app generation handler. Flow per spec: guard → commit (stamp lines,
 * append header, advance seq, audit) → draft. Manager+ roles, own org only.
 */
var generateWeeklyInvoice = SESSION.withAuth(function (ctx, payload) {
  var result = InvoiceGen.generateWeeklyInvoice(ctx, payload.periodStart, payload.periodEnd, {
    org: readOrgRow_(ctx.orgId),
    timeLogRows: readSheet_('Time Log'),
    lineRows: readSheet_('Work Performed'),
    existingInvoices: SheetInvoiceRepo.readAll(),
    adjustment: payload.adjustment,
    adjustmentNote: payload.adjustmentNote
  });
  if (!result.ok) {
    SheetAuditLog.write(ctx, 'invoice', payload.periodStart + '..' + payload.periodEnd,
      'generate_rejected', null, { error: result.error, blocking: result.blocking || null });
    return result;
  }
  stampLines_(result.invoiceLines.map(function (l) { return l.lineId; }), result.invoice.invoiceNumber);
  SheetInvoiceRepo.insert(result.invoice);
  advanceInvoiceSeq_(ctx.orgId, result.nextInvoiceSeq);
  SheetAuditLog.write(ctx, 'invoice', result.invoice.invoiceNumber, 'create', null, result.invoice);
  return result;
});

/** Void handler: status → void, lines released to invoiceId = null. */
var voidInvoice = SESSION.withAuth(function (ctx, payload) {
  var invoices = SheetInvoiceRepo.readAll();
  var header = null;
  invoices.forEach(function (inv) {
    if (inv.InvoiceNumber === payload.invoiceNumber && inv.OrgID === ctx.orgId) header = inv;
  });
  if (!header) {
    // Scoped lookup: a foreign invoice number and an unknown one are the
    // same not-found — no error text confirms another org's invoice exists.
    return { ok: false, error: 'INVOICE_NOT_FOUND' };
  }
  var lines = readSheet_('Work Performed').filter(function (l) {
    return l.InvoiceID === payload.invoiceNumber;
  });
  var result = InvoiceGen.voidInvoice(toInvoice_(header), toLines_(lines));
  if (!result.ok) {
    SheetAuditLog.write(ctx, 'invoice', payload.invoiceNumber, 'void_rejected', null, { error: result.error });
    return result;
  }
  stampLines_(result.releasedLineIds, ''); // release: invoiceId back to empty
  updateInvoiceStatus_(payload.invoiceNumber, 'void');
  SheetAuditLog.write(ctx, 'invoice', payload.invoiceNumber, 'void', header, result.invoice);
  return result;
});

function readOrgRow_(orgId) {
  var rows = readSheet_('Organizations');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].OrgID === orgId) return rows[i];
  }
  throw new Error('ORG_NOT_FOUND');
}

function toInvoice_(row) {
  return {
    invoiceNumber: row.InvoiceNumber, orgId: row.OrgID,
    periodStart: row.PeriodStart, periodEnd: row.PeriodEnd,
    grossPayout: Number(row.GrossPayout), status: String(row.Status).toLowerCase()
  };
}

function toLines_(rows) {
  return rows.map(function (l) { return { lineId: l.LineID }; });
}

function updateInvoiceStatus_(invoiceNumber, status) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Invoices');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var numCol = headers.indexOf('InvoiceNumber');
  var statusCol = headers.indexOf('Status');
  for (var r = 1; r < values.length; r++) {
    if (values[r][numCol] === invoiceNumber) {
      sheet.getRange(r + 1, statusCol + 1).setValue(status);
      return;
    }
  }
}

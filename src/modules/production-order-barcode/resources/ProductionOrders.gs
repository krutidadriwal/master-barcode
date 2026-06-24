/**
 * ProductionOrders.gs
 * Master Barcode Google Sheets Project
 *
 * Serves data from the "Production Orders API" sheet via a JSON web app endpoint.
 * Also syncs data directly to Supabase on a twice-daily schedule.
 *
 * SETUP:
 *   1. In the Apps Script editor, open Project Settings → Script Properties and add:
 *        SUPABASE_URL         = https://<your-project>.supabase.co
 *        SUPABASE_SERVICE_KEY = <your service_role key>
 *   2. Run PO_setupTriggers() once from the editor to create the scheduled sync.
 *   3. Deploy as a Web App (Execute as: Me, Access: Anyone) and copy the URL into
 *      MASTER_BARCODE_SCRIPTS_URL in your .env file.
 *
 * MULTIPLE SCRIPTS NOTE:
 *   All functions use the PO_ prefix to avoid conflicts with other scripts in this project.
 *   If there is already a doGet(e) in another file, remove the doGet below and instead
 *   add this line inside your existing doGet's switch/if block:
 *       if (e.parameter.request === 'production_orders') return PO_handleGetRequest(e);
 */

var PO_SHEET_NAME = 'Production Orders API';

// ─────────────────────────────────────────────────────────────────────────────
// DATA READING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads all rows from the "Production Orders API" sheet and returns raw objects
 * keyed by header name.
 */
function PO_getProductionOrdersData() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PO_SHEET_NAME);

  if (!sheet) {
    throw new Error('[PO] Sheet not found: ' + PO_SHEET_NAME);
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows    = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];

    // Skip entirely blank rows (check Reference Code and SKU columns)
    var refCode = String(row[headers.indexOf('Reference Code')] || '').trim();
    var sku     = String(row[headers.indexOf('Suborders SKU')]  || '').trim();
    if (!refCode && !sku) continue;

    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = (row[j] !== undefined && row[j] !== null) ? row[j] : '';
    }
    rows.push(obj);
  }

  return rows;
}

/**
 * Maps a raw sheet row object to a production_order_barcode-compatible record.
 * Derived columns:
 *   reference_code_short = last 5 characters of reference_code_original
 *   import_date          = date portion of the Import Date timestamp
 */
function PO_normalizeRow(raw) {
  var refCode = String(raw['Reference Code'] || '').trim();
  var sku     = String(raw['Suborders SKU']  || '').trim();
  if (!refCode || !sku) return null;

  // Parse import date: handles Date objects and "2026-06-19 14:55:38" strings
  var importDate = '';
  var importDateRaw = raw['Import Date'];
  if (importDateRaw instanceof Date) {
    importDate = Utilities.formatDate(
      importDateRaw, Session.getScriptTimeZone(), 'yyyy-MM-dd'
    );
  } else if (importDateRaw) {
    var s = String(importDateRaw).trim();
    importDate = s.length >= 10 ? s.substring(0, 10) : s;
  }

  return {
    reference_code_original: refCode,
    reference_code_short:    refCode.slice(-5),
    import_date:             importDate || null,
    order_quantity:          PO_toInt(raw['Order Qty']),
    item_status:             String(raw['Item Status'] || '').trim(),
    suborder_quantity:       PO_toInt(raw['Suborder Qty']),
    item_quantity:           PO_toInt(raw['Suborder Item Qty']),
    returned_quantity:       PO_toInt(raw['Suborder Returned Qty']),
    cancelled_quantity:      PO_toInt(raw['Suborder Cancelled Qty']),
    shipped_quantity:        PO_toInt(raw['Suborders Shipped Qty']),
    sku:                     sku,
    sub_product_count:       PO_toInt(raw['Suborders Sub Product Count']),
    product_name:            String(raw['Itemname']  || '').trim(),
    brand:                   String(raw['Brand']     || '').trim(),
    model_no:                String(raw['Model no']  || '').trim(),
    ean:                     String(raw['EAN']       || '').trim(),
    size:                    String(raw['Size']      || '').trim()
    // 'Actual DOC' column is informational only and not stored in the database
  };
}

function PO_toInt(val) {
  var n = parseInt(String(val || 0), 10);
  return isNaN(n) ? 0 : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB APP (doGet)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles GET requests routed to production orders.
 *
 * Usage:  <web-app-url>?request=production_orders
 *
 * Response: { success: true, count: N, rows: [...] }
 */
function PO_handleGetRequest(e) {
  var request = (e && e.parameter) ? e.parameter.request : null;

  if (request !== 'production_orders') {
    return ContentService
      .createTextOutput(JSON.stringify({
        error: 'Unknown request. Use ?request=production_orders'
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var raw  = PO_getProductionOrdersData();
    var rows = raw.map(PO_normalizeRow).filter(function(r) { return r !== null; });
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, count: rows.length, rows: rows }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('[PO] doGet error: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Entry point for the deployed Web App.
 *
 * If another script in this project already defines doGet(e), remove this
 * function and add the following line inside the existing doGet switch block:
 *
 *   if (e.parameter.request === 'production_orders') return PO_handleGetRequest(e);
 */
function doGet(e) {
  return PO_handleGetRequest(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT SUPABASE SYNC (scheduled)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Syncs all production order rows directly to the Supabase table.
 * Called automatically by the twice-daily time trigger (see PO_setupTriggers).
 *
 * Requires Script Properties (Extensions → Apps Script → Project Settings):
 *   SUPABASE_URL         — e.g. https://xyzxyz.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role secret key (not anon key)
 */
function PO_syncToSupabase() {
  var props       = PropertiesService.getScriptProperties();
  var supabaseUrl = props.getProperty('SUPABASE_URL');
  var serviceKey  = props.getProperty('SUPABASE_SERVICE_KEY');

  if (!supabaseUrl || !serviceKey) {
    Logger.log('[PO Sync] ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in Script Properties.');
    return;
  }

  var raw  = PO_getProductionOrdersData();
  var rows = raw.map(PO_normalizeRow).filter(function(r) { return r !== null; });

  if (!rows.length) {
    Logger.log('[PO Sync] No rows found in sheet. Nothing to sync.');
    return;
  }

  Logger.log('[PO Sync] Starting sync of ' + rows.length + ' rows to Supabase.');

  var BATCH_SIZE = 100;
  var upserted   = 0;
  var failed     = 0;
  var endpoint   = supabaseUrl.replace(/\/$/, '') + '/rest/v1/production_order_barcode';

  for (var i = 0; i < rows.length; i += BATCH_SIZE) {
    var batch = rows.slice(i, i + BATCH_SIZE);
    try {
      var response = UrlFetchApp.fetch(endpoint, {
        method:             'POST',
        muteHttpExceptions: true,
        headers: {
          'apikey':        serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
          'Content-Type':  'application/json',
          // merge-duplicates = upsert on the unique constraint (reference_code_original, sku)
          'Prefer':        'resolution=merge-duplicates,return=minimal'
        },
        payload: JSON.stringify(batch)
      });

      var code = response.getResponseCode();
      if (code === 200 || code === 201 || code === 204) {
        upserted += batch.length;
        Logger.log('[PO Sync] Batch ' + Math.floor(i / BATCH_SIZE + 1) + ': ' + batch.length + ' rows upserted (HTTP ' + code + ')');
      } else {
        failed += batch.length;
        Logger.log('[PO Sync] Batch ' + Math.floor(i / BATCH_SIZE + 1) + ' error (HTTP ' + code + '): ' + response.getContentText());
      }
    } catch (err) {
      failed += batch.length;
      Logger.log('[PO Sync] Batch exception: ' + err.message);
    }
  }

  Logger.log('[PO Sync] Done. Upserted: ' + upserted + ', Failed: ' + failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER SETUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates two daily time-based triggers for PO_syncToSupabase:
 *   - 06:00 AM  (script timezone)
 *   - 06:00 PM  (script timezone)
 *
 * Run this function ONCE from the Apps Script editor (Run → Run function → PO_setupTriggers).
 * It first removes any existing PO sync triggers to avoid duplicates.
 */
function PO_setupTriggers() {
  // Remove existing PO sync triggers
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'PO_syncToSupabase') {
      ScriptApp.deleteTrigger(existing[i]);
      Logger.log('[PO Triggers] Removed old trigger.');
    }
  }

  // 06:00 AM daily
  ScriptApp.newTrigger('PO_syncToSupabase')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  // 06:00 PM daily
  ScriptApp.newTrigger('PO_syncToSupabase')
    .timeBased()
    .everyDays(1)
    .atHour(18)
    .create();

  Logger.log('[PO Triggers] Created: 6 AM and 6 PM daily sync triggers.');
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL SYNC MENU (optional UI helper)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds a "Production Orders" menu to the Sheets UI so the user can trigger a
 * sync without opening the Apps Script editor.
 *
 * Wire this to an onOpen trigger or call it from an existing onOpen function:
 *   function onOpen() { PO_addMenu(); }
 */
function PO_addMenu() {
  SpreadsheetApp.getUi()
    .createMenu('Production Orders')
    .addItem('Sync to Supabase now', 'PO_syncToSupabase')
    .addItem('Set up daily triggers',  'PO_setupTriggers')
    .addToUi();
}

/**
 * onOpen trigger — builds all custom menus when the spreadsheet opens.
 * Merged from the existing onOpen in other scripts (delete onOpen from those files).
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('Custom Tools')
    .addItem('Update EE Master Data', 'fetch_ee_product_master')
    .addItem('Update EE Production Order Data', 'get_b2b_orders_data')
    .addSeparator()
    .addSubMenu(ui.createMenu('More Tools')
      .addItem('Update Barcode Labels Links', 'lookupBarcode_labels')
      .addItem('Update Barcode Links', 'lookupBarcodes'))
    .addToUi();

  PO_addMenu();
}

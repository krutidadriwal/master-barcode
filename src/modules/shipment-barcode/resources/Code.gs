/**
 * Google Apps Script - Code.gs
 * Reads the single "EE Purchase Orders" sheet and returns
 * { headers: [...], lines: [...] } for the Shipment Barcode app to upsert into Supabase.
 *
 * Instructions:
 * 1. Open the "EE Purchase Orders" Google Sheet.
 * 2. Click Extensions > Apps Script.
 * 3. Replace any existing code in Code.gs with this script.
 * 4. Click Save.
 * 5. Click Deploy > New Deployment > Web App.
 * 6. Set "Who has access" to "Anyone".
 * 7. Click Deploy, authorize, and copy the Web App URL.
 * 8. Set PO_SCRIPTS_URL=<that URL> in your .env file.
 *
 * Sheet: "EE Purchase Orders" (one row per line item; PO header columns repeat per row)
 *   PO-level  : po_id | po_ref_num | vendor_name | vendor_code |
 *               po_status_id | total_po_value | po_created_date | po_updated_date
 *   Line-level : sku | original_quantity | pending_quantity | item_price
 *               (also accepts: ordered_qty for original_quantity,
 *                              pending_qty / fulfilled_qty for pending_quantity,
 *                              unit_price / price for item_price)
 */

function findCol(headers, candidates) {
  for (var c = 0; c < candidates.length; c++) {
    var idx = headers.indexOf(candidates[c].toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function doGet(e) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("EE Purchase Orders");

    if (!sheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: true, message: 'Sheet "EE Purchase Orders" not found.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return ContentService
        .createTextOutput(JSON.stringify({ headers: [], lines: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var h = data[0].map(function(col) { return col.toString().trim().toLowerCase(); });

    // PO header columns
    var poIdIdx       = findCol(h, ["po id",           "po_id"]);
    var poRefIdx      = findCol(h, ["po ref num",      "po_ref_num",   "po_ref", "ref_num", "reference_number"]);
    var vendorNameIdx = findCol(h, ["vendor name",     "vendor_name",  "supplier_name", "vendor"]);
    var vendorCodeIdx = findCol(h, ["vendor code",     "vendor_code",  "supplier_code"]);
    var statusIdx     = findCol(h, ["po status id",    "po_status_id", "status_id", "po_status", "status"]);
    var totalValIdx   = findCol(h, ["total po value",  "total_po_value", "total_value", "po_value"]);
    var createdIdx    = findCol(h, ["po created date", "po_created_date", "created_date", "date_created"]);
    var updatedIdx    = findCol(h, ["po updated date", "po_updated_date", "updated_date", "date_updated"]);

    // Line item columns
    var skuIdx        = findCol(h, ["sku"]);
    var origQtyIdx    = findCol(h, ["original quantity",  "original_quantity", "ordered_qty", "ordered_quantity", "quantity"]);
    var pendingQtyIdx = findCol(h, ["pending quantity",   "pending_quantity",  "pending_qty", "fulfilled_qty", "fulfillment_qty"]);
    var itemPriceIdx  = findCol(h, ["item price",         "item_price",        "unit_price",  "price"]);

    if (skuIdx === -1) skuIdx = 0;

    var headersMap = {}; // po_ref_num → header object (dedup)
    var linesList  = [];

    for (var i = 1; i < data.length; i++) {
      var row = data[i];

      var poId     = poIdIdx  !== -1 ? (row[poIdIdx]  || "").toString().trim() : "";
      var poRefNum = poRefIdx !== -1 ? (row[poRefIdx] || "").toString().trim() : "";

      if (!poRefNum) poRefNum = poId;
      if (!poId)     poId     = poRefNum;
      if (!poRefNum) continue; // can't associate row without PO identifier

      // Collect header (first occurrence wins for shared fields)
      if (!headersMap[poRefNum]) {
        headersMap[poRefNum] = {
          po_id:           poId,
          po_ref_num:      poRefNum,
          vendor_name:     vendorNameIdx !== -1 ? (row[vendorNameIdx] || "").toString().trim() || null : null,
          vendor_code:     vendorCodeIdx !== -1 ? (row[vendorCodeIdx] || "").toString().trim() || null : null,
          po_status_id:    statusIdx     !== -1 ? (row[statusIdx]     || "").toString().trim() || null : null,
          total_po_value:  totalValIdx   !== -1 ? (parseFloat(row[totalValIdx])  || null)             : null,
          po_created_date: createdIdx    !== -1 ? (row[createdIdx]    || "").toString().trim() || null : null,
          po_updated_date: updatedIdx    !== -1 ? (row[updatedIdx]    || "").toString().trim() || null : null,
        };
      }

      // Collect line
      var sku = (row[skuIdx] || "").toString().trim();
      if (!sku) continue;

      linesList.push({
        po_ref_num:        poRefNum,
        po_id:             poId || null,
        sku:               sku,
        original_quantity: origQtyIdx    !== -1 ? (parseInt(row[origQtyIdx],    10) || 0)   : 0,
        pending_quantity:  pendingQtyIdx !== -1 ? (parseInt(row[pendingQtyIdx], 10) || 0)   : 0,
        item_price:        itemPriceIdx  !== -1 ? (parseFloat(row[itemPriceIdx])    || null) : null,
      });
    }

    var headersList = Object.keys(headersMap).map(function(k) { return headersMap[k]; });

    return ContentService
      .createTextOutput(JSON.stringify({ headers: headersList, lines: linesList }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: true, message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

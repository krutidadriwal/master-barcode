/**
 * Google Apps Script - Code.gs
 * Joins Purchase_Orders and Purchase_Order_Lines sheets to expose shipment data
 * with planned_mode (AIR or SEA) per line item.
 *
 * Instructions:
 * 1. Open your Google Sheet containing both 'Purchase_Orders' and 'Purchase_Order_Lines' sheets.
 * 2. Click Extensions > Apps Script.
 * 3. Replace any code block in Code.gs with this script.
 * 4. Hit Save.
 * 5. Click Deploy > New Deployment.
 * 6. Under 'Select type', click Web App.
 * 7. Change 'Who has access' to 'Anyone'.
 * 8. Click Deploy, authorize permissions, and copy the Web App URL.
 * 9. Paste this URL into the 'Google Apps Script Deployment URL' field in your Shipment Barcode Module.
 *
 * Required sheet columns:
 *   Purchase_Orders     : po_id | planned_mode (AIR or SEA) | ...
 *   Purchase_Order_Lines: po_id | sku | sku_name | ordered_qty | fulfilled_qty | ...
 */

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Build po_id → planned_mode lookup from Purchase_Orders sheet
    var poMap = {};
    var poSheet = ss.getSheetByName("Purchase_Orders");
    if (poSheet) {
      var poData = poSheet.getDataRange().getValues();
      if (poData.length > 1) {
        var poHeaders = poData[0].map(function(h) { return h.toString().trim().toLowerCase(); });
        var poIdIdx = poHeaders.indexOf("po_id");
        var modeIdx = poHeaders.indexOf("planned_mode");
        if (poIdIdx === -1) poIdIdx = 0;
        if (modeIdx === -1) modeIdx = 1;
        for (var p = 1; p < poData.length; p++) {
          var poRow = poData[p];
          var poId = (poRow[poIdIdx] || "").toString().trim();
          var mode = (poRow[modeIdx] || "").toString().trim().toUpperCase();
          if (poId) {
            poMap[poId] = (mode === "SEA") ? "SEA" : "AIR";
          }
        }
      }
    }

    // Read Purchase_Order_Lines sheet
    var sheet = ss.getSheetByName("Purchase_Order_Lines");
    if (!sheet) {
      var sheets = ss.getSheets();
      for (var s = 0; s < sheets.length; s++) {
        var n = sheets[s].getName().toLowerCase();
        if (n.indexOf("purchase") !== -1 || n.indexOf("order") !== -1) {
          sheet = sheets[s];
          break;
        }
      }
    }
    if (!sheet) {
      sheet = ss.getSheets()[0];
    }

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify([]))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var headers = data[0].map(function(h) { return h.toString().trim().toLowerCase(); });

    var skuIdx      = headers.indexOf("sku");
    var nameIdx     = headers.indexOf("sku_name") !== -1 ? headers.indexOf("sku_name") : headers.indexOf("item_name");
    var orderedIdx  = headers.indexOf("ordered_qty") !== -1 ? headers.indexOf("ordered_qty") : headers.indexOf("quantity");
    var fulfilledIdx = headers.indexOf("fulfilled_qty");
    var poIdLineIdx = headers.indexOf("po_id");

    if (skuIdx === -1) skuIdx = 0;
    if (nameIdx === -1) nameIdx = 1;
    if (orderedIdx === -1) orderedIdx = 2;

    var resultList = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var skuValue = (row[skuIdx] || "").toString().trim();
      if (!skuValue) continue;

      var nameValue    = nameIdx !== -1 ? (row[nameIdx] || "").toString().trim() : "Product SKU " + skuValue;
      var orderedVal   = parseInt(row[orderedIdx], 10) || 0;
      var fulfilledVal = fulfilledIdx !== -1 ? (parseInt(row[fulfilledIdx], 10) || 0) : 0;

      var poId        = poIdLineIdx !== -1 ? (row[poIdLineIdx] || "").toString().trim() : "";
      var plannedMode = (poId && poMap[poId]) ? poMap[poId] : "AIR";

      resultList.push({
        sku:          skuValue,
        sku_name:     nameValue,
        ordered_qty:  orderedVal,
        fulfilled_qty: fulfilledVal,
        planned_mode: plannedMode
      });
    }

    return ContentService.createTextOutput(JSON.stringify(resultList))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      error: true,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

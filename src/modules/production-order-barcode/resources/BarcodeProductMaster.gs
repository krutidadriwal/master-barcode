/**
 * BarcodeProductMaster.gs
 *
 * Returns all rows from the "EE Product Master" sheet as a JSON array,
 * ready to be synced into the local `barcode_product_master` Supabase table
 * by the Barcode Tool backend (/api/barcode/sync-barcode-master).
 *
 * Entry point — add this case to the existing doGet switch in Inventory_Forecasting.gs:
 *
 *   case 'barcodeProductMaster':
 *     return getBarcodeProductMaster(e);
 *
 * The Barcode Tool backend calls:
 *   GET <MASTER_BARCODE_SCRIPTS_URL>?action=barcodeProductMaster
 */

var BARCODE_MASTER_SHEET_NAME = 'EE Product Master';

/**
 * Read the full EE Product Master sheet and return every row as a JSON
 * object keyed by the canonical column names expected by the backend.
 *
 * Response shape:  { data: [ { "SKU": "...", "Item Name": "...", ... }, ... ] }
 *
 * The backend's syncBarcodeProductMaster() normalises these header names, so the
 * exact casing here must match what is listed in the spec column-mapping table.
 */
function getBarcodeProductMaster(e) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(BARCODE_MASTER_SHEET_NAME);

    if (!sheet) {
      return _bpmErrorResponse('Sheet "' + BARCODE_MASTER_SHEET_NAME + '" not found in this spreadsheet.');
    }

    var values = sheet.getDataRange().getValues();

    if (values.length < 2) {
      return _bpmSuccessResponse([]);
    }

    var headers = values[0].map(function (h) { return String(h).trim(); });

    var rows = [];

    for (var i = 1; i < values.length; i++) {
      var row = values[i];

      // Skip completely blank rows (first cell empty is sufficient guard)
      var sku = _bpmCell(row, headers, 'SKU');
      if (!sku) continue;

      rows.push({
        'Product ID':                        _bpmCell(row, headers, 'Product ID'),
        'SKU':                               sku,
        'Item Name':                         _bpmCell(row, headers, 'Item Name'),
        'Updated At':                        _bpmDateCell(row, headers, 'Updated At'),
        'Inventory':                         _bpmCell(row, headers, 'Inventory'),
        'Product Type':                      _bpmCell(row, headers, 'Product Type'),
        'Brand':                             _bpmCell(row, headers, 'Brand'),
        'Colour':                            _bpmCell(row, headers, 'Colour'),
        'Brand Id':                          _bpmCell(row, headers, 'Brand Id'),
        'MRP':                               _bpmCell(row, headers, 'MRP'),
        'Category Name':                     _bpmCell(row, headers, 'Category Name'),
        'Cost':                              _bpmCell(row, headers, 'Cost'),
        'MRP in EE (changes for event POS)': _bpmCell(row, headers, 'MRP in EE (changes for event POS)'),
        'Model No':                          _bpmCell(row, headers, 'Model No'),
        'EAN/UPC':                           _bpmCell(row, headers, 'EAN/UPC'),
        'Article Number':                    _bpmCell(row, headers, 'Article Number'),
        'Custom EAN':                        _bpmCell(row, headers, 'Custom EAN'),
        'Barcode':                           _bpmCell(row, headers, 'Barcode'),
        'SKU for Barcode':                   _bpmCell(row, headers, 'SKU for Barcode'),
        'MOM':                               _bpmCell(row, headers, 'MOM'),
        'Batch No':                          _bpmCell(row, headers, 'Batch No'),
      });
    }

    return _bpmSuccessResponse(rows);

  } catch (err) {
    Logger.log('[BarcodeProductMaster] Error: ' + err.message);
    return _bpmErrorResponse(err.message || 'Unknown error in getBarcodeProductMaster');
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Read a cell value by column header name, returning '' when missing. */
function _bpmCell(row, headers, colName) {
  var idx = headers.indexOf(colName);
  if (idx === -1) return '';
  var val = row[idx];
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

/**
 * Read a date cell and return an ISO-8601 string, or '' when the cell is empty.
 * Apps Script Date objects must be converted explicitly.
 */
function _bpmDateCell(row, headers, colName) {
  var idx = headers.indexOf(colName);
  if (idx === -1) return '';
  var val = row[idx];
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    return val.toISOString();
  }
  return String(val).trim();
}

function _bpmSuccessResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function _bpmErrorResponse(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: message, data: [] }))
    .setMimeType(ContentService.MimeType.JSON);
}

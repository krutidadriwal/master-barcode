/**
 * Google Apps Script - Code.gs
 *
 * Shared utility functions for all scripts in this project.
 * doGet and doPost live in Inventory_Forecasting.gs.
 *
 * Sheet used for PO data: "EE Purchase Orders"
 * Columns (flexible matching):
 *   PO-level  : po_id | po_ref_num | vendor_name | vendor_code |
 *               po_status_id | total_po_value | po_created_date | po_updated_date
 *   Line-level : sku | original_quantity | pending_quantity | item_price
 */

function findCol(headers, candidates) {
  for (var c = 0; c < candidates.length; c++) {
    var idx = headers.indexOf(candidates[c].toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

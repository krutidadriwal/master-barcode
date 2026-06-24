/**
 * PURCHASE & SETTLEMENT ERP — finance.gs
 *
 * doGet and doPost have been merged into Inventory_Forecasting.gs.
 * This file contains all finance helper functions, write routines,
 * and utilities that are called from the shared doPost router.
 *
 * All functions here are globally accessible to all .gs files
 * in this Apps Script project.
 */

// ─────────────────────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────

function successResponse_(d) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', ...d }))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(m) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: m }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// DATA ACCESS HELPERS
// ─────────────────────────────────────────────────────────────

function getSheetData_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const h = data[0];
  return data.slice(1)
    .filter(r => r.some(cell => cell !== "" && cell !== null))
    .map(r => {
      const o = {};
      h.forEach((k, i) => { o[k] = r[i]; });
      return o;
    });
}

function findHeaderIndex_(headers, target) {
  const normalize = (s) => s.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedTarget = normalize(target);
  for (let i = 0; i < headers.length; i++) {
    if (normalize(headers[i]) === normalizedTarget) return i;
  }
  if (normalizedTarget === 'notes') {
    for (let i = 0; i < headers.length; i++) {
      if (normalize(headers[i]) === 'note') return i;
    }
  }
  return -1;
}

function getValue_(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return '';
}

function recordExists_(sheetName, columnName, value) {
  return getSheetData_(sheetName).some(row =>
    String(row[columnName] || '').trim() === String(value).trim()
  );
}

function settlementExists_(paymentId, invoiceId) {
  return getSheetData_('SettlementLedger').some(row =>
    String(row['Payment ID'] || '').trim() === String(paymentId).trim() &&
    String(row['Invoice ID'] || '').trim() === String(invoiceId).trim()
  );
}

function generateTxnId_() {
  return 'TXN-' + Utilities.getUuid();
}

function generateSequentialPayId() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PaymentLogs');
  if (!sheet) return 'PAY-00001';
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return 'PAY-00001';
  const lastId = data[data.length - 1][5];
  if (typeof lastId === 'string' && lastId.startsWith('PAY-')) {
    const num = parseInt(lastId.split('-')[1]) + 1;
    return 'PAY-' + num.toString().padStart(5, '0');
  }
  return 'PAY-00001';
}

function generateSequentialSettlementId() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SettlementLedger');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return 'SET-00001';
  const lastId = data[data.length - 1][1];
  if (typeof lastId === 'string' && lastId.startsWith('SET-')) {
    const num = parseInt(lastId.split('-')[1].replace(/[A-Z]/g, '')) + 1;
    return 'SET-' + num.toString().padStart(5, '0');
  }
  return 'SET-00001';
}

// ─────────────────────────────────────────────────────────────
// DATA INGESTION & SYNC ENGINE
// ─────────────────────────────────────────────────────────────

function syncShipmentsToInvoices_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shipSheet   = ss.getSheetByName('Vendor_Shipments');
  const invSheet    = ss.getSheetByName('PurchaseInvoices');
  const vendorSheet = ss.getSheetByName('VendorAccounts');
  if (!shipSheet || !invSheet || !vendorSheet) return;

  const shipData  = getSheetData_('Vendor_Shipments');
  const invValues = invSheet.getDataRange().getValues();
  const invHeaders = invValues[0];
  const invIdIdx   = findHeaderIndex_(invHeaders, 'Invoice ID');
  const rmbIdx     = findHeaderIndex_(invHeaders, 'RMB');
  const settledIdx = findHeaderIndex_(invHeaders, 'Settled Amount');
  const balanceIdx = findHeaderIndex_(invHeaders, 'Balance');
  const inrIdx     = findHeaderIndex_(invHeaders, 'INR');
  const er1Idx     = findHeaderIndex_(invHeaders, 'ER1');
  const statusIdx  = findHeaderIndex_(invHeaders, 'Status');

  const invIdSet = {};
  if (invIdIdx !== -1) {
    for (let i = 1; i < invValues.length; i++) {
      const id = (invValues[i][invIdIdx] || '').toString().trim().toUpperCase();
      if (id) invIdSet[id] = true;
    }
  }

  const vendorData = getSheetData_('VendorAccounts');
  const existingVendorIds = new Set(
    vendorData.map(v => String(getValue_(v, ['vendor_id', 'Vendor ID', 'Vendor Code', 'VendorCode'])).trim())
  );

  shipData.forEach(ship => {
    const invId = String(getValue_(ship, ['invoiceId', 'Invoice ID', 'InvoiceId'])).trim().toUpperCase();
    if (!invId || invId === 'UNDEFINED' || invId === 'NULL') return;
    if (invIdSet[invId]) return;

    const vCode = String(getValue_(ship, ['VendorCode', 'Vendor Code', 'vendor_code', 'vendorCode'])).trim();
    const rmb   = parseFloat(getValue_(ship, ['RMB'])) || 0;
    const date  = getValue_(ship, ['invoice_date', 'Invoice Date', 'Date']) || new Date().toISOString().split('T')[0];

    if (vCode && !existingVendorIds.has(vCode)) {
      vendorSheet.appendRow([vCode, '', 'RMB', '', '', true]);
      existingVendorIds.add(vCode);
    }

    const rowToAppend = new Array(Math.max(invHeaders.length, 10)).fill('');
    rowToAppend[0] = date;
    if (invIdIdx !== -1) rowToAppend[invIdIdx] = invId;
    const vCodeIdx = findHeaderIndex_(invHeaders, 'Vendor Code');
    if (vCodeIdx  !== -1) rowToAppend[vCodeIdx]  = vCode;
    if (rmbIdx    !== -1) rowToAppend[rmbIdx]    = rmb;
    const notesIdx = findHeaderIndex_(invHeaders, 'Notes');
    if (notesIdx  !== -1) rowToAppend[notesIdx]  = '';
    if (er1Idx    !== -1) rowToAppend[er1Idx]    = '';
    if (inrIdx    !== -1) rowToAppend[inrIdx]    = '';
    if (settledIdx !== -1) rowToAppend[settledIdx] = 0;
    if (balanceIdx !== -1) rowToAppend[balanceIdx] = rmb;
    if (statusIdx !== -1) rowToAppend[statusIdx] = 'Pending EOD';
    else rowToAppend[9] = 'Pending EOD';

    invSheet.appendRow(rowToAppend);
    invIdSet[invId] = true;
    logToVendorLedger_(vCode, date, 'Purchase', invId, -Math.abs(rmb));
  });
}

function getLiveRate_() {
  try {
    const ss       = SpreadsheetApp.getActiveSpreadsheet();
    const sheet    = ss.getSheets()[0];
    const tempCell = sheet.getRange('Z1');
    tempCell.setFormula('=GOOGLEFINANCE("CURRENCY:CNYINR")');
    SpreadsheetApp.flush();
    const liveRate = parseFloat(tempCell.getValue());
    tempCell.clearContent();
    return (!isNaN(liveRate) && liveRate > 0) ? liveRate : 0;
  } catch(e) {
    Logger.log('Error in getLiveRate_: ' + e.toString());
    return 11.5;
  }
}

// ─────────────────────────────────────────────────────────────
// CORE WRITE ROUTINES
// ─────────────────────────────────────────────────────────────

function addPurchaseInvoice(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PurchaseInvoices');
  if (!sheet) return errorResponse_('PurchaseInvoices sheet not found');
  try {
    const record = data.record || data;
    const invId  = (record.invoiceId || '').trim().toUpperCase();
    const vCode  = (record.vendorCode || '').trim();
    const rmb    = parseFloat(record.rmb) || 0;
    const date   = record.date || new Date().toISOString().split('T')[0];

    const dataValues = sheet.getDataRange().getValues();
    const headers    = dataValues[0];
    const idIdx      = findHeaderIndex_(headers, 'Invoice ID');
    const rmbIdx     = findHeaderIndex_(headers, 'RMB');
    const settledIdx = findHeaderIndex_(headers, 'Settled Amount');
    const balanceIdx = findHeaderIndex_(headers, 'Balance');
    const inrIdx     = findHeaderIndex_(headers, 'INR');
    const er1Idx     = findHeaderIndex_(headers, 'ER1');
    const statusIdx  = findHeaderIndex_(headers, 'Status');

    let existingRowIdx = -1;
    if (idIdx !== -1) {
      for (let i = 1; i < dataValues.length; i++) {
        if (dataValues[i][idIdx].toString().trim().toUpperCase() === invId) {
          existingRowIdx = i + 1; break;
        }
      }
    }

    const round2 = v => Math.round(v * 100) / 100;

    if (existingRowIdx === -1) {
      const rowToAppend = new Array(Math.max(headers.length, 10)).fill('');
      rowToAppend[0] = date;
      if (idIdx    !== -1) rowToAppend[idIdx]    = invId;
      const vCodeIdx = findHeaderIndex_(headers, 'Vendor Code');
      if (vCodeIdx !== -1) rowToAppend[vCodeIdx] = vCode;
      if (rmbIdx   !== -1) rowToAppend[rmbIdx]   = round2(rmb);
      const notesIdx = findHeaderIndex_(headers, 'Notes');
      if (notesIdx !== -1) rowToAppend[notesIdx] = record.notes || '';
      if (er1Idx   !== -1) rowToAppend[er1Idx]   = '';
      if (inrIdx   !== -1) rowToAppend[inrIdx]   = '';
      if (settledIdx !== -1) rowToAppend[settledIdx] = 0;
      if (balanceIdx !== -1) rowToAppend[balanceIdx] = round2(rmb);
      if (statusIdx !== -1) rowToAppend[statusIdx] = 'Pending EOD';
      else rowToAppend[9] = 'Pending EOD';
      sheet.appendRow(rowToAppend);
      logToVendorLedger_(vCode, date, 'Purchase', invId, -Math.abs(rmb));
    } else {
      const settled  = parseFloat(dataValues[existingRowIdx - 1][settledIdx]) || 0;
      const vCodeIdx = findHeaderIndex_(headers, 'Vendor Code');
      const notesIdx = findHeaderIndex_(headers, 'Notes');
      sheet.getRange(existingRowIdx, 1).setValue(date);
      if (vCodeIdx  !== -1) sheet.getRange(existingRowIdx, vCodeIdx  + 1).setValue(vCode);
      if (rmbIdx    !== -1) sheet.getRange(existingRowIdx, rmbIdx    + 1).setValue(rmb);
      if (notesIdx  !== -1) sheet.getRange(existingRowIdx, notesIdx  + 1).setValue(record.notes || '');
      if (er1Idx    !== -1) sheet.getRange(existingRowIdx, er1Idx    + 1).setValue('');
      if (inrIdx    !== -1) sheet.getRange(existingRowIdx, inrIdx    + 1).setValue('');
      if (balanceIdx !== -1) sheet.getRange(existingRowIdx, balanceIdx + 1).setValue(rmb - settled);
      if (statusIdx  !== -1) sheet.getRange(existingRowIdx, statusIdx  + 1).setValue('Pending EOD');
    }
    return successResponse_({ message: 'Purchase Invoice upserted successfully', invoiceId: invId });
  } catch (e) {
    return errorResponse_(e.toString());
  }
}

function addVendorAccount(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('VendorAccounts');
  if (!sheet) return errorResponse_('VendorAccounts sheet not found');
  try {
    const record       = data.record || data;
    const vendorId     = (record.vendor_id || record.vendor_code || '').trim();
    const vendorName   = (record.vendor_name || '').trim();
    const currency     = record.currency     || 'USD';
    const country      = record.country      || 'China';
    const paymentTerms = record.payment_terms || 'Net 30';
    const isActive     = record.hasOwnProperty('is_active') ? record.is_active : 'TRUE';

    if (!vendorId)   return errorResponse_('vendor_id cannot be empty');
    if (!vendorName) return errorResponse_('vendor_name cannot be empty');

    const dataValues = sheet.getDataRange().getValues();
    const headers    = dataValues[0];
    const idIdx      = findHeaderIndex_(headers, 'Vendor ID')   !== -1 ? findHeaderIndex_(headers, 'Vendor ID')   : findHeaderIndex_(headers, 'vendor_id');
    const nameIdx    = findHeaderIndex_(headers, 'Vendor Name') !== -1 ? findHeaderIndex_(headers, 'Vendor Name') : findHeaderIndex_(headers, 'vendor_name');
    const currIdx    = findHeaderIndex_(headers, 'Currency')    !== -1 ? findHeaderIndex_(headers, 'Currency')    : findHeaderIndex_(headers, 'currency');
    const countryIdx = findHeaderIndex_(headers, 'Country')     !== -1 ? findHeaderIndex_(headers, 'Country')     : findHeaderIndex_(headers, 'country');
    const termsIdx   = findHeaderIndex_(headers, 'payment_terms') !== -1 ? findHeaderIndex_(headers, 'payment_terms') : findHeaderIndex_(headers, 'Payment Terms');
    const activeIdx  = findHeaderIndex_(headers, 'is_active')   !== -1 ? findHeaderIndex_(headers, 'is_active')   : findHeaderIndex_(headers, 'Is Active');

    const targetIdx = idIdx !== -1 ? idIdx : 0;
    let existingRowIdx = -1;
    for (let i = 1; i < dataValues.length; i++) {
      if (String(dataValues[i][targetIdx]).trim().toLowerCase() === vendorId.toLowerCase()) {
        existingRowIdx = i + 1; break;
      }
    }

    if (existingRowIdx === -1) {
      const rowToAppend = new Array(Math.max(headers.length, 6)).fill('');
      if (idIdx      !== -1) rowToAppend[idIdx]      = vendorId;
      if (nameIdx    !== -1) rowToAppend[nameIdx]    = vendorName;
      if (currIdx    !== -1) rowToAppend[currIdx]    = currency;
      if (countryIdx !== -1) rowToAppend[countryIdx] = country;
      if (termsIdx   !== -1) rowToAppend[termsIdx]   = paymentTerms;
      if (activeIdx  !== -1) rowToAppend[activeIdx]  = isActive;
      sheet.appendRow(rowToAppend);
      return successResponse_({ message: 'Vendor added successfully', vendor_id: vendorId, vendor_name: vendorName });
    } else {
      if (nameIdx !== -1 && !dataValues[existingRowIdx - 1][nameIdx]) {
        sheet.getRange(existingRowIdx, nameIdx + 1).setValue(vendorName);
      }
      return successResponse_({ message: 'Vendor already exists', vendor_id: vendorId, vendor_name: vendorName });
    }
  } catch (e) {
    return errorResponse_(e.toString());
  }
}

function addPaymentLog(data) {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const paymentSheet = ss.getSheetByName('PaymentLogs');
  if (!paymentSheet) return errorResponse_('PaymentLogs sheet not found');
  try {
    const record    = data.record || data;
    const date      = record['Date'] || record.date || record['Payment Date'] || new Date().toISOString().split('T')[0];
    const passedPayId = record['Payment ID'] || record.paymentId || record.PaymentID;
    const payId     = passedPayId ? String(passedPayId).trim() : generateSequentialPayId();
    const vCode     = record['Vendor Code'] || record.vendorCode || record.VendorCode || record['Vendor ID'] || record.vendor_id || '';
    let rmb  = parseFloat(record['RMB Amount'] || record.rmbAmount || record.rmb  || record.RMB  || '0') || 0;
    let er2  = parseFloat(record.ER2 || record.fxRate || record.fx_rate || record.er2 || '0') || 0;
    let inr  = parseFloat(record['INR Amount'] || record.inrAmount || record.inr  || record.INR  || '0') || 0;
    const mode = record['Payment Mode'] || record.paymentMode || record.payment_mode || '';
    const ref  = record['Reference No']  || record.referenceNo  || record.reference_no  || '';

    if (rmb && er2 && !inr)       inr = rmb * er2;
    else if (inr && er2 && !rmb)  rmb = inr / er2;
    else if (rmb && inr && !er2)  er2 = inr / rmb;
    if (rmb && er2) inr = Math.round(rmb * er2 * 100) / 100;

    const balance = parseFloat(record['Balance'] || record.balance || rmb) || rmb;

    if (!payId)   return errorResponse_('Validation Error: Payment ID cannot be blank');
    if (!vCode)   return errorResponse_('Validation Error: Vendor Code cannot be blank');
    if (rmb <= 0) return errorResponse_('Validation Error: Payment amount (RMB) must be greater than 0');
    if (er2 <= 0) return errorResponse_('Validation Error: Exchange rate (ER2) must be greater than 0');
    if (recordExists_('PaymentLogs', 'Payment ID', payId)) return errorResponse_('Duplicate Payment ID detected: ' + payId);

    const headers  = paymentSheet.getDataRange().getValues()[0];
    const dateIdx  = findHeaderIndex_(headers, 'Date');
    const payIdIdx = findHeaderIndex_(headers, 'Payment ID');
    const vCodeIdx = findHeaderIndex_(headers, 'Vendor Code') !== -1 ? findHeaderIndex_(headers, 'Vendor Code') : findHeaderIndex_(headers, 'Vendor ID');
    const rmbIdx   = findHeaderIndex_(headers, 'RMB Amount')  !== -1 ? findHeaderIndex_(headers, 'RMB Amount')  : findHeaderIndex_(headers, 'RMB');
    const er2Idx   = findHeaderIndex_(headers, 'ER2');
    const inrIdx   = findHeaderIndex_(headers, 'INR Amount')  !== -1 ? findHeaderIndex_(headers, 'INR Amount')  : findHeaderIndex_(headers, 'INR');
    const modeIdx  = findHeaderIndex_(headers, 'Payment Mode');
    const refIdx   = findHeaderIndex_(headers, 'Reference No');
    const balIdx   = findHeaderIndex_(headers, 'Balance');

    const round2 = v => Math.round(v * 100) / 100;
    const rowToAppend = new Array(Math.max(headers.length, 9)).fill('');
    if (dateIdx  !== -1) rowToAppend[dateIdx]  = date;
    if (payIdIdx !== -1) rowToAppend[payIdIdx] = payId;
    if (vCodeIdx !== -1) rowToAppend[vCodeIdx] = vCode;
    if (rmbIdx   !== -1) rowToAppend[rmbIdx]   = round2(rmb);
    if (er2Idx   !== -1) rowToAppend[er2Idx]   = er2;
    if (inrIdx   !== -1) rowToAppend[inrIdx]   = round2(inr);
    if (modeIdx  !== -1) rowToAppend[modeIdx]  = mode;
    if (refIdx   !== -1) rowToAppend[refIdx]   = ref;
    if (balIdx   !== -1) rowToAppend[balIdx]   = round2(balance);
    paymentSheet.appendRow(rowToAppend);

    logToVendorLedger_(vCode, date, 'Payment', payId, Math.abs(rmb));

    if (record.isCrossVendor && record.allocations && record.allocations.length > 0) {
      const adjPayId = 'ADJ-' + payId;
      for (const alloc of record.allocations) {
        if (alloc.vendorCode !== vCode && alloc.amount > 0) {
          logToVendorLedger_(vCode,           date, 'Adjustment (Transfer Out)', adjPayId, -Math.abs(alloc.amount));
          logToVendorLedger_(alloc.vendorCode, date, 'Adjustment (Transfer In)',  adjPayId,  Math.abs(alloc.amount));
        }
      }
      for (const alloc of record.allocations) {
        if (alloc.amount > 0) {
          const refPayId = alloc.vendorCode !== vCode ? ('ADJ-' + payId) : payId;
          fifoLiquidate_(alloc.vendorCode, date, refPayId, alloc.amount, er2);
        }
      }
    } else {
      fifoLiquidate_(vCode, date, payId, rmb, er2);
    }

    return successResponse_({ status: 'success', paymentId: payId });
  } catch (e) {
    return errorResponse_(e.toString());
  }
}

function addAdjustmentEntry(data) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const ledgerSheet = ss.getSheetByName('SettlementLedger');
  if (!ledgerSheet) return errorResponse_('SettlementLedger sheet not found');
  try {
    const record       = data.record || data;
    const txnType      = record.txnType || 'Adjustment';
    const date         = record.date    || new Date().toISOString().split('T')[0];
    const notes        = record.notes   || '';
    const settlementId = generateSequentialSettlementId();

    if (txnType === 'Transfer') {
      const refId        = record.paymentId || record.referenceNo || 'TRANSFER';
      const sourceVendor = record.sourceVendor;
      const targetVendor = record.targetVendor;
      const amountRmb    = parseFloat(record.amountRmb) || 0;
      const er2          = parseFloat(record.ER2 || record.fxRate) || 0;
      ledgerSheet.appendRow([date, settlementId + '-A', refId, sourceVendor, '', -Math.abs(amountRmb), 0, er2, 0, 'Adjustment Transfer Out']);
      ledgerSheet.appendRow([date, settlementId + '-B', refId, targetVendor, '',  Math.abs(amountRmb), 0, er2, 0, 'Adjustment Transfer In']);
      logToVendorLedger_(sourceVendor, date, 'Adjustment (Transfer Out)', refId, -Math.abs(amountRmb));
      logToVendorLedger_(targetVendor, date, 'Adjustment (Transfer In)',  refId,  Math.abs(amountRmb));
      return successResponse_({ message: 'Transfer logged', id: settlementId });
    } else {
      const vendorNo  = record.vendorNo || '';
      const amountRmb = parseFloat(record.amountRmb) || 0;
      const er2       = parseFloat(record.ER2 || record.fxRate) || 0;
      const paymentId = record.paymentId || 'ADJ';
      ledgerSheet.appendRow([date, settlementId, paymentId, vendorNo, record.invoiceId || '', amountRmb, 0, er2, 0, txnType + ': ' + notes]);
      logToVendorLedger_(vendorNo, date, txnType, paymentId, amountRmb);
      return successResponse_({ message: txnType + ' logged', id: settlementId });
    }
  } catch (e) {
    return errorResponse_(e.toString());
  }
}

function updatePurchaseInvoice_(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PurchaseInvoices');
  if (!sheet) return errorResponse_('Sheet not found');
  const r          = data.record;
  const values     = sheet.getDataRange().getValues();
  const headers    = values[0];
  const idIdx      = findHeaderIndex_(headers, 'Invoice ID');
  const settledIdx = findHeaderIndex_(headers, 'Settled Amount');
  const balanceIdx = findHeaderIndex_(headers, 'Balance');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idIdx]).trim().toUpperCase() === String(r.invoiceId).trim().toUpperCase()) {
      if (r.settledAmount !== undefined) sheet.getRange(i + 1, settledIdx + 1).setValue(r.settledAmount);
      if (r.balance       !== undefined) sheet.getRange(i + 1, balanceIdx  + 1).setValue(r.balance);
      return successResponse_({ message: 'Invoice updated' });
    }
  }
  return errorResponse_('Invoice not found');
}

function updatePaymentLog_(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PaymentLogs');
  if (!sheet) return errorResponse_('Sheet not found');
  const r          = data.record;
  const values     = sheet.getDataRange().getValues();
  const headers    = values[0];
  const idIdx      = findHeaderIndex_(headers, 'Payment ID');
  const balanceIdx = findHeaderIndex_(headers, 'Balance');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idIdx]).trim() === String(r.paymentId).trim()) {
      if (r.balance !== undefined) sheet.getRange(i + 1, balanceIdx + 1).setValue(r.balance);
      return successResponse_({ message: 'Payment log updated' });
    }
  }
  return errorResponse_('Payment log not found');
}

function commitEodEngine_(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PurchaseInvoices');
  if (!sheet) return errorResponse_('PurchaseInvoices sheet not found');

  const logs    = data.logs    || '';
  const updates = data.updates || [];

  const pattern = /\[EOD Engine\] Successfully processed (\d+) uncalculated transaction\(s\)\./;
  const match   = logs.match(pattern);
  if (!match) return errorResponse_('EOD Engine signature match failed. Logs do not indicate successful completion of processed transactions. Refusing update.');

  const processedCount = parseInt(match[1], 10);
  if (isNaN(processedCount) || processedCount <= 0) return errorResponse_('Validated processed transactions count is zero or invalid.');
  if (updates.length !== processedCount) return errorResponse_('Pre-update verification failed: Misaligned transaction counts between EOD log (' + processedCount + ') and payload updates (' + updates.length + ').');

  const values  = sheet.getDataRange().getValues();
  if (values.length <= 1) return errorResponse_('No rows present in PurchaseInvoices to update.');

  const headers  = values[0];
  const idIdx    = findHeaderIndex_(headers, 'Invoice ID');
  const er1Idx   = findHeaderIndex_(headers, 'ER1');
  const inrIdx   = findHeaderIndex_(headers, 'INR');
  const rmbIdx   = findHeaderIndex_(headers, 'RMB');
  const statusIdx = findHeaderIndex_(headers, 'Status');
  const vCodeIdx  = findHeaderIndex_(headers, 'Vendor Code');
  if (idIdx === -1 || er1Idx === -1 || inrIdx === -1 || rmbIdx === -1) return errorResponse_('Error: Missing required columns in PurchaseInvoices header mapping.');

  const updateMap = {};
  updates.forEach(u => { if (u.invoiceId) updateMap[String(u.invoiceId).trim()] = parseFloat(u.er1) || 0; });

  let updatedCount = 0;
  const updatedInvoicesForSettlement = [];

  for (let i = 1; i < values.length; i++) {
    const rawInvId = String(values[i][idIdx]).trim();
    if (updateMap.hasOwnProperty(rawInvId)) {
      const er1Val = updateMap[rawInvId];
      if (er1Val > 0) {
        const rmbVal = parseFloat(values[i][rmbIdx]) || 0;
        const inrVal = Math.round(rmbVal * er1Val * 100) / 100;
        values[i][er1Idx] = er1Val;
        values[i][inrIdx] = inrVal;
        if (statusIdx !== -1) values[i][statusIdx] = 'Processed';
        updatedCount++;
        let vCode = vCodeIdx !== -1 ? String(values[i][vCodeIdx]).trim() : '';
        if (!vCode) {
          const vIdIdx = findHeaderIndex_(headers, 'Vendor ID');
          if (vIdIdx !== -1) vCode = String(values[i][vIdIdx]).trim();
        }
        updatedInvoicesForSettlement.push({ vendorCode: vCode, date: values[i][0], invoiceId: rawInvId, rmb: rmbVal });
      }
    }
  }

  if (updatedCount > 0) {
    sheet.getRange(1, 1, values.length, headers.length).setValues(values);
    updatedInvoicesForSettlement.forEach(inv => {
      if (inv.vendorCode && inv.invoiceId) autoSettleAdvanceFromInvoice_(inv.vendorCode, inv.date, inv.invoiceId, inv.rmb);
    });
    return successResponse_({ message: 'Transactional batch update successful. Synchronized ' + updatedCount + ' calculation changes in PurchaseInvoices.', updatedCount });
  }
  return successResponse_({ message: 'Finished post-processing validation safely. No direct matches identified to apply updates.', updatedCount: 0 });
}

function deleteRowByUniqueId_(tableName, idColumnName, targetId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(tableName);
  if (!sheet) return errorResponse_('Sheet not found: ' + tableName);
  const data   = sheet.getDataRange().getValues();
  const idIdx  = findHeaderIndex_(data[0], idColumnName);
  if (idIdx === -1) return errorResponse_('ID Column not found: ' + idColumnName);
  let deletedCount = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][idIdx] === targetId) { sheet.deleteRow(i + 1); deletedCount++; }
  }
  return deletedCount > 0
    ? successResponse_({ message: 'Deleted ' + deletedCount + ' row(s) from ' + tableName })
    : errorResponse_('Record ID not found: ' + targetId);
}

// ─────────────────────────────────────────────────────────────
// FIFO ENGINE & LEDGER
// ─────────────────────────────────────────────────────────────

function fifoLiquidate_(vendorCode, date, paymentId, amountRmb, er2) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const invSheet    = ss.getSheetByName('PurchaseInvoices');
  const ledgerSheet = ss.getSheetByName('SettlementLedger');
  if (!invSheet || !ledgerSheet) return;

  const invoices = getSheetData_('PurchaseInvoices')
    .map((inv, idx) => ({ ...inv, sheetRow: idx + 2 }))
    .filter(inv => {
      if ((inv['Vendor Code'] || inv['VendorCode']) !== vendorCode) return false;
      const b = inv.Balance !== undefined && inv.Balance !== '' ? inv.Balance : inv.RMB;
      return parseFloat(b) > 0.01;
    })
    .sort((a, b) => new Date(a.Date).getTime() - new Date(b.Date).getTime());

  let remainingPayment = amountRmb;
  const round2 = v => Math.round(v * 100) / 100;

  for (const inv of invoices) {
    if (remainingPayment <= 0) break;
    const invoiceId = inv['Invoice ID'] || inv['invoiceId'];
    if (settlementExists_(paymentId, invoiceId)) continue;
    const b = inv.Balance !== undefined && inv.Balance !== '' ? inv.Balance : inv.RMB;
    const currentBalance = parseFloat(b);
    if (isNaN(currentBalance) || currentBalance <= 0) continue;
    const settledAmount = Math.min(remainingPayment, currentBalance);
    const er1 = parseFloat(inv.ER1) || er2;
    const headers    = invSheet.getDataRange().getValues()[0];
    const settledIdx = findHeaderIndex_(headers, 'Settled Amount');
    const balanceIdx = findHeaderIndex_(headers, 'Balance');
    const newSettled = (parseFloat(inv['Settled Amount']) || 0) + settledAmount;
    const newBalance = currentBalance - settledAmount;
    if (settledIdx !== -1) invSheet.getRange(inv.sheetRow, settledIdx + 1).setValue(round2(newSettled));
    if (balanceIdx !== -1) invSheet.getRange(inv.sheetRow, balanceIdx + 1).setValue(round2(newBalance));
    ledgerSheet.appendRow([
      date, 'SET-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      paymentId, vendorCode, invoiceId,
      round2(-Math.abs(settledAmount)), er1, er2,
      round2(Math.abs(settledAmount) * (er1 - er2)), 'FIFO Settlement'
    ]);
    remainingPayment -= settledAmount;
  }

  if (remainingPayment > 0.01) {
    const round2 = v => Math.round(v * 100) / 100;
    ledgerSheet.appendRow([
      date, 'SET-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      paymentId, vendorCode, 'ADVANCE',
      round2(Math.abs(remainingPayment)), 0, er2, 0, 'Advance Payment'
    ]);
  }
}

function logToVendorLedger_(vendorCode, date, particulars, refId, rmb) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('VendorLedger');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (
      String(data[i][1] || '').trim() === String(vendorCode).trim() &&
      String(data[i][4] || '').trim() === String(refId).trim() &&
      String(data[i][3] || '').trim() === String(particulars).trim()
    ) return;
  }
  let lastBalance = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(vendorCode)) { lastBalance = parseFloat(data[i][6]) || 0; break; }
  }
  sheet.appendRow([generateTxnId_(), vendorCode, date, particulars, refId, rmb, lastBalance + rmb]);
}

function autoSettleAdvanceFromInvoice_(vendorCode, date, invoiceId, amountRmb) {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const paymentSheet = ss.getSheetByName('PaymentLogs');
  const invSheet     = ss.getSheetByName('PurchaseInvoices');
  const ledgerSheet  = ss.getSheetByName('SettlementLedger');
  if (!paymentSheet || !invSheet || !ledgerSheet) return;

  const invData    = invSheet.getDataRange().getValues();
  if (invData.length <= 1) return;
  const invHeaders  = invData[0];
  const invIdIdx    = findHeaderIndex_(invHeaders, 'Invoice ID')      !== -1 ? findHeaderIndex_(invHeaders, 'Invoice ID')      : findHeaderIndex_(invHeaders, 'invoiceId');
  const invSettledIdx = findHeaderIndex_(invHeaders, 'Settled Amount') !== -1 ? findHeaderIndex_(invHeaders, 'Settled Amount') : findHeaderIndex_(invHeaders, 'settledAmount');
  const invBalanceIdx = findHeaderIndex_(invHeaders, 'Balance')        !== -1 ? findHeaderIndex_(invHeaders, 'Balance')        : findHeaderIndex_(invHeaders, 'balance');
  const invEr1Idx   = findHeaderIndex_(invHeaders, 'ER1');

  let invoiceRow = -1;
  for (let i = 1; i < invData.length; i++) {
    if (String(invData[i][invIdIdx] || '').trim() === String(invoiceId).trim()) { invoiceRow = i + 1; break; }
  }
  if (invoiceRow === -1) return;

  const currentInvBalVal = invBalanceIdx !== -1 ? invData[invoiceRow - 1][invBalanceIdx] : amountRmb;
  let remainingInvoiceBalance = parseFloat(currentInvBalVal !== undefined && currentInvBalVal !== '' ? currentInvBalVal : amountRmb);
  if (isNaN(remainingInvoiceBalance) || remainingInvoiceBalance <= 0) return;

  const payData = getSheetData_('PaymentLogs')
    .map((pay, idx) => ({ ...pay, sheetRow: idx + 2 }))
    .filter(pay => {
      const v = String(pay['Vendor Code'] || pay['VendorCode'] || pay['Vendor ID'] || '').trim();
      if (v !== String(vendorCode).trim()) return false;
      const b = parseFloat(pay.Balance !== undefined && pay.Balance !== '' ? pay.Balance : (pay.RMB !== undefined && pay.RMB !== '' ? pay.RMB : pay['RMB Amount']));
      return !isNaN(b) && b > 0.01;
    })
    .sort((a, b) => new Date(a.Date || a.date).getTime() - new Date(b.Date || b.date).getTime());

  if (payData.length === 0) return;

  const paySheetValues = paymentSheet.getDataRange().getValues();
  if (paySheetValues.length <= 1) return;
  const payHeaders  = paySheetValues[0];
  const payBalanceIdx = findHeaderIndex_(payHeaders, 'Balance') !== -1 ? findHeaderIndex_(payHeaders, 'Balance') : findHeaderIndex_(payHeaders, 'balance');
  const round2 = v => Math.round(v * 100) / 100;

  for (const pay of payData) {
    if (remainingInvoiceBalance <= 0.01) break;
    if (settlementExists_(pay['Payment ID'] || pay.paymentId, invoiceId)) continue;
    const b = parseFloat(pay.Balance !== undefined && pay.Balance !== '' ? pay.Balance : (pay.RMB !== undefined && pay.RMB !== '' ? pay.RMB : pay['RMB Amount']));
    if (isNaN(b) || b <= 0) continue;
    const settledAmount = Math.min(remainingInvoiceBalance, b);
    const newPayBalance = Math.max(0, b - settledAmount);
    if (payBalanceIdx !== -1) paymentSheet.getRange(pay.sheetRow, payBalanceIdx + 1).setValue(round2(newPayBalance));
    const er2           = parseFloat(pay.ER2 || pay.fxRate || pay.fx_rate || '0') || 0;
    const invoiceEr1Val = invEr1Idx !== -1 ? invSheet.getRange(invoiceRow, invEr1Idx + 1).getValue() : '';
    const er1           = parseFloat(invoiceEr1Val) || er2;
    let currentInvSettled = 0;
    let currentInvBalance = 0;
    if (invSettledIdx !== -1) {
      currentInvSettled = parseFloat(invSheet.getRange(invoiceRow, invSettledIdx + 1).getValue()) || 0;
      invSheet.getRange(invoiceRow, invSettledIdx + 1).setValue(round2(currentInvSettled + settledAmount));
    }
    if (invBalanceIdx !== -1) {
      currentInvBalance = parseFloat(invSheet.getRange(invoiceRow, invBalanceIdx + 1).getValue()) || parseFloat(amountRmb) || 0;
      invSheet.getRange(invoiceRow, invBalanceIdx + 1).setValue(round2(Math.max(0, currentInvBalance - settledAmount)));
    }
    ledgerSheet.appendRow([
      date, 'SET-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      pay['Payment ID'] || pay.paymentId, vendorCode, invoiceId,
      round2(-Math.abs(settledAmount)), er1, er2,
      round2(Math.abs(settledAmount) * (er1 - er2)), 'Auto-Settlement Advance Match'
    ]);
    remainingInvoiceBalance -= settledAmount;
  }
}

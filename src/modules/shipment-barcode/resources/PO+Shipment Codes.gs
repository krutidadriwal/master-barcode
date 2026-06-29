function apiSubmitDraft_(payload) {
  const { draftId, vendors } = payload;
  if (!draftId) throw new Error("draftId is required");
  if (!Array.isArray(vendors) || vendors.length === 0) {
    throw new Error("At least one vendor must be selected");
  }

  const now = new Date();
  const userEmail = Session.getActiveUser().getEmail();

  // =========================
  // Sheets & headers
  // =========================
  const draftSheet = getSheet_(SHEET_NAMES.DRAFT_ORDERS);
  const draftHeader = getHeaderMap_(draftSheet);

  const lineSheet = getSheet_(SHEET_NAMES.DRAFT_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);

  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);

  const poLineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const poLineHeader = getHeaderMap_(poLineSheet);

  const vendorSheet = getSheet_(SHEET_NAMES.VENDOR_MASTERS);
  const vendorHeader = getHeaderMap_(vendorSheet);
  const vendorData = vendorSheet.getDataRange().getValues();

  // =========================
  // 1️⃣ Fetch & validate draft
  // =========================
  const draftData = draftSheet.getDataRange().getValues();
  let draftRow = null;

  for (let i = 1; i < draftData.length; i++) {
    if (String(draftData[i][draftHeader.draft_id]).trim() === draftId) {
      draftRow = draftData[i];
      break;
    }
  }

  if (!draftRow) throw new Error(`Draft not found: ${draftId}`);
  if (draftRow[draftHeader.status] !== "DRAFT") {
    throw new Error("Draft is locked after submission");
  }

  const plannedMode = draftRow[draftHeader.planned_mode];

  // =========================
  // 2️⃣ Collect draft lines by vendor
  // =========================
  const lineData = lineSheet.getDataRange().getValues();
  const vendorGroups = {}; // vendor_code → lines[]

  for (let i = 1; i < lineData.length; i++) {
    const row = lineData[i];
    if (String(row[lineHeader.draft_id]).trim() !== draftId) continue;

    const vendorCode = row[lineHeader.vendor_code];
    if (!vendors.includes(vendorCode)) continue;

    if (!vendorGroups[vendorCode]) vendorGroups[vendorCode] = [];
    vendorGroups[vendorCode].push(row);
  }

  const vendorsWithLines = Object.keys(vendorGroups);
  if (vendorsWithLines.length === 0) {
    throw new Error("Selected vendors have no draft lines");
  }

  // =========================
  // 3️⃣ Build vendor email lookup
  // =========================
  const vendorEmailMap = {};
  for (let i = 1; i < vendorData.length; i++) {
    const row = vendorData[i];
    const vCode = row[vendorHeader.vendor_code];
    if (!vCode) continue;

    vendorEmailMap[vCode] = {
      to: row[vendorHeader.primary_email] || "",
      cc: row[vendorHeader.cc_emails] || ""
    };
  }

  // =========================
  // 4️⃣ Create POs + PO Lines
  // =========================
  const createdPOs = [];

  vendorsWithLines.forEach(vendorCode => {
    //const poId = "PO-" + Utilities.getUuid().slice(0, 8).toUpperCase();
    const poId = generatePoId_(vendorCode, now);

    const lines = vendorGroups[vendorCode];

    let totalQty = 0;
    lines.forEach(l => {
      totalQty += Number(l[lineHeader.qty] || 0);
    });

    // ---- PO Header
    appendRowFromObject_(poSheet, poHeader, {
      po_id: poId,
      draft_id: draftId,
      po_date: now,
      planned_mode: plannedMode,
      vendor_code: vendorCode,
      total_skus: lines.length,
      total_qty: totalQty,
      po_status: "OPEN",
      email_status: "NOT_SENT",
      created_by: userEmail,
      created_at: now,
      updated_at: now
    });

    // ---- PO Lines
    lines.forEach(l => {
      const qty = Number(l[lineHeader.qty] || 0);
      const price = Number(l[lineHeader.unit_price] || 0);

      appendRowFromObject_(poLineSheet, poLineHeader, {
        po_line_id: Utilities.getUuid(),
        po_id: poId,
        sku: l[lineHeader.sku],
        sku_name: l[lineHeader.sku_name],
        vendor_code: vendorCode,
        ordered_qty: qty,
        unit_price_rmb: price,
        line_total_rmb: qty * price,

        custom_logo: l[lineHeader.custom_logo],
        custom_packaging: l[lineHeader.custom_packaging],
        solving_manual: l[lineHeader.solving_manual],
        opp_wrap: l[lineHeader.opp_wrap],
        custom_remarks: l[lineHeader.custom_remarks],
        customization_files: l[lineHeader.customization_files],

        line_status: "OPEN",
        fulfilled_qty: 0,
        created_at: now,
        updated_at: now
      });
    });

    // =========================
    // 5️⃣ Send Email + Log
    // =========================
    const emailInfo = vendorEmailMap[vendorCode] || { to: "", cc: "" };
    sendPoEmailAndLog_(
      poId,
      vendorCode,
      emailInfo.to,
      emailInfo.cc,
      userEmail
    );

    createdPOs.push(poId);
  });

  // =========================
  // 6️⃣ Update draft status
  // =========================
  updateRowByKey_(draftSheet, draftHeader, "draft_id", draftId, {
    status:
      vendorsWithLines.length === vendors.length
        ? "SUBMITTED"
        : "PARTIALLY_SUBMITTED",
    updated_at: now
  });

  return {
    success: true,
    draftId,
    newPOs: createdPOs,
    message: "Purchase Orders created successfully"
  };
}
 
function sendPoEmailAndLog_(poId, vendorCode, emailTo, emailCc, createdBy) {
  const now = new Date();

  const logSheet = getSheet_(SHEET_NAMES.PO_EMAIL_LOG);
  const logHeader = getHeaderMap_(logSheet);
  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poLineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const poLineHeader = getHeaderMap_(poLineSheet);

  // Fetch vendor name
  const vendorSheet = getSheet_(SHEET_NAMES.VENDOR_MASTERS);
  const vendorHeader = getHeaderMap_(vendorSheet);
  const vendorData = vendorSheet.getDataRange().getValues();
  let vendorName = vendorCode;
  for (let i = 1; i < vendorData.length; i++) {
    if (String(vendorData[i][vendorHeader.vendor_code]).trim() === vendorCode) {
      vendorName = vendorData[i][vendorHeader.vendor_name] || vendorCode;
      break;
    }
  }

  // Fetch Article Numbers from EE Product Master
  const productData = getSheetData(SHEETS.products);
  const articleMap = new Map();
  for (const row of productData) {
    const sku = getValue(row, SHEETS.products, 'SKU');
    const articleNo = getValue(row, SHEETS.products, 'Article Number') || '-';
    if (sku) articleMap.set(sku, articleNo);
  }

  // Fetch PO lines
  const poLineData = poLineSheet.getDataRange().getValues();
  const lines = [];
  for (let i = 1; i < poLineData.length; i++) {
    if (String(poLineData[i][poLineHeader.po_id]).trim() === poId) {
      lines.push(poLineData[i]);
    }
  }

  // Calculate total qty
  let totalQty = 0;
  lines.forEach(l => {
    totalQty += Number(l[poLineHeader.ordered_qty] || 0);
  });

  // Format date
  const poDate = Utilities.formatDate(
    now, Session.getScriptTimeZone(), 'dd MMM yyyy'
  );

  // ── Build CSV content ──────────────────────────────────────────
  const csvRows = [
    [
      'Purchase Order ID', 'SKU', 'Article Number', 'Itemname',
      'Qty', 'Custom Logo', 'Custom Packaging', 'Solving Manual',
      'OPP Wrap', 'Other Remarks', 'Customization Files'
    ]
  ];

  lines.forEach(l => {
    const sku = l[poLineHeader.sku] || '';
    csvRows.push([
      poId,
      sku,
      articleMap.get(sku) || '-',
      l[poLineHeader.sku_name] || '',
      Number(l[poLineHeader.ordered_qty] || 0),
      l[poLineHeader.custom_logo] ? 'Yes' : 'No',
      l[poLineHeader.custom_packaging] ? 'Yes' : 'No',
      l[poLineHeader.solving_manual] ? 'Yes' : 'No',
      l[poLineHeader.opp_wrap] ? 'Yes' : 'No',
      l[poLineHeader.custom_remarks] || '-',
      l[poLineHeader.customization_files] || '-'
    ]);
  });

  const csvContent = csvRows.map(row =>
    row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')
  ).join('\n');

  const csvBlob = Utilities.newBlob(
    csvContent,
    'text/csv',
    `Purchase_Orders_${vendorCode}_${poId}.csv`
  );

// ── Build Drive folder attachments ────────────────────────────
const driveAttachments = [];
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB in bytes
let totalAttachmentSize = 0;
let attachmentLimitReached = false;

lines.forEach(l => {
  if (attachmentLimitReached) return;

  const fileUrl = l[poLineHeader.customization_files] || '';
  if (!fileUrl) return;

  try {
    const match = fileUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (!match) return;

    const folderId = match[1];
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFiles();

    while (files.hasNext()) {
      const file = files.next();
      const fileSize = file.getSize();

      if (totalAttachmentSize + fileSize > MAX_ATTACHMENT_SIZE) {
        attachmentLimitReached = true;
        Logger.log(
          'Attachment size limit reached at SKU: ' 
          + l[poLineHeader.sku] 
          + ' | Total so far: ' 
          + (totalAttachmentSize / 1024 / 1024).toFixed(2) + 'MB'
        );
        break;
      }

      driveAttachments.push(file.getBlob());
      totalAttachmentSize += fileSize;
    }

  } catch (err) {
    Logger.log(
      'Drive attachment error for SKU ' 
      + l[poLineHeader.sku] + ': ' + err.message
    );
  }
});

if (attachmentLimitReached) {
  Logger.log(
    'Some Drive files were not attached — size limit exceeded. '
    + 'Total attached: ' 
    + (totalAttachmentSize / 1024 / 1024).toFixed(2) + 'MB'
    + ' | Drive links still visible in email table.'
  );
}

  // ── Build SKU rows HTML ───────────────────────────────────────
  const yesStyle = `
    display:inline-block; background:#dc2626; color:#fff;
    font-weight:700; font-size:12px; padding:2px 10px;
    border-radius:4px;`;
  const noStyle = `
    display:inline-block; background:#e2e8f0; color:#64748b;
    font-size:12px; padding:2px 10px; border-radius:4px;`;

  const skuRows = lines.map(l => {
    const sku = l[poLineHeader.sku] || '';
    const articleNo = articleMap.get(sku) || '-';
    const skuName = l[poLineHeader.sku_name] || '';
    const qty = Number(l[poLineHeader.ordered_qty] || 0);
    const remarks = l[poLineHeader.custom_remarks] || '-';
    const fileUrl = l[poLineHeader.customization_files] || '';

    const badge = (val) => val
      ? `<span style="${yesStyle}">Yes</span>`
      : `<span style="${noStyle}">No</span>`;

    const fileCell = fileUrl
      ? `<a href="${fileUrl}" 
            style="color:#2563eb; font-size:12px; word-break:break-all;">
           ${fileUrl}
         </a>`
      : '-';

    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding:10px 12px; font-size:12px; color:#334155;
                   border-right:1px solid #e2e8f0;">${poId}</td>
        <td style="padding:10px 12px; font-family:monospace;
                   font-size:12px; color:#334155;
                   border-right:1px solid #e2e8f0;">${sku}</td>
        <td style="padding:10px 12px; font-size:12px; color:#334155;
                   border-right:1px solid #e2e8f0;">${articleNo}</td>
        <td style="padding:10px 12px; font-size:12px; color:#1e293b;
                   border-right:1px solid #e2e8f0;">${skuName}</td>
        <td style="padding:10px 12px; text-align:center;
                   font-size:13px; font-weight:600; color:#1e293b;
                   border-right:1px solid #e2e8f0;">${qty}</td>
        <td style="padding:10px 12px; text-align:center;
                   border-right:1px solid #e2e8f0;">${badge(l[poLineHeader.custom_logo])}</td>
        <td style="padding:10px 12px; text-align:center;
                   border-right:1px solid #e2e8f0;">${badge(l[poLineHeader.custom_packaging])}</td>
        <td style="padding:10px 12px; text-align:center;
                   border-right:1px solid #e2e8f0;">${badge(l[poLineHeader.solving_manual])}</td>
        <td style="padding:10px 12px; text-align:center;
                   border-right:1px solid #e2e8f0;">${badge(l[poLineHeader.opp_wrap])}</td>
        <td style="padding:10px 12px; text-align:center;
                   font-size:12px; color:#64748b;
                   border-right:1px solid #e2e8f0;">${remarks}</td>
        <td style="padding:10px 12px; font-size:12px;">
          ${fileCell}
        </td>
      </tr>`;
  }).join('');

  // ── Build HTML from template ──────────────────────────────────
  const htmlTemplate = HtmlService
    .createTemplateFromFile('POEmailTemplate');
  htmlTemplate.PO_ID = poId;
  htmlTemplate.PO_DATE = poDate;
  htmlTemplate.VENDOR_NAME = vendorName;
  htmlTemplate.TOTAL_QTY = totalQty;
  htmlTemplate.SKU_ROWS = skuRows;
  const htmlBody = htmlTemplate.evaluate().getContent();

  // ── Send email ────────────────────────────────────────────────
  try {
    if (emailTo) {
      const allAttachments = [csvBlob, ...driveAttachments];

      GmailApp.sendEmail(
        emailTo,
        `Purchase Order from Cubelelo | PO ID: ${poId}`,
        // Plain text fallback
        `Dear ${vendorName},\n\n`
        + `Please find below the details of your confirmed purchase `
        + `order from Cubelelo. Kindly process the same at the earliest.\n\n`
        + `PO ID: ${poId}\nDate: ${poDate}\nTotal Units: ${totalQty}\n\n`
        + `Regards,\nTeam Cubelelo`,
        {
          cc: emailCc || '',
          htmlBody: htmlBody,
          name: 'Cubelelo Procurement',
          attachments: allAttachments
        }
      );
    }

    // Update PO email status
    updateRowByKey_(poSheet, poHeader, 'po_id', poId, {
      email_status: 'SENT',
      updated_at: now
    });

    // Log success
    appendRowFromObject_(logSheet, logHeader, {
      log_id: Utilities.getUuid(),
      po_id: poId,
      vendor_code: vendorCode,
      email_to: emailTo,
      email_cc: emailCc,
      email_status: 'SENT',
      sent_at: now,
      created_by: createdBy,
      created_at: now
    });

  } catch (e) {
    Logger.log('sendPoEmailAndLog_ error: ' + e.message);

    appendRowFromObject_(logSheet, logHeader, {
      log_id: Utilities.getUuid(),
      po_id: poId,
      vendor_code: vendorCode,
      email_to: emailTo,
      email_cc: emailCc,
      email_status: 'FAILED',
      error_message: e.message,
      created_by: createdBy,
      created_at: now
    });
  }
}

/*function apiGetPurchaseOrders_(payload) {
  const sheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();

  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    rows.push({
      po_id: r[header.po_id],
      draft_id: r[header.draft_id],
      po_date: r[header.po_date],
      planned_mode: r[header.planned_mode],
      vendor_code: r[header.vendor_code],
      total_skus: r[header.total_skus],
      total_qty: r[header.total_qty],
      po_status: r[header.po_status],
      email_status: r[header.email_status]
    });
  }

  return {
    success: true,
    data: rows
  };
}*/

function apiGetPurchaseOrders_(payload) {
  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();

  const lineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  const lineData = lineSheet.getDataRange().getValues();

  // Build fulfillment totals map: po_id → { ordered, fulfilled }
  const fulfillmentMap = {};
  for (let i = 1; i < lineData.length; i++) {
    const poId = String(lineData[i][lineHeader.po_id] || '').trim();
    if (!poId) continue;
    if (!fulfillmentMap[poId]) fulfillmentMap[poId] = { ordered: 0, fulfilled: 0 };
    fulfillmentMap[poId].ordered   += Number(lineData[i][lineHeader.ordered_qty]   || 0);
    fulfillmentMap[poId].fulfilled += Number(lineData[i][lineHeader.fulfilled_qty] || 0);
  }

  const rows = [];
  for (let i = 1; i < poData.length; i++) {
    const r = poData[i];
    const poId = String(r[poHeader.po_id] || '').trim();
    if (!poId) continue;
    const fm = fulfillmentMap[poId] || { ordered: 0, fulfilled: 0 };
    rows.push({
      po_id:                poId,
      draft_id:             r[poHeader.draft_id],
      po_date:              r[poHeader.po_date] ? new Date(r[poHeader.po_date]).toISOString() : '',
      planned_mode:         r[poHeader.planned_mode],
      vendor_code:          r[poHeader.vendor_code],
      total_skus:           r[poHeader.total_skus],
      total_qty:            r[poHeader.total_qty],
      po_status:            r[poHeader.po_status],
      email_status:         r[poHeader.email_status],
      total_ordered_qty:    fm.ordered,
      total_fulfilled_qty:  fm.fulfilled
    });
  }

  return { success: true, data: rows };
}

function apiGetPurchaseOrderDetails_(payload) {
  const { po_id } = payload;
  if (!po_id) throw new Error("po_id is required");

  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();

  let po = null;

  for (let i = 1; i < poData.length; i++) {
    if (poData[i][poHeader.po_id] === po_id) {
      po = {};
      Object.keys(poHeader).forEach(k => {
        po[k] = poData[i][poHeader[k]];
      });
      break;
    }
  }

  if (!po) throw new Error(`PO not found: ${po_id}`);

  const lineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  const lineData = lineSheet.getDataRange().getValues();

  const lines = [];

  for (let i = 1; i < lineData.length; i++) {
    if (lineData[i][lineHeader.po_id] === po_id) {
      const l = {};
      Object.keys(lineHeader).forEach(k => {
        l[k] = lineData[i][lineHeader[k]];
      });
      lines.push(l);
    }
  }

  return {
    success: true,
    po,
    lines
  };
}


function generatePoId_(vendorCode, now) {
  const sheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();

  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const dateKey = `${yy}${mm}${dd}`;
  const prefix = `PO-${vendorCode}${dateKey}-`;

  let maxSeq = 0;

  for (let i = 1; i < data.length; i++) {
    const poId = String(data[i][header.po_id] || '');
    if (poId.startsWith(prefix)) {
      const parts = poId.split('-');
      const seq = Number(parts[parts.length - 1]);
      if (!isNaN(seq)) {
        maxSeq = Math.max(maxSeq, seq);
      }
    }
  }

  return `${prefix}${maxSeq + 1}`;
}


//---------------------------------Shipment Uploading Code with SKU Matching -----------------------------

/**
 * API: Upload & Normalize Vendor Shipment with SKU Matching
 * Phase: Setup + Validation + SKU Matching
 *
 * NEW FEATURES:
 * - Priority-based column mapping with fallback
 * - Factory code concatenation for multiple sources
 * - EE Product Master lookup (EAN → Article Number → Other Factory Code)
 * - SKU cross-checking with vendor-provided SKU
 * - Filter out total/summary rows
 */
function apiUploadAndNormalizeVendorShipment(payload) {
  validateUploadPayload_(payload);

  const shipmentId = createVendorShipmentHeader_(payload);

  const mappingConfig = loadVendorInvoiceMapping_(payload.vendorCode);
  // Mapping is now optional — frontend handles column detection

  const allNormalizedRows = [];
  const issues = [];

  payload.files.forEach((file) => {
    const rawRows = file.rows || [];
    if (!rawRows.length) return;

    // Frontend handles all column detection — always passthrough
    const normalizedRows = rawRows.map((row, index) => ({
      ...row,
      line_id: `LINE-${Date.now()}-${index + 1}`,
      source_file_name: file.fileName,
      document_type: file.documentType
    }));

    allNormalizedRows.push(...normalizedRows);
  }); // ← closing brace was missing

  const productMaster = loadEEProductMaster_();
  const matchedRows = performSKUMatching_(allNormalizedRows, productMaster);

  updateVendorShipmentStatus_(shipmentId, 'NORMALIZED');

  return {
    status: 'success',
    shipmentId,
    rows: matchedRows,
    issues
  };
}

function validateUploadPayload_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');

  if (!payload.vendorCode) throw new Error('vendorCode missing');
  if (!payload.shipmentDate) throw new Error('shipmentDate missing');

  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error('No files uploaded');
  }

  payload.files.forEach((file, index) => {
    if (!file.fileName) throw new Error(`fileName missing for file #${index + 1}`);
    if (!file.documentType) throw new Error(`documentType missing for file #${index + 1}`);
    if (!Array.isArray(file.rows)) throw new Error(`rows missing or invalid for file #${index + 1}`);
    if (file.rows.length === 0) throw new Error(`No rows found in file #${index + 1}`);
  });
}

function createVendorShipmentHeader_(payload) {
  const sheet = getSheet_(SHEET_NAMES.VENDOR_SHIPMENTS);
  const header = getHeaderMap_(sheet);
  const shipmentId = `VS-${Date.now()}`;

  appendRowFromObject_(sheet, header, {
    shipment_id: shipmentId,
    batch_id: '',
    vendor_code: payload.vendorCode || '',
    po_id: payload.poId || '',
    status: 'NORMALIZED',
    invoice_no: payload.invoiceReference || '',
    invoice_date: payload.shipmentDate || '',
    total_amount: 0,
    carton_count: 0,
    carrier: '',
    expected_delivery: '',
    remarks: payload.remarks || '',
    created_at: new Date(),
    submitted_at: ''
  });

  return shipmentId;
}

function updateVendorShipmentStatus_(shipmentId, status) {
  const sheet = getSheet_('Vendor_Shipments');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];

  const idCol = headers.indexOf('shipment_id');
  const statusCol = headers.indexOf('status');

  if (idCol === -1 || statusCol === -1) {
    throw new Error('Vendor_Shipments sheet is missing shipment_id/status columns');
  }

  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] === shipmentId) {
      sheet.getRange(r + 1, statusCol + 1).setValue(status);
      return;
    }
  }

  throw new Error(`Shipment not found: ${shipmentId}`);
}

/**
 * Load vendor invoice mapping with priority support
 * UPDATED: Now includes priority column
 */
function loadVendorInvoiceMapping_(vendorCode) {
  const sheet = getSheet_('Vendor_Invoice_Mapping');
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  const headers = rows[0];
  const idx = (h) => headers.indexOf(h);

  const iVendor = idx('vendor_code');
  const iDoc = idx('document_type');
  const iSource = idx('source_column');
  const iCanonical = idx('canonical_field');
  const iReq = idx('required');
  const iTransform = idx('transform');
  const iPriority = idx('priority');

  return rows.slice(1)
    .filter(r => String(r[iVendor] || '').trim() === String(vendorCode).trim())
    .map(r => ({
      documentType: String(r[iDoc] || '').trim(),
      sourceColumn: String(r[iSource] || '').trim(),
      canonicalField: String(r[iCanonical] || '').trim(),
      required: String(r[iReq] || '').toLowerCase() === 'true' || r[iReq] === true,
      transform: String(r[iTransform] || '').trim(),
      priority: Number(r[iPriority]) || 1  // Default to 1 if missing
    }))
    .filter(m => m.documentType && m.sourceColumn && m.canonicalField);
}

/**
 * Normalize file rows with priority-based mapping
 * COMPLETELY REWRITTEN:
 * - Groups mappings by canonical field
 * - Applies priority-based fallback
 * - Concatenates factory_code values
 * - Filters out total/summary rows
 */
function normalizeFileRows_({
  rawRows,
  mappingConfig,
  vendorCode,
  documentType,
  sourceFileName,
  issueSink
}) {
  const documentMappings = mappingConfig.filter(m => 
    m.documentType === documentType
  );
  
  if (!documentMappings.length) {
    throw new Error(
      `No mappings found for vendor ${vendorCode} and document type ${documentType}`
    );
  }

  // Group mappings by canonical field
  const mappingsByCanonical = {};
  documentMappings.forEach(m => {
    if (!mappingsByCanonical[m.canonicalField]) {
      mappingsByCanonical[m.canonicalField] = [];
    }
    mappingsByCanonical[m.canonicalField].push(m);
  });

  // Sort each group by priority
  Object.keys(mappingsByCanonical).forEach(canonical => {
    mappingsByCanonical[canonical].sort((a, b) => a.priority - b.priority);
  });

  const runId = Date.now();

  return rawRows
.filter((raw, index) => {
  // Skip completely empty rows
  const allEmpty = Object.values(raw).every(
    v => v === null || v === undefined || String(v).trim() === ''
  );
  if (allEmpty) return false;

  // Skip total/summary/separator rows
  const firstVal = String(
    Object.values(raw).find(v => v !== null && v !== undefined) || ''
  ).toLowerCase().trim();
  
  if (
    firstVal.startsWith('total') ||
    firstVal.includes('discount') ||
    firstVal.startsWith('===') ||
    firstVal.startsWith('---') ||
    firstVal === 'ps:' ||
    firstVal.startsWith('bank')
  ) return false;

  return true;
})
    .map((raw, index) => {
      const normalized = {
        line_id: `LINE-${runId}-${index + 1}`,
        source_file_name: sourceFileName,
        document_type: documentType
      };

      // Process each canonical field
      Object.keys(mappingsByCanonical).forEach(canonicalField => {
        const mappings = mappingsByCanonical[canonicalField];

        if (canonicalField === 'factory_code') {
          // SPECIAL CASE: Concatenate ALL non-empty factory codes
          const factoryCodes = [];
          mappings.forEach(m => {
            let value = raw[m.sourceColumn];
            if (value !== null && value !== undefined && String(value).trim() !== '') {
              value = applyTransform_(value, m.transform);
              factoryCodes.push(String(value).trim());
            }
          });

          if (factoryCodes.length === 0 && mappings.some(m => m.required)) {
            issueSink.push({
              line: index + 1,
              field: 'factory_code',
              issue: 'Required field "Factory Code" is missing'
            });
          }

          normalized[canonicalField] = factoryCodes.join('|');
        } else {
          // NORMAL CASE: Use first non-empty value (priority-based fallback)
          let finalValue = '';
          let found = false;

          for (const m of mappings) {
            let value = raw[m.sourceColumn];
            
            if (value !== null && value !== undefined && String(value).trim() !== '') {
              value = applyTransform_(value, m.transform);
              finalValue = value;
              found = true;
              break; // Use first non-empty value
            }
          }

          if (!found && mappings.some(m => m.required)) {
            issueSink.push({
              line: index + 1,
              field: canonicalField,
              issue: `Required field "${mappings[0].sourceColumn}" is missing`
            });
          }

          normalized[canonicalField] = finalValue;
        }
      });

      // Ensure numeric fields
      normalized.unit_price = Number(normalized.unit_price) || 0;
      normalized.invoice_qty = Number(normalized.invoice_qty) || 0;
      normalized.total_price = normalized.unit_price * normalized.invoice_qty;

      return normalized;
    });
}

function applyTransform_(value, transform) {
  if (value === null || value === undefined) return '';

  switch (transform) {
    case 'trim':
      return String(value).trim();
    case 'number':
      return Number(value) || 0;
    case 'upper':
      return String(value).toUpperCase();
    case 'lower':
      return String(value).toLowerCase();
    default:
      return value;
  }
}

/**
 * Validate that required canonical fields have at least one mapping
 * UPDATED: Works with priority-based mappings
 */
function validateVendorMapping_(mappingConfig, vendorCode, documentType) {
  const docMappings = mappingConfig.filter(m => 
    m.documentType === documentType
  );

  if (docMappings.length === 0) {
    throw new Error(
      `No mappings configured for vendor ${vendorCode}, document type ${documentType}`
    );
  }

  // Check that required canonical fields have at least one mapping
  const requiredFields = ['factory_code', 'invoice_qty', 'unit_price'];
  const mappedCanonicalFields = [...new Set(docMappings.map(m => m.canonicalField))];

  const missingFields = requiredFields.filter(f => !mappedCanonicalFields.includes(f));
  
  if (missingFields.length > 0) {
    throw new Error(
      `Incomplete mapping for ${vendorCode} (${documentType}). Missing: ${missingFields.join(', ')}`
    );
  }
}

// ========================== SKU MATCHING FUNCTIONS ==========================

/**
 * Calculate string similarity using Levenshtein distance
 * Returns percentage similarity (0-100)
 */
function calculateStringSimilarity_(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = String(str1).toLowerCase().trim().replace(/\s+/g, ' ');
  const s2 = String(str2).toLowerCase().trim().replace(/\s+/g, ' ');
  
  if (s1 === s2) return 100;
  
  const matrix = [];
  const len1 = s1.length;
  const len2 = s2.length;
  
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const distance = matrix[len1][len2];
  const maxLength = Math.max(len1, len2);
  const similarity = ((maxLength - distance) / maxLength) * 100;
  
  return Math.round(similarity);
}

/**
 * Calculate price difference percentage
 */
function calculatePriceDiffPercentage_(invoicePrice, masterCost) {
  if (!masterCost || masterCost === 0) return 0;
  
  const convRate = 17.55;
  const minValue = Math.min(0.025 + (invoicePrice / 2000), 0.1);
  const calculatedCost = Math.ceil((1 - minValue) * convRate * invoicePrice);
  
  const diff = calculatedCost - masterCost;
  const percentage = (diff / masterCost) * 100;
  
  return Math.abs(percentage);
}

/**
 * Check if match should be flagged as PARTIAL_MATCH
 */
function checkPartialMatch_(row, matchResult, invoicePrice) {
  const vendorSKU = row.sku && String(row.sku).trim() !== '' ? String(row.sku).trim() : null;
  
  if (vendorSKU) {
    return { isPartial: false, reason: '', nameSimilarity: 100, priceDiff: 0 };
  }
  
  const invoiceName = String(row.item_name || '').trim();
  const matchedName = String(matchResult.productName || '').trim();
  const nameSimilarity = calculateStringSimilarity_(invoiceName, matchedName);
  
  const priceDiff = calculatePriceDiffPercentage_(invoicePrice, matchResult.cost);
  
  const NAME_THRESHOLD = 40;
  const PRICE_THRESHOLD = 30;
  
  let isPartial = false;
  let reason = '';
  
  if (nameSimilarity < NAME_THRESHOLD && priceDiff > PRICE_THRESHOLD) {
    isPartial = true;
    reason = 'Name mismatch & Price variance';
  } else if (nameSimilarity < NAME_THRESHOLD) {
    isPartial = true;
    reason = 'Name mismatch';
  } else if (priceDiff > PRICE_THRESHOLD) {
    isPartial = true;
    reason = 'Price variance';
  }
  
  return {
    isPartial,
    reason,
    nameSimilarity,
    priceDiff: Math.round(priceDiff)
  };
}

/**
 * Load EE Product Master sheet
 * Returns array of product objects with all fields
 */
function loadEEProductMaster_() {
  const sheet = getSheet_('EE Product Master');
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  const headers = rows[0];
  const idx = (h) => headers.indexOf(h);

  return rows.slice(1).map(r => ({
    productId: String(r[idx('Product ID')] || '').trim(),
    sku: String(r[idx('SKU')] || '').trim(),
    productName: String(r[idx('Product Name')] || '').trim(),
    ean: String(r[idx('EAN')] || '').trim(),
    articleNumber: String(r[idx('Article Number')] || '').trim(),
    otherFactoryCode: String(r[idx('Other Factory Item Code')] || '').trim(),
    cost: Number(r[idx('Cost')]) || 0,
    brand: String(r[idx('Brand')] || '').trim(),
    category: String(r[idx('Category Name')] || '').trim(),
    leadTime: Number(r[idx('Lead_Time')]) || 0,
    moq: Number(r[idx('MOQ')]) || 0
  })).filter(p => p.sku); // Only include rows with valid SKU
}

/**
 * Match SKU by EAN
 * Returns matched product or null
 */
function matchSKUByEAN_(ean, productMaster) {
  if (!ean || String(ean).trim() === '') return null;
  
  const cleanEAN = String(ean).trim();
  
  for (const product of productMaster) {
    if (product.ean === cleanEAN) {
      return {
        ...product,
        matchedBy: 'EAN',
        matchedCode: cleanEAN,
        matchConfidence: 'HIGH'
      };
    }
  }
  
  return null;
}

/**
 * Match SKU by Factory Code
 * Searches in Article Number, then Other Factory Item Code
 * Returns matched product or null
 */
function matchSKUByFactoryCode_(factoryCode, productMaster) {
  if (!factoryCode || String(factoryCode).trim() === '') return null;
  
  const cleanCode = String(factoryCode).trim();
  
  // Try Article Number first
  for (const product of productMaster) {
    if (product.articleNumber === cleanCode) {
      return {
        ...product,
        matchedBy: 'ARTICLE_NUMBER',
        matchedCode: cleanCode,
        matchConfidence: 'MEDIUM'
      };
    }
  }
  
  // Try Other Factory Item Code
  for (const product of productMaster) {
    if (product.otherFactoryCode === cleanCode) {
      return {
        ...product,
        matchedBy: 'OTHER_FACTORY_CODE',
        matchedCode: cleanCode,
        matchConfidence: 'MEDIUM'
      };
    }
  }
  
  return null;
}

/**
 * Detect duplicate EANs in the batch
 * Returns: Map of EAN → count
 * Purpose: Identify potential variant issues (same EAN, multiple products)
 */
function detectDuplicateEANs_(normalizedRows) {
  const eanCounts = {};
  
  normalizedRows.forEach(row => {
    if (row.ean && String(row.ean).trim() !== '') {
      const ean = String(row.ean).trim();
      eanCounts[ean] = (eanCounts[ean] || 0) + 1;
    }
  });
  
  return eanCounts;
}

/**
 * Perform SKU matching for all normalized rows
 * Main matching orchestrator
 * 
 * Logic:
 * 1. Try EAN match first (highest priority)
 * 2. Try factory codes in priority order
 * 3. Check for SKU mismatch if vendor SKU exists
 * 4. Check for partial match if vendor SKU missing (name + price validation)
 * 5. Set appropriate match status
 */
/*function performSKUMatching_(normalizedRows, productMaster) {
  // NEW: Detect duplicate EANs first
  const eanCounts = detectDuplicateEANs_(normalizedRows);
  
  return normalizedRows.map(row => {
    let matchResult = null;
    let matchedProducts = [];
    
    const vendorSKU = row.sku && String(row.sku).trim() !== '' ? String(row.sku).trim() : null;
    const invoicePrice = Number(row.unit_price) || 0;
    
    // Step 1: Try EAN match first
    if (row.ean) {
      matchResult = matchSKUByEAN_(row.ean, productMaster);
      if (matchResult) {
        // NEW: Check if this EAN appears multiple times without vendor SKU
        // This indicates potential variant issue (e.g., same product different sizes)
        if (eanCounts[row.ean] > 1 && !vendorSKU) {
          return enrichRowWithMatch_(row, matchResult, 'MULTIPLE_VARIANT');
        }
        
        // Check for SKU mismatch (if vendor SKU exists)
        if (vendorSKU && matchResult.sku !== vendorSKU) {
          return enrichRowWithMatch_(row, matchResult, 'SKU_MISMATCH');
        }
        
        // Check for partial match (if vendor SKU missing)
        const partialCheck = checkPartialMatch_(row, matchResult, invoicePrice);
        if (partialCheck.isPartial) {
          //return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck);
          return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck, checkMyId_(row, matchResult));

        }
        
        return enrichRowWithMatch_(row, matchResult, 'MATCH');
      }
    }
    
    // Step 2: Try factory codes (in priority order)
    if (row.factory_code) {
      const factoryCodes = row.factory_code.split('|');
      
      for (const code of factoryCodes) {
        const match = matchSKUByFactoryCode_(code, productMaster);
        if (match) {
          matchedProducts.push(match);
        }
      }
      
      if (matchedProducts.length === 1) {
        matchResult = matchedProducts[0];
        
        if (vendorSKU && matchResult.sku !== vendorSKU) {
          return enrichRowWithMatch_(row, matchResult, 'SKU_MISMATCH');
        }
        
        const partialCheck = checkPartialMatch_(row, matchResult, invoicePrice);
        if (partialCheck.isPartial) {
          return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck);
        }
        
        return enrichRowWithMatch_(row, matchResult, 'MATCH');
        
      } else if (matchedProducts.length > 1) {
        const uniqueSKUs = [...new Set(matchedProducts.map(p => p.sku))];
        
        if (uniqueSKUs.length === 1) {
          matchResult = matchedProducts[0];
          
          if (vendorSKU && matchResult.sku !== vendorSKU) {
            return enrichRowWithMatch_(row, matchResult, 'SKU_MISMATCH');
          }
          
          const partialCheck = checkPartialMatch_(row, matchResult, invoicePrice);
          if (partialCheck.isPartial) {
            return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck);
          }
          
          return enrichRowWithMatch_(row, matchResult, 'MATCH');
        } else {
          return enrichRowWithMatch_(row, matchedProducts[0], 'MULTIPLE_MATCH', matchedProducts);
        }
      }
    }
    
    return enrichRowWithMatch_(row, null, 'UNMATCHED');
  });
} */

/**
 * Enrich row with matching results
 * UPDATED: Added partialMatchInfo parameter for PARTIAL_MATCH cases
 */
/*function enrichRowWithMatch_(row, matchResult, matchStatus, allMatches = null, partialMatchInfo = null) {
  const enriched = {
    // Preserve ALL incoming fields first
    ...row,
    
    // Match fields added on top
    match_status: matchStatus,
    matched_sku: matchResult ? matchResult.sku : '',
    matched_name: matchResult ? matchResult.productName : '',
    matched_by: matchResult ? matchResult.matchedBy : '',
    matched_code: matchResult ? matchResult.matchedCode : '',
    match_confidence: matchResult ? matchResult.matchConfidence : '',
    vendor_provided_sku: row.sku || row.factory_code || '',
    sku_mismatch_flag: matchStatus === 'SKU_MISMATCH',
    master_cost: matchResult ? matchResult.cost : 0
  };
  
  if (matchStatus === 'PARTIAL_MATCH' && partialMatchInfo) {
    enriched.partial_match_reason = partialMatchInfo.reason;
    enriched.name_similarity = partialMatchInfo.nameSimilarity;
    enriched.price_diff_percentage = partialMatchInfo.priceDiff;
  }
  
  if (matchStatus === 'MULTIPLE_MATCH' && allMatches) {
    enriched.multiple_matches = allMatches.map(m => ({
      sku: m.sku,
      name: m.productName,
      matchedBy: m.matchedBy,
      matchedCode: m.matchedCode,
      cost: m.cost
    }));
  }
  
  return enriched;
} */

/**
 * Helper function to get sheet by name
 * Add error handling
 */
function getSheet_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }
  
  return sheet;
}

/**
 * API: Get Product Master List for Manual Selection
 * Returns simplified list of products for dropdown
 */
function apiGetProductMasterList() {
  try {
    const products = loadEEProductMaster_();
    
    // Return simplified list with only necessary fields
    const simplifiedList = products.map(p => ({
      sku: p.sku,
      productName: p.productName,
      cost: p.cost,
      ean: p.ean,
      articleNumber: p.articleNumber
    }));
    
    return {
      status: 'success',
      products: simplifiedList,
      count: simplifiedList.length
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.message || 'Failed to load product master',
      products: []
    };
  }
}


//---------------------------------API: Allocate shipment to open POs using FIFO -----------------------------



/**
 * API: Allocate shipment to open POs using FIFO
 */
function apiAllocateToOpenPOs(payload) {
  const { vendor_code, validated_rows } = payload;
  
  if (!vendor_code) throw new Error("vendor_code is required");
  if (!Array.isArray(validated_rows) || validated_rows.length === 0) {
    throw new Error("validated_rows is required");
  }
  
  // Get open POs for this vendor
  const openPOs = getOpenPOsForVendor_(vendor_code);
  
  const allocations = [];
  const now = new Date();
  
  // Process each SKU from shipment
  validated_rows.forEach(row => {
    //const sku = row.matched_sku || row.sku;
    const sku = row.resolution_action === 'REQUEST_NEW_SKU' ? '' : (row.matched_sku || row.sku);
    if (!sku) return; // Skip rows without SKU
    
    const allocation = {
      sku: sku,
      sku_name: row.matched_name || row.item_name,
      invoice_qty: Number(row.invoice_qty || 0),
      unit_price: Number(row.unit_price || row.invoice_unit_price_rmb || 0),
      po_allocations: [],
      total_allocated: 0,
      unallocated_qty: 0
    };
    
    let remainingQty = allocation.invoice_qty;
    
    // Find POs that have this SKU with pending qty
    openPOs.forEach(po => {
      if (remainingQty <= 0) return;
      
      // Find line in this PO for this SKU
      const poLine = po.lines.find(line => 
        String(line.sku).trim() === String(sku).trim()
      );
      
      if (!poLine) return;
      
      const orderedQty = Number(poLine.ordered_qty || 0);
      const fulfilledQty = Number(poLine.fulfilled_qty || 0);
      const pendingQty = orderedQty - fulfilledQty;
      
      if (pendingQty <= 0) return;
      
      // Allocate as much as possible to this PO
      const allocateQty = Math.min(remainingQty, pendingQty);
      
      // Calculate age
      const poDate = new Date(po.po_date);
      const ageDays = Math.floor((now - poDate) / (1000 * 60 * 60 * 24));
      
      allocation.po_allocations.push({
        po_id: po.po_id,
        po_date: po.po_date,
        age_days: ageDays,
        ordered_qty: orderedQty,
        fulfilled_qty: fulfilledQty,
        pending_qty: pendingQty,
        allocated_qty: allocateQty,
        will_be_fulfilled: (fulfilledQty + allocateQty) >= orderedQty
      });
      
      allocation.total_allocated += allocateQty;
      remainingQty -= allocateQty;
    });
    
    allocation.unallocated_qty = remainingQty;
    allocations.push(allocation);
  });
  
  // Calculate summary
  const summary = {
    total_skus: allocations.length,
    total_invoice_qty: allocations.reduce((sum, a) => sum + a.invoice_qty, 0),
    total_allocated: allocations.reduce((sum, a) => sum + a.total_allocated, 0),
    total_unallocated: allocations.reduce((sum, a) => sum + a.unallocated_qty, 0),
    pos_involved: [...new Set(allocations.flatMap(a => a.po_allocations.map(p => p.po_id)))]
  };
  
  return {
    status: 'success',
    allocations: allocations,
    summary: summary
  };
}

/**
 * Helper: Get open POs for vendor (FIFO sorted)
 */
function getOpenPOsForVendor_(vendorCode) {
  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();
  
  const poLineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const poLineHeader = getHeaderMap_(poLineSheet);
  const poLineData = poLineSheet.getDataRange().getValues();
  
  const openPOs = [];
  
  // Get open POs for this vendor
  for (let i = 1; i < poData.length; i++) {
    const row = poData[i];
    const poVendor = String(row[poHeader.vendor_code] || '').trim();
    const poStatus = String(row[poHeader.po_status] || '').trim();
    
    if (poVendor !== vendorCode) continue;
    if (poStatus !== 'OPEN' && poStatus !== 'PARTIALLY_SHIPPED') continue;
    
    const po = {
      po_id: row[poHeader.po_id],
      po_date: row[poHeader.po_date],
      vendor_code: poVendor,
      po_status: poStatus,
      lines: []
    };
    
    // Get lines for this PO
    for (let j = 1; j < poLineData.length; j++) {
      const lineRow = poLineData[j];
      if (String(lineRow[poLineHeader.po_id]).trim() !== po.po_id) continue;
      
      po.lines.push({
        sku: lineRow[poLineHeader.sku],
        sku_name: lineRow[poLineHeader.sku_name],
        ordered_qty: lineRow[poLineHeader.ordered_qty],
        fulfilled_qty: lineRow[poLineHeader.fulfilled_qty] || 0
      });
    }
    
    openPOs.push(po);
  }
  
  // Sort by PO date ASC (FIFO - oldest first)
  openPOs.sort((a, b) => {
    const dateA = new Date(a.po_date).getTime();
    const dateB = new Date(b.po_date).getTime();
    return dateA - dateB;
  });
  
  return openPOs;
}

//------------------- API: Get Review Data with reconciliation and warnings-----------------------------


function apiGetReviewData(payload) {
  const { vendor_code, validated_rows, allocations } = payload;
  
  if (!validated_rows || !allocations) {
    throw new Error("validated_rows and allocations are required");
  }
  
  // 1. Calculate Financial Reconciliation
  const reconciliation = calculateFinancialReconciliation_(validated_rows, allocations);
  
  // 2. Detect Warnings
  const warnings = detectWarnings_(validated_rows, allocations);
  
  // 3. Calculate Summary Stats
  const summary = {
    vendor_code: vendor_code,
    total_skus: allocations.length,
    total_invoice_qty: allocations.reduce((sum, a) => sum + Number(a.invoice_qty || 0), 0),
    total_allocated: allocations.reduce((sum, a) => sum + Number(a.total_allocated || 0), 0),
    total_unallocated: allocations.reduce((sum, a) => sum + Number(a.unallocated_qty || 0), 0),
    
    // PO statistics
    pos_fully_fulfilled: countFullyFulfilledPOs_(allocations),
    pos_partially_fulfilled: countPartiallyFulfilledPOs_(allocations),
    unique_pos_involved: getUniquePOs_(allocations)
  };
  
  // 4. Check if can proceed (no blocking warnings)
  const canProceed = !warnings.some(w => w.severity === 'BLOCKING');
  
  return {
    status: 'success',
    summary: summary,
    reconciliation: reconciliation,
    warnings: warnings,
    can_proceed: canProceed
  };
}

/**
 * Calculate financial reconciliation
 */
function calculateFinancialReconciliation_(validatedRows, allocations) {
  // Invoice total (from original invoice data)
  let invoiceTotal = 0;
  validatedRows.forEach(row => {
    const qty = Number(row.invoice_qty || 0);
    const price = Number(row.unit_price || row.invoice_unit_price_rmb || 0);
    invoiceTotal += (qty * price);
  });
  
  // Calculated total (based on allocated quantities only)
  let calculatedTotal = 0;
  allocations.forEach(alloc => {
    const allocatedQty = Number(alloc.total_allocated || 0);
    const price = Number(alloc.unit_price || 0);
    calculatedTotal += (allocatedQty * price);
  });
  
  // Calculate variance
  const difference = invoiceTotal - calculatedTotal;
  const percentageDiff = invoiceTotal !== 0 ? (difference / invoiceTotal) * 100 : 0;
  
  return {
    invoice_total: Math.round(invoiceTotal * 100) / 100,
    calculated_total: Math.round(calculatedTotal * 100) / 100,
    difference: Math.round(difference * 100) / 100,
    percentage_diff: Math.round(percentageDiff * 100) / 100,
    has_variance: Math.abs(percentageDiff) > 0.5 // 0.5% tolerance
  };
}

/**
 * Detect warnings and issues
 */
function detectWarnings_(validatedRows, allocations) {
  const warnings = [];
  
  // 1. Price Variance Warnings (from validation)
  const priceVariances = validatedRows.filter(row => {
    if (row.match_status === 'PARTIAL_MATCH' && row.price_diff_percentage) {
      return Math.abs(Number(row.price_diff_percentage)) > 10;
    }
    return false;
  });
  
  if (priceVariances.length > 0) {
    warnings.push({
      type: 'PRICE_VARIANCE',
      severity: 'WARNING',
      count: priceVariances.length,
      message: priceVariances.length + ' items with price variance > 10%',
      items: priceVariances.map(r => ({
        sku: r.matched_sku || r.sku,
        item_name: r.matched_name || r.item_name,
        variance_percentage: r.price_diff_percentage
      }))
    });
  }
  
  // 2. Unallocated SKUs
  const unallocatedItems = allocations.filter(a => Number(a.unallocated_qty || 0) > 0);
  
  if (unallocatedItems.length > 0) {
    const totalUnallocatedQty = unallocatedItems.reduce((sum, a) => 
      sum + Number(a.unallocated_qty || 0), 0
    );
    
    warnings.push({
      type: 'UNALLOCATED',
      severity: 'WARNING',
      count: unallocatedItems.length,
      message: unallocatedItems.length + ' SKUs have unallocated quantities (' + totalUnallocatedQty + ' units)',
      items: unallocatedItems.map(a => ({
        sku: a.sku,
        item_name: a.sku_name,
        unallocated_qty: a.unallocated_qty,
        invoice_qty: a.invoice_qty
      }))
    });
  }
  
  // 3. Flagged Items (BLOCKING)
  const flaggedItems = validatedRows.filter(row => 
    row.resolution_action === 'FLAG_REVIEW'
  );
  
  if (flaggedItems.length > 0) {
    warnings.push({
      type: 'FLAGGED_ITEMS',
      severity: 'BLOCKING',
      count: flaggedItems.length,
      message: flaggedItems.length + ' items flagged for review (must be resolved)',
      items: flaggedItems.map(r => ({
        sku: r.matched_sku || r.sku,
        item_name: r.matched_name || r.item_name,
        match_status: r.match_status,
        resolution_notes: r.resolution_notes
      }))
    });
  }
  
  // 4. Items without PO at all (no allocation possible)
  const noPOItems = allocations.filter(a => 
    a.po_allocations.length === 0 && Number(a.unallocated_qty || 0) > 0
  );
  
  if (noPOItems.length > 0) {
    warnings.push({
      type: 'NO_PO',
      severity: 'WARNING',
      count: noPOItems.length,
      message: noPOItems.length + ' SKUs have no open purchase orders',
      items: noPOItems.map(a => ({
        sku: a.sku,
        item_name: a.sku_name,
        qty: a.invoice_qty
      }))
    });
  }
  
  return warnings;
}

/**
 * Helper: Count fully fulfilled POs
 */
function countFullyFulfilledPOs_(allocations) {
  const fulfilledPOs = new Set();
  
  allocations.forEach(alloc => {
    if (alloc.po_allocations) {
      alloc.po_allocations.forEach(po => {
        if (po.will_be_fulfilled === true) {
          fulfilledPOs.add(po.po_id);
        }
      });
    }
  });
  
  return fulfilledPOs.size;
}

/**
 * Helper: Count partially fulfilled POs
 */
function countPartiallyFulfilledPOs_(allocations) {
  const partialPOs = new Set();
  
  allocations.forEach(alloc => {
    if (alloc.po_allocations) {
      alloc.po_allocations.forEach(po => {
        if (po.will_be_fulfilled === false && Number(po.allocated_qty || 0) > 0) {
          partialPOs.add(po.po_id);
        }
      });
    }
  });
  
  return partialPOs.size;
}

/**
 * Helper: Get unique PO list
 */
function getUniquePOs_(allocations) {
  const allPOs = [];
  
  allocations.forEach(alloc => {
    if (alloc.po_allocations) {
      alloc.po_allocations.forEach(po => {
        allPOs.push(po.po_id);
      });
    }
  });
  
  return [...new Set(allPOs)];
}




/////---------------------------------Shipment Creation + Batch Creation------------------
/**
 * Generate next Batch ID with separate sequences for Sea/Air
 */
function generateBatchId_(batchType) {
  const sheet = getSheet_(SHEET_NAMES.BATCHES);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();
  
  const year = String(new Date().getFullYear()).slice(-2); // "26"
  const prefix = batchType === 'AIR' ? 'A' : 'S';
  // Format: A-26001, A-26002 — prefix is "A-26"
  const batchPrefix = `${prefix}-${year}`;
  
  let maxSeq = 0;
  
  for (let i = 1; i < data.length; i++) {
    const batchId = String(data[i][header.batch_id] || '').trim();
    if (batchId.startsWith(batchPrefix)) {
      // "A-26001" → remove "A-26" → "001" → parseInt = 1
      const seqStr = batchId.slice(batchPrefix.length);
      const seq = parseInt(seqStr, 10);
      if (!isNaN(seq)) {
        maxSeq = Math.max(maxSeq, seq);
      }
    }
  }
  
  const nextSeq = String(maxSeq + 1).padStart(3, '0');
  return `${batchPrefix}${nextSeq}`; // A-26001, A-26002, A-26003...
}

/**
 * Create new batch record
 */
function apiCreateBatch_(batchType, createdBy) {
  const batchId = generateBatchId_(batchType);
  const now = new Date();
  
  const sheet = getSheet_(SHEET_NAMES.BATCHES);
  const header = getHeaderMap_(sheet);
  
  // Guard — if batch ID already exists, return it without creating a duplicate
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][header.batch_id]).trim() === batchId) {
      Logger.log('Batch already exists, skipping creation: ' + batchId);
      return batchId;
    }
  }
  
  appendRowFromObject_(sheet, header, {
    batch_id: batchId,
    batch_type: batchType,
    status: 'OPEN',
    total_shipments: 0,
    total_vendors: 0,
    total_cartons: 0,
    total_amount: 0,
    total_currency: 'RMB',
    created_at: now,
    created_by: createdBy,
    shipped_at: '',
    expected_delivery: '',
    actual_delivery: '',
    tracking_number: '',
    carrier: '',
    notes: ''
  });
  
  return batchId;
}
/**
 * Get open batches (not delivered yet)
 */
function apiGetOpenBatches(payload) {
  const { batch_type } = payload; // Optional filter by SEA/AIR
  
  const sheet = getSheet_(SHEET_NAMES.BATCHES);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();
  
  const batches = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = String(row[header.status] || '').toUpperCase();
    const type = String(row[header.batch_type] || '').toUpperCase();
    
    // Filter: status not DELIVERED or CLOSED
    if (status === 'DELIVERED' || status === 'CLOSED') continue;
    
    // Optional: filter by batch_type
    if (batch_type && type !== batch_type.toUpperCase()) continue;
    
    batches.push({
      batch_id: row[header.batch_id],
      batch_type: type,
      status: status,
      total_shipments: row[header.total_shipments] || 0,
      total_cartons: row[header.total_cartons] || 0,
      created_at: row[header.created_at]
    });
  }
  
  return {
    status: 'success',
    batches: batches
  };
}

/**
 * Update batch totals after adding shipment
 */
function updateBatchTotals_(batchId, cartonCount, amount, vendorCode, carrier, expectedDelivery) {
  const sheet = getSheet_(SHEET_NAMES.BATCHES);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][header.batch_id]).trim() === batchId) {
      const currentShipments = Number(data[i][header.total_shipments] || 0);
      const currentCartons = Number(data[i][header.total_cartons] || 0);
      const currentAmount = Number(data[i][header.total_amount] || 0);
      
      // Recalculate unique vendors properly from Vendor_Shipments sheet
      const shipmentSheet2 = getSheet_(SHEET_NAMES.VENDOR_SHIPMENTS);
      const shipmentHeader2 = getHeaderMap_(shipmentSheet2);
      const shipmentData2 = shipmentSheet2.getDataRange().getValues();
      const vendorsInBatch = new Set();
      for (let j = 1; j < shipmentData2.length; j++) {
        if (String(shipmentData2[j][shipmentHeader2.batch_id] || '').trim() === batchId) {
          vendorsInBatch.add(String(shipmentData2[j][shipmentHeader2.vendor_code] || '').trim());
        }
      }
      vendorsInBatch.add(vendorCode); // Include current shipment's vendor
      
      updateRowByKey_(sheet, header, 'batch_id', batchId, {
        total_shipments: currentShipments + 1,
        total_cartons: currentCartons + cartonCount,
        total_amount: currentAmount + amount,
        total_vendors: vendorsInBatch.size,
        total_currency: 'RMB',
        carrier: carrier || '',
        expected_delivery: expectedDelivery ? new Date(expectedDelivery) : ''
      });
      
      return true;
    }
  }
  
  return false;
}

/**
 * Generate shipment ID
 */
function generateShipmentId_(vendorCode, date) {
  const sheet = getSheet_(SHEET_NAMES.VENDOR_SHIPMENTS);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();
  
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  
  const dateKey = `${yy}${mm}${dd}`;
  const prefix = `VS-${vendorCode}${dateKey}-`;
  
  let maxSeq = 0;
  
  for (let i = 1; i < data.length; i++) {
    const shipmentId = String(data[i][header.shipment_id] || '');
    if (shipmentId.startsWith(prefix)) {
      const parts = shipmentId.split('-');
      const seq = Number(parts[parts.length - 1]);
      if (!isNaN(seq)) {
        maxSeq = Math.max(maxSeq, seq);
      }
    }
  }
  
  return `${prefix}${maxSeq + 1}`;
}

/**
 * Update PO line fulfillment
 */
function updatePOLineFulfillment_(poId, sku, allocatedQty) {
  const sheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const header = getHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[header.po_id]).trim() === poId && 
        String(row[header.sku]).trim() === sku) {
      
      const currentFulfilled = Number(row[header.fulfilled_qty] || 0);
      const orderedQty = Number(row[header.ordered_qty] || 0);
      const newFulfilled = currentFulfilled + allocatedQty;
      
      // Determine line status
      let lineStatus = 'OPEN';
      if (newFulfilled >= orderedQty) {
        lineStatus = 'FULFILLED';
      } else if (newFulfilled > 0) {
        lineStatus = 'PARTIAL';
      }
      
      // Update the row
      data[i][header.fulfilled_qty] = newFulfilled;
      data[i][header.line_status] = lineStatus;
      data[i][header.updated_at] = new Date();
      
      sheet.getRange(i + 1, 1, 1, data[0].length).setValues([data[i]]);
      return true;
    }
  }
  
  return false;
}

/**
 * Update PO status based on all lines
 */
function updatePOStatus_(poId) {
  const lineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  const lineData = lineSheet.getDataRange().getValues();
  
  let allFulfilled = true;
  let anyFulfilled = false;
  
  // Check all lines for this PO
  for (let i = 1; i < lineData.length; i++) {
    if (String(lineData[i][lineHeader.po_id]).trim() === poId) {
      const orderedQty = Number(lineData[i][lineHeader.ordered_qty] || 0);
      const fulfilledQty = Number(lineData[i][lineHeader.fulfilled_qty] || 0);
      
      if (fulfilledQty < orderedQty) {
        allFulfilled = false;
      }
      if (fulfilledQty > 0) {
        anyFulfilled = true;
      }
    }
  }
  
  // Determine PO status
  let poStatus = 'OPEN';
  if (allFulfilled) {
    poStatus = 'CLOSED';
  } else if (anyFulfilled) {
    poStatus = 'PARTIALLY_SHIPPED';
  }
  
  // Update PO
  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  
  updateRowByKey_(poSheet, poHeader, 'po_id', poId, {
    po_status: poStatus,
    updated_at: new Date()
  });
}

/**
 * API: Create Vendor Shipment
 */
function apiCreateVendorShipment(payload) {
  const {
    vendor_code,
    shipment_date,
    batch_option,
    batch_id,
    batch_type,
    carton_count,
    total_amount,
    notes,
    invoice_no,
    invoice_date,
    carrier,
    expected_delivery,
    validated_rows,
    allocations
  } = payload;
  
  // Validations
  if (!vendor_code) throw new Error("Vendor code is required");
  if (!shipment_date) throw new Error("Shipment date is required");
  if (!batch_option) throw new Error("Batch option is required");
  if (batch_option === 'existing' && !batch_id) {
    throw new Error("Please select a batch");
  }
  if (batch_option === 'new' && !batch_type) {
    throw new Error("Batch type is required for new batch");
  }
  if (!carton_count || carton_count <= 0) {
    throw new Error("Carton count must be greater than 0");
  }
  if (!total_amount || total_amount <= 0) {
    throw new Error("Total amount must be greater than 0");
  }
  
  const now = new Date();
  const userEmail = Session.getActiveUser().getEmail();
  
  // Create or use batch
  let finalBatchId = batch_id;
  if (batch_option === 'new') {
    finalBatchId = apiCreateBatch_(batch_type, userEmail);
  }
  
  // Generate shipment ID
  const shipmentId = generateShipmentId_(vendor_code, new Date(shipment_date));
  
  // Get sheets
  const shipmentSheet = getSheet_(SHEET_NAMES.VENDOR_SHIPMENTS);
  const shipmentHeader = getHeaderMap_(shipmentSheet);
  
  const lineSheet = getSheet_(SHEET_NAMES.VENDOR_SHIPMENT_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  
  // Create shipment header
  appendRowFromObject_(shipmentSheet, shipmentHeader, {
    shipment_id: shipmentId,
    batch_id: finalBatchId,
    vendor_code: vendor_code,
    po_id: '',
    status: 'SHIPPED',
    invoice_no: invoice_no || '',
    invoice_date: invoice_date ? new Date(invoice_date) : '',
    total_amount: total_amount,
    carton_count: carton_count,
    carrier: carrier || '',
    expected_delivery: expected_delivery ? new Date(expected_delivery) : '',
    remarks: notes || '',
    created_at: now,
    submitted_at: now
  });

// FIX B — Delete orphaned DRAFT/NORMALIZED rows
// Re-read sheet fresh after appending the SHIPPED row
const freshShipData = shipmentSheet.getDataRange().getValues();
const freshHeaders = freshShipData[0];
const sidColIdx = freshHeaders.indexOf('shipment_id');
const statusColIdx = freshHeaders.indexOf('status');
const vendorColIdx = freshHeaders.indexOf('vendor_code');

// Iterate bottom-up so deletions don't shift indices
for (let i = freshShipData.length - 1; i >= 1; i--) {
  const rowShipmentId = String(freshShipData[i][sidColIdx] || '').trim();
  const rowStatus = String(freshShipData[i][statusColIdx] || '').trim();
  const rowVendor = String(freshShipData[i][vendorColIdx] || '').trim();

  if (
    rowVendor === vendor_code &&
    rowStatus === 'NORMALIZED' &&
    rowShipmentId !== shipmentId
  ) {
    shipmentSheet.deleteRow(i + 1);
  }
}

  // Create shipment lines from validated_rows (ALL items including unallocated)
  // validated_rows.forEach(row => {
  //   const unitPrice = Number(row.unit_price_total || row.unit_price || 0);
  //   const qty = Number(row.invoice_qty || 0);

  //   appendRowFromObject_(lineSheet, lineHeader, {
  //     shipment_id: shipmentId,
  //     batch_id: finalBatchId,
  //     line_id: Utilities.getUuid(),
  //     sku: row.matched_sku || row.sku,
  //     item_name: row.matched_name || row.item_name,
  //     factory_code: row.factory_code || '',
  //     ean: row.ean || '',
  //     invoice_qty: qty,

  //     // PRIMARY — always used by rest of system
  //     unit_price: unitPrice,
  //     total_price: qty * unitPrice,

  //     // BREAKDOWN — supplementary, 0 if not bifurcated
  //     unit_price_base: Number(row.unit_price_base || unitPrice),
  //     unit_price_box: Number(row.unit_price_box || 0),
  //     unit_price_blister: Number(row.unit_price_blister || 0),
  //     unit_price_manual: Number(row.unit_price_manual || 0),
  //     unit_price_total: unitPrice,

  //     validation_status: row.match_status || '',
  //     validation_notes: row.resolution_notes || ''
  //   });
  // });

  // Build a SKU → po_ids map from allocations
  const skuPoMap = {};
  if (allocations && Array.isArray(allocations)) {
  allocations.forEach(alloc => {
    if (alloc.sku && alloc.po_allocations && alloc.po_allocations.length > 0) {
      const poIds = alloc.po_allocations
        .filter(pa => pa.allocated_qty > 0)
        .map(pa => pa.po_id)
        .filter(Boolean);
      if (poIds.length > 0) {
        skuPoMap[alloc.sku] = poIds.join(',');
      }
    }
  });
}

// Create shipment lines from validated_rows
validated_rows.forEach(row => {
  const unitPrice = Number(row.unit_price_total || row.unit_price || 0);
  const qty = Number(row.invoice_qty || 0);
  const sku = row.matched_sku || row.sku || '';

  // Look up allocated PO IDs for this SKU
  const allocatedPoIds = skuPoMap[sku] || '';

  appendRowFromObject_(lineSheet, lineHeader, {
    shipment_id: shipmentId,
    batch_id: finalBatchId,
    line_id: Utilities.getUuid(),
    sku: sku,
    po_id: allocatedPoIds,          // ← NEW — comma-separated PO IDs
    item_name: row.matched_name || row.item_name,
    factory_code: row.factory_code || '',
    ean: row.ean || '',
    invoice_qty: qty,
    unit_price: unitPrice,
    total_price: qty * unitPrice,
    unit_price_base: Number(row.unit_price_base || unitPrice),
    unit_price_box: Number(row.unit_price_box || 0),
    unit_price_blister: Number(row.unit_price_blister || 0),
    unit_price_manual: Number(row.unit_price_manual || 0),
    unit_price_total: unitPrice,
    validation_status: row.match_status || '',
    validation_notes: row.resolution_notes || ''
  });
});
  // Update PO fulfillment from allocations
  const affectedPOs = new Set();
  
  allocations.forEach(alloc => {
    if (alloc.po_allocations && alloc.po_allocations.length > 0) {
      alloc.po_allocations.forEach(po => {
        updatePOLineFulfillment_(po.po_id, alloc.sku, po.allocated_qty);
        affectedPOs.add(po.po_id);
      });
    }
  });
  
  // Update PO statuses
  affectedPOs.forEach(poId => {
    updatePOStatus_(poId);
  });
  
   // Update batch totals
  updateBatchTotals_(finalBatchId, carton_count, total_amount, vendor_code, carrier, expected_delivery);

  // Push to EasyEcom as in-transit PO
  const eeResult = pushShipmentToEasyEcom_(shipmentId, vendor_code, expected_delivery, validated_rows);
  Logger.log('EasyEcom push result: ' + JSON.stringify(eeResult));

  // Write any REQUEST_NEW_SKU rows to New_SKU_Requests sheet
  const skuReqResult = writeNewSKURequests_(shipmentId, vendor_code, validated_rows, userEmail);
  Logger.log('SKU requests written: ' + JSON.stringify(skuReqResult));

    // ── NEW: Update Item ID and Pricing in EasyEcom master ──
  const updateItems = validated_rows
    .filter(r => r.resolution_update_id || r.resolution_update_price)
    .map(r => ({
      sku: r.matched_sku || r.sku,
      factory_code: r.resolution_update_id && r.factory_code
        ? String(r.factory_code).split('|')[0].trim()
        : '',
      rmb_price: r.resolution_update_price ? (r.unit_price || null) : null
    }))
    .filter(r => r.sku);

  if (updateItems.length > 0) {
    Logger.log('Calling updateCustomFieldsSmart with: ' + JSON.stringify(updateItems));
    updateCustomFieldsSmart(updateItems);
  }

  return {
    status: 'success',
    shipment_id: shipmentId,
    batch_id: finalBatchId,
    updated_pos: Array.from(affectedPOs),
    ee_push: eeResult.success ? 'PUSHED' : 'FAILED',
    ee_po_id: eeResult.poId || '',
    sku_requests_created: skuReqResult.count || 0,
    message: `Shipment ${shipmentId} created successfully`
  };
}



//----------------------------------Batch Code----------------------------------
/*
function getBatches() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var batchesSheet = ss.getSheetByName('Batches');
    var shipmentsSheet = ss.getSheetByName('Vendor_Shipments');
    var linesSheet = ss.getSheetByName('Vendor_Shipment_Lines');
    
    var batchesData = batchesSheet.getDataRange().getValues();
    var shipmentsData = shipmentsSheet.getDataRange().getValues();
    var linesData = linesSheet.getDataRange().getValues();
    
    var batchHeaders = batchesData[0];
    var shipmentHeaders = shipmentsData[0];
    var lineHeaders = linesData[0];
    
    var batchIdCol = batchHeaders.indexOf('batch_id');
    var batchTypeCol = batchHeaders.indexOf('batch_type');
    var statusCol = batchHeaders.indexOf('status');
    var createdAtCol = batchHeaders.indexOf('created_at');
    var createdByCol = batchHeaders.indexOf('created_by');
    var shippedAtCol = batchHeaders.indexOf('shipped_at');
    var expectedDeliveryCol = batchHeaders.indexOf('expected_delivery');
    var actualDeliveryCol = batchHeaders.indexOf('actual_delivery');
    var trackingCol = batchHeaders.indexOf('tracking_number');
    var carrierCol = batchHeaders.indexOf('carrier');
    var notesCol = batchHeaders.indexOf('notes');
    
    var shipBatchIdCol = shipmentHeaders.indexOf('batch_id');
    var shipmentIdCol = shipmentHeaders.indexOf('shipment_id');
    var vendorCodeCol = shipmentHeaders.indexOf('vendor_code');
    var cartonCountCol = shipmentHeaders.indexOf('carton_count');
    
    var lineShipmentIdCol = lineHeaders.indexOf('shipment_id');
    var lineQtyCol = lineHeaders.indexOf('invoice_qty');
    
    var batches = [];
    var today = new Date();
    
    for (var i = 1; i < batchesData.length; i++) {
      var batchId = batchesData[i][batchIdCol];
      if (!batchId) continue;
      
      var batchShipments = [];
      for (var j = 1; j < shipmentsData.length; j++) {
        if (shipmentsData[j][shipBatchIdCol] === batchId) {
          batchShipments.push(shipmentsData[j]);
        }
      }
      
      var totalShipments = batchShipments.length;
      
      var vendorSet = {};
      for (var k = 0; k < batchShipments.length; k++) {
        vendorSet[batchShipments[k][vendorCodeCol]] = true;
      }
      var totalVendors = Object.keys(vendorSet).length;
      
      var totalCartons = 0;
      for (var k = 0; k < batchShipments.length; k++) {
        totalCartons += Number(batchShipments[k][cartonCountCol]) || 0;
      }
      
      var shipmentIds = [];
      for (var k = 0; k < batchShipments.length; k++) {
        shipmentIds.push(batchShipments[k][shipmentIdCol]);
      }
      
      var totalUnits = 0;
      for (var j = 1; j < linesData.length; j++) {
        if (shipmentIds.indexOf(linesData[j][lineShipmentIdCol]) !== -1) {
          totalUnits += Number(linesData[j][lineQtyCol]) || 0;
        }
      }
      
      var expectedDelivery = batchesData[i][expectedDeliveryCol];
      var actualDelivery = batchesData[i][actualDeliveryCol];
      var isDelayed = false;
      var delayDays = 0;
      
      if (expectedDelivery && !actualDelivery) {
        var expectedDate = new Date(expectedDelivery);
        if (today > expectedDate) {
          isDelayed = true;
          delayDays = Math.floor((today - expectedDate) / (1000 * 60 * 60 * 24));
        }
      }
      
      batches.push({
        batch_id: batchId,
        //batch_type: batchesData[i][batchTypeCol] || 'sea',
        batch_type: (batchesData[i][batchTypeCol] || 'sea').toLowerCase(),
        status: batchesData[i][statusCol] || 'Shipped',
        total_shipments: totalShipments,
        total_vendors: totalVendors,
        total_cartons: totalCartons,
        total_units: totalUnits,
        created_at: batchesData[i][createdAtCol] ? batchesData[i][createdAtCol].toISOString() : null,
        created_by: batchesData[i][createdByCol] || '',
        shipped_at: batchesData[i][shippedAtCol] ? batchesData[i][shippedAtCol].toISOString() : null,
        expected_delivery: expectedDelivery ? expectedDelivery.toISOString() : null,
        actual_delivery: actualDelivery ? actualDelivery.toISOString() : null,
        tracking_number: batchesData[i][trackingCol] || '',
        carrier: batchesData[i][carrierCol] || '',
        notes: batchesData[i][notesCol] || '',
        is_delayed: isDelayed,
        delay_days: delayDays
      });
    }
    
    var activeBatches = 0;
    var inTransitValue = 0;
    var delayedShipments = 0;
    
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].status !== 'Delivered') {
        activeBatches++;
        inTransitValue += batches[i].total_units * 100;
      }
      if (batches[i].is_delayed) {
        delayedShipments++;
      }
    }
    
    var arrivingThisWeek = 0;
    var weekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].expected_delivery && !batches[i].actual_delivery) {
        var expected = new Date(batches[i].expected_delivery);
        if (expected >= today && expected <= weekFromNow) {
          arrivingThisWeek++;
        }
      }
    }
    
    return {
      status: 'success',
      batches: batches,
      metrics: {
        activeBatches: activeBatches,
        inTransitValue: inTransitValue,
        arrivingThisWeek: arrivingThisWeek,
        delayedShipments: delayedShipments
      }
    };

    
  } catch (error) {
    Logger.log('Error in getBatches: ' + error.toString());
    throw new Error('Failed to fetch batches: ' + error.message);
  }
}*/
function getBatches() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var batchesSheet = ss.getSheetByName('Batches');
    var shipmentsSheet = ss.getSheetByName('Vendor_Shipments');
    var linesSheet = ss.getSheetByName('Vendor_Shipment_Lines');
    
    var batchesData = batchesSheet.getDataRange().getValues();
    var shipmentsData = shipmentsSheet.getDataRange().getValues();
    var linesData = linesSheet.getDataRange().getValues();
    
    var batchHeaders = batchesData[0];
    var shipmentHeaders = shipmentsData[0];
    var lineHeaders = linesData[0];
    
    var batchIdCol = batchHeaders.indexOf('batch_id');
    var batchTypeCol = batchHeaders.indexOf('batch_type');
    var statusCol = batchHeaders.indexOf('status');
    var createdAtCol = batchHeaders.indexOf('created_at');
    var createdByCol = batchHeaders.indexOf('created_by');
    var shippedAtCol = batchHeaders.indexOf('shipped_at');
    var expectedDeliveryCol = batchHeaders.indexOf('expected_delivery');
    var actualDeliveryCol = batchHeaders.indexOf('actual_delivery');
    var trackingCol = batchHeaders.indexOf('tracking_number');
    var carrierCol = batchHeaders.indexOf('carrier');
    var notesCol = batchHeaders.indexOf('notes');
    
    var shipBatchIdCol = shipmentHeaders.indexOf('batch_id');
    var shipmentIdCol = shipmentHeaders.indexOf('shipment_id');
    var vendorCodeCol = shipmentHeaders.indexOf('vendor_code');
    var cartonCountCol = shipmentHeaders.indexOf('carton_count');
    var invoiceNoCol = shipmentHeaders.indexOf('invoice_no');
    var invoiceDateCol = shipmentHeaders.indexOf('invoice_date');
    
    var lineShipmentIdCol = lineHeaders.indexOf('shipment_id');
    var lineQtyCol = lineHeaders.indexOf('invoice_qty');

    // ── Build units per shipment map upfront ──────────────────
    var unitsPerShipment = {};
    for (var j = 1; j < linesData.length; j++) {
      var lineShipId = String(linesData[j][lineShipmentIdCol] || '').trim();
      if (lineShipId) {
        unitsPerShipment[lineShipId] = (unitsPerShipment[lineShipId] || 0) + (Number(linesData[j][lineQtyCol]) || 0);
      }
    }
    
    var batches = [];
    var today = new Date();
    
    for (var i = 1; i < batchesData.length; i++) {
      var batchId = batchesData[i][batchIdCol];
      if (!batchId) continue;
      
      // Find shipments for this batch
      var batchShipments = [];
      for (var j = 1; j < shipmentsData.length; j++) {
        if (shipmentsData[j][shipBatchIdCol] === batchId) {
          batchShipments.push(shipmentsData[j]);
        }
      }
      
      var totalShipments = batchShipments.length;
      
      var vendorSet = {};
      for (var k = 0; k < batchShipments.length; k++) {
        vendorSet[batchShipments[k][vendorCodeCol]] = true;
      }
      var totalVendors = Object.keys(vendorSet).length;
      
      var totalCartons = 0;
      for (var k = 0; k < batchShipments.length; k++) {
        totalCartons += Number(batchShipments[k][cartonCountCol]) || 0;
      }

      // Total units for this batch using pre-built map
      var totalUnits = 0;
      for (var k = 0; k < batchShipments.length; k++) {
        var sid = String(batchShipments[k][shipmentIdCol] || '').trim();
        totalUnits += unitsPerShipment[sid] || 0;
      }

      // ── Build vendor_summary with full fields ─────────────
      var vendorSummary = [];
      for (var k = 0; k < batchShipments.length; k++) {
        var shipId = String(batchShipments[k][shipmentIdCol] || '').trim();
        var invDate = batchShipments[k][invoiceDateCol];
        vendorSummary.push({
          vendor_code: batchShipments[k][vendorCodeCol] || '',
          shipment_id: shipId,
          carton_count: Number(batchShipments[k][cartonCountCol]) || 0,
          invoice_no: batchShipments[k][invoiceNoCol] || '',
          invoice_date: invDate ? Utilities.formatDate(new Date(invDate), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '',
          total_units: unitsPerShipment[shipId] || 0
        });
      }
      
      var expectedDelivery = batchesData[i][expectedDeliveryCol];
      var actualDelivery = batchesData[i][actualDeliveryCol];
      var isDelayed = false;
      var delayDays = 0;
      
      if (expectedDelivery && !actualDelivery) {
        var expectedDate = new Date(expectedDelivery);
        if (today > expectedDate) {
          isDelayed = true;
          delayDays = Math.floor((today - expectedDate) / (1000 * 60 * 60 * 24));
        }
      }
      
      batches.push({
        batch_id: batchId,
        batch_type: (batchesData[i][batchTypeCol] || 'sea').toLowerCase(),
        status: batchesData[i][statusCol] || 'Shipped',
        total_shipments: totalShipments,
        total_vendors: totalVendors,
        total_cartons: totalCartons,
        total_units: totalUnits,
        created_at: batchesData[i][createdAtCol] ? batchesData[i][createdAtCol].toISOString() : null,
        created_by: batchesData[i][createdByCol] || '',
        shipped_at: batchesData[i][shippedAtCol] ? batchesData[i][shippedAtCol].toISOString() : null,
        expected_delivery: expectedDelivery ? expectedDelivery.toISOString() : null,
        actual_delivery: actualDelivery ? actualDelivery.toISOString() : null,
        tracking_number: batchesData[i][trackingCol] || '',
        carrier: batchesData[i][carrierCol] || '',
        notes: batchesData[i][notesCol] || '',
        is_delayed: isDelayed,
        delay_days: delayDays,
        vendor_summary: vendorSummary
      });
    }
    
    var activeBatches = 0;
    var inTransitValue = 0;
    var delayedShipments = 0;
    
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].status !== 'Delivered') {
        activeBatches++;
        inTransitValue += batches[i].total_units * 100;
      }
      if (batches[i].is_delayed) {
        delayedShipments++;
      }
    }
    
    var arrivingThisWeek = 0;
    var weekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].expected_delivery && !batches[i].actual_delivery) {
        var expected = new Date(batches[i].expected_delivery);
        if (expected >= today && expected <= weekFromNow) {
          arrivingThisWeek++;
        }
      }
    }
    
    return {
      status: 'success',
      batches: batches,
      metrics: {
        activeBatches: activeBatches,
        inTransitValue: inTransitValue,
        arrivingThisWeek: arrivingThisWeek,
        delayedShipments: delayedShipments
      }
    };
    
  } catch (error) {
    Logger.log('Error in getBatches: ' + error.toString());
    throw new Error('Failed to fetch batches: ' + error.message);
  }
}

/*
function getBatchDetails(batchId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var batchesSheet = ss.getSheetByName('Batches');
    var shipmentsSheet = ss.getSheetByName('Vendor_Shipments');
    var linesSheet = ss.getSheetByName('Vendor_Shipment_Lines');
    var productSheet = ss.getSheetByName('EE Product Master');
    
    var batchesData = batchesSheet.getDataRange().getValues();
    var shipmentsData = shipmentsSheet.getDataRange().getValues();
    var linesData = linesSheet.getDataRange().getValues();
    var productData = productSheet.getDataRange().getValues();
    
    var batchHeaders = batchesData[0];
    var shipmentHeaders = shipmentsData[0];
    var lineHeaders = linesData[0];
    var productHeaders = productData[0];
    
    var batchIdCol = batchHeaders.indexOf('batch_id');
    var batchRow = null;
    
    for (var i = 1; i < batchesData.length; i++) {
      if (batchesData[i][batchIdCol] === batchId) {
        batchRow = batchesData[i];
        break;
      }
    }
    
    if (!batchRow) {
      return null;
    }
    
    var batch = {
      batch_id: batchId,
      //batch_type: batchRow[batchHeaders.indexOf('batch_type')] || 'sea',
      batch_type: (batchRow[batchHeaders.indexOf('batch_type')] || 'sea').toLowerCase(),
      status: batchRow[batchHeaders.indexOf('status')] || 'Shipped',
      created_at: batchRow[batchHeaders.indexOf('created_at')] ? batchRow[batchHeaders.indexOf('created_at')].toISOString() : null,
      created_by: batchRow[batchHeaders.indexOf('created_by')] || '',
      shipped_at: batchRow[batchHeaders.indexOf('shipped_at')] ? batchRow[batchHeaders.indexOf('shipped_at')].toISOString() : null,
      expected_delivery: batchRow[batchHeaders.indexOf('expected_delivery')] ? batchRow[batchHeaders.indexOf('expected_delivery')].toISOString() : null,
      actual_delivery: batchRow[batchHeaders.indexOf('actual_delivery')] ? batchRow[batchHeaders.indexOf('actual_delivery')].toISOString() : null,
      tracking_number: batchRow[batchHeaders.indexOf('tracking_number')] || '',
      carrier: batchRow[batchHeaders.indexOf('carrier')] || '',
      notes: batchRow[batchHeaders.indexOf('notes')] || ''
    };
    
    var shipBatchIdCol = shipmentHeaders.indexOf('batch_id');
    var shipmentIdCol = shipmentHeaders.indexOf('shipment_id');
    var vendorCodeCol = shipmentHeaders.indexOf('vendor_code');
    var invoiceNoCol = shipmentHeaders.indexOf('invoice_no');
    var invoiceDateCol = shipmentHeaders.indexOf('invoice_date');
    var cartonCountCol = shipmentHeaders.indexOf('carton_count');
    var remarksCol = shipmentHeaders.indexOf('remarks');
    
    var batchShipments = [];
    for (var i = 1; i < shipmentsData.length; i++) {
      if (shipmentsData[i][shipBatchIdCol] === batchId) {
        batchShipments.push(shipmentsData[i]);
      }
    }
    
    var vendorShipments = [];
    
    for (var i = 0; i < batchShipments.length; i++) {
      var shipment = batchShipments[i];
      var shipmentId = shipment[shipmentIdCol];
      var vendorCode = shipment[vendorCodeCol];
      var invoiceNo = shipment[invoiceNoCol];
      var invoiceDate = shipment[invoiceDateCol];
      var cartonCount = shipment[cartonCountCol] || 0;
      var remarks = shipment[remarksCol] || '';
      
      var lineShipmentIdCol = lineHeaders.indexOf('shipment_id');
      var lineIdCol = lineHeaders.indexOf('line_id');
      var skuCol = lineHeaders.indexOf('sku');
      var itemNameCol = lineHeaders.indexOf('item_name');
      var factoryCodeCol = lineHeaders.indexOf('factory_code');
      var eanCol = lineHeaders.indexOf('ean');
      var invoiceQtyCol = lineHeaders.indexOf('invoice_qty');
      
      var shipmentLines = [];
      for (var j = 1; j < linesData.length; j++) {
        if (linesData[j][lineShipmentIdCol] === shipmentId) {
          shipmentLines.push(linesData[j]);
        }
      }
      
      var lineItems = [];
      var totalUnits = 0;
      
      for (var j = 0; j < shipmentLines.length; j++) {
        var line = shipmentLines[j];
        var sku = line[skuCol];
        var itemName = line[itemNameCol];
        var factoryCode = line[factoryCodeCol] || '';
        var ean = line[eanCol] || '';
        var incomingQty = Number(line[invoiceQtyCol]) || 0;
        
        totalUnits += incomingQty;
        
        var productSkuCol = productHeaders.indexOf('sku');
        var productInventoryCol = productHeaders.indexOf('inventory');
        var productRow = null;
        
        for (var k = 1; k < productData.length; k++) {
          if (productData[k][productSkuCol] === sku) {
            productRow = productData[k];
            break;
          }
        }
        
        var currentStock = productRow ? (Number(productRow[productInventoryCol]) || 0) : 0;
        var futureStock = currentStock + incomingQty;
        
        lineItems.push({
          line_id: line[lineIdCol] || '',
          sku: sku,
          item_name: itemName,
          factory_code: factoryCode,
          ean: ean,
          incoming_qty: incomingQty,
          current_stock: currentStock,
          future_stock: futureStock,
          mma: null,
          doc_after_arrival: null,
          has_logo: null,
          has_packaging: null,
          has_manual: null,
          has_opp_wrap: null
        });
      }
      
      var vendorNameCol = productHeaders.indexOf('vendor_name');
      var vendorCodeProdCol = productHeaders.indexOf('vendor_code');
      var vendorName = vendorCode;
      
      for (var k = 1; k < productData.length; k++) {
        if (productData[k][vendorCodeProdCol] === vendorCode) {
          vendorName = productData[k][vendorNameCol] || vendorCode;
          break;
        }
      }
      
      vendorShipments.push({
        shipment_id: shipmentId,
        vendor_code: vendorCode,
        vendor_name: vendorName,
        invoice_no: invoiceNo,
        invoice_date: invoiceDate ? Utilities.formatDate(new Date(invoiceDate), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '',
        total_units: totalUnits,
        carton_count: Number(cartonCount),
        remarks: remarks,
        line_items: lineItems
      });
    }
    
    batch.total_shipments = vendorShipments.length;
    
    var vendorSet = {};
    for (var i = 0; i < vendorShipments.length; i++) {
      vendorSet[vendorShipments[i].vendor_code] = true;
    }
    batch.total_vendors = Object.keys(vendorSet).length;
    
    var totalCartons = 0;
    var totalUnits = 0;
    for (var i = 0; i < vendorShipments.length; i++) {
      totalCartons += vendorShipments[i].carton_count;
      totalUnits += vendorShipments[i].total_units;
    }
    batch.total_cartons = totalCartons;
    batch.total_units = totalUnits;
    
    var today = new Date();
    if (batch.expected_delivery && !batch.actual_delivery) {
      var expectedDate = new Date(batch.expected_delivery);
      if (today > expectedDate) {
        batch.is_delayed = true;
        batch.delay_days = Math.floor((today - expectedDate) / (1000 * 60 * 60 * 24));
      } else {
        batch.is_delayed = false;
        batch.delay_days = 0;
      }
    } else {
      batch.is_delayed = false;
      batch.delay_days = 0;
    }
    
    batch.vendor_shipments = vendorShipments;
    
    return {
      status: 'success',
      batch: batch
    };
    
  } catch (error) {
    Logger.log('Error in getBatchDetails: ' + error.toString());
    throw new Error('Failed to fetch batch details: ' + error.message);
  }
}*/

function getBatchDetails(batchId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var batchesSheet = ss.getSheetByName('Batches');
    var shipmentsSheet = ss.getSheetByName('Vendor_Shipments');
    var linesSheet = ss.getSheetByName('Vendor_Shipment_Lines');
    var productSheet = ss.getSheetByName('EE Product Master');
    var poLineSheet = ss.getSheetByName('Purchase_Order_Lines');

    var batchesData = batchesSheet.getDataRange().getValues();
    var shipmentsData = shipmentsSheet.getDataRange().getValues();
    var linesData = linesSheet.getDataRange().getValues();
    var productData = productSheet.getDataRange().getValues();
    var poLineData = poLineSheet.getDataRange().getValues();

    var batchHeaders = batchesData[0];
    var shipmentHeaders = shipmentsData[0];
    var lineHeaders = linesData[0];
    var productHeaders = productData[0];
    var poLineHeaders = poLineData[0];

    // ── EE Product Master: build SKU → inventory map ──────────
    var prodSkuCol = productHeaders.indexOf('SKU');
    var prodInventoryCol = productHeaders.indexOf('Inventory');

    var inventoryMap = {};
    for (var k = 1; k < productData.length; k++) {
      var prodSku = String(productData[k][prodSkuCol] || '').trim();
      if (prodSku) {
        inventoryMap[prodSku] = Number(productData[k][prodInventoryCol] || 0);
      }
    }

    // ── Purchase_Order_Lines: build po_id+sku → flags map ─────
    var plPoIdCol = poLineHeaders.indexOf('po_id');
    var plSkuCol = poLineHeaders.indexOf('sku');
    var plLogoCol = poLineHeaders.indexOf('custom_logo');
    var plPkgCol = poLineHeaders.indexOf('custom_packaging');
    var plManualCol = poLineHeaders.indexOf('solving_manual');
    var plOppCol = poLineHeaders.indexOf('opp_wrap');

    var poFlagsMap = {};
    for (var p = 1; p < poLineData.length; p++) {
      var plPoId = String(poLineData[p][plPoIdCol] || '').trim();
      var plSku = String(poLineData[p][plSkuCol] || '').trim();
      if (plPoId && plSku) {
        var flagKey = plPoId + '__' + plSku;
        poFlagsMap[flagKey] = {
          has_logo: poLineData[p][plLogoCol] === true || poLineData[p][plLogoCol] === 'TRUE' || poLineData[p][plLogoCol] === 1,
          has_packaging: poLineData[p][plPkgCol] === true || poLineData[p][plPkgCol] === 'TRUE' || poLineData[p][plPkgCol] === 1,
          has_manual: poLineData[p][plManualCol] === true || poLineData[p][plManualCol] === 'TRUE' || poLineData[p][plManualCol] === 1,
          has_opp_wrap: poLineData[p][plOppCol] === true || poLineData[p][plOppCol] === 'TRUE' || poLineData[p][plOppCol] === 1
        };
      }
    }

    // ── Find batch row ────────────────────────────────────────
    var batchIdCol = batchHeaders.indexOf('batch_id');
    var batchRow = null;

    for (var i = 1; i < batchesData.length; i++) {
      if (batchesData[i][batchIdCol] === batchId) {
        batchRow = batchesData[i];
        break;
      }
    }

    if (!batchRow) return null;

    var batch = {
      batch_id: batchId,
      batch_type: (batchRow[batchHeaders.indexOf('batch_type')] || 'sea').toLowerCase(),
      status: batchRow[batchHeaders.indexOf('status')] || 'Shipped',
      created_at: batchRow[batchHeaders.indexOf('created_at')] ? batchRow[batchHeaders.indexOf('created_at')].toISOString() : null,
      created_by: batchRow[batchHeaders.indexOf('created_by')] || '',
      shipped_at: batchRow[batchHeaders.indexOf('shipped_at')] ? batchRow[batchHeaders.indexOf('shipped_at')].toISOString() : null,
      expected_delivery: batchRow[batchHeaders.indexOf('expected_delivery')] ? batchRow[batchHeaders.indexOf('expected_delivery')].toISOString() : null,
      actual_delivery: batchRow[batchHeaders.indexOf('actual_delivery')] ? batchRow[batchHeaders.indexOf('actual_delivery')].toISOString() : null,
      tracking_number: batchRow[batchHeaders.indexOf('tracking_number')] || '',
      carrier: batchRow[batchHeaders.indexOf('carrier')] || '',
      notes: batchRow[batchHeaders.indexOf('notes')] || ''
    };

    // ── Find shipments for this batch ─────────────────────────
    var shipBatchIdCol = shipmentHeaders.indexOf('batch_id');
    var shipmentIdCol = shipmentHeaders.indexOf('shipment_id');
    var vendorCodeCol = shipmentHeaders.indexOf('vendor_code');
    var invoiceNoCol = shipmentHeaders.indexOf('invoice_no');
    var invoiceDateCol = shipmentHeaders.indexOf('invoice_date');
    var cartonCountCol = shipmentHeaders.indexOf('carton_count');
    var remarksCol = shipmentHeaders.indexOf('remarks');

    var batchShipments = [];
    for (var i = 1; i < shipmentsData.length; i++) {
      if (shipmentsData[i][shipBatchIdCol] === batchId) {
        batchShipments.push(shipmentsData[i]);
      }
    }

    // ── Pre-index line columns ────────────────────────────────
    var lineShipmentIdCol = lineHeaders.indexOf('shipment_id');
    var lineIdCol = lineHeaders.indexOf('line_id');
    var linePoIdCol = lineHeaders.indexOf('po_id');
    var skuCol = lineHeaders.indexOf('sku');
    var itemNameCol = lineHeaders.indexOf('item_name');
    var factoryCodeCol = lineHeaders.indexOf('factory_code');
    var eanCol = lineHeaders.indexOf('ean');
    var invoiceQtyCol = lineHeaders.indexOf('invoice_qty');

    // ── Build vendor shipments ────────────────────────────────
    var vendorShipments = [];

    for (var i = 0; i < batchShipments.length; i++) {
      var shipment = batchShipments[i];
      var shipmentId = shipment[shipmentIdCol];
      var vendorCode = shipment[vendorCodeCol];
      var invoiceNo = shipment[invoiceNoCol];
      var invoiceDate = shipment[invoiceDateCol];
      var cartonCount = shipment[cartonCountCol] || 0;
      var remarks = shipment[remarksCol] || '';

      // Find lines for this shipment
      var shipmentLines = [];
      for (var j = 1; j < linesData.length; j++) {
        if (linesData[j][lineShipmentIdCol] === shipmentId) {
          shipmentLines.push(linesData[j]);
        }
      }

      var lineItems = [];
      var totalUnits = 0;

      for (var j = 0; j < shipmentLines.length; j++) {
        var line = shipmentLines[j];
        var sku = String(line[skuCol] || '').trim();
        var itemName = line[itemNameCol];
        var factoryCode = line[factoryCodeCol] || '';
        var ean = line[eanCol] || '';
        var incomingQty = Number(line[invoiceQtyCol]) || 0;

        totalUnits += incomingQty;

        // Inventory lookup from map
        var currentStock = inventoryMap[sku] || 0;
        var futureStock = currentStock + incomingQty;

        // PO flags lookup — split comma-separated po_ids
        var linePoId = String(line[linePoIdCol] || '').trim();
        var poIds = linePoId
          ? linePoId.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
          : [];

        var flags = { has_logo: null, has_packaging: null, has_manual: null, has_opp_wrap: null };
        for (var f = 0; f < poIds.length; f++) {
          var fKey = poIds[f] + '__' + sku;
          if (poFlagsMap[fKey]) {
            flags = poFlagsMap[fKey];
            break; // First match wins
          }
        }

        lineItems.push({
          line_id: line[lineIdCol] || '',
          sku: sku,
          item_name: itemName,
          factory_code: factoryCode,
          ean: ean,
          incoming_qty: incomingQty,
          current_stock: currentStock,
          future_stock: futureStock,
          has_logo: flags.has_logo,
          has_packaging: flags.has_packaging,
          has_manual: flags.has_manual,
          has_opp_wrap: flags.has_opp_wrap
        });
      }

      // Vendor name lookup from EE Product Master
      var vendorNameCol = productHeaders.indexOf('vendor_name');
      var vendorCodeProdCol = productHeaders.indexOf('vendor_code');
      var vendorName = vendorCode;

      for (var k = 1; k < productData.length; k++) {
        if (productData[k][vendorCodeProdCol] === vendorCode) {
          vendorName = productData[k][vendorNameCol] || vendorCode;
          break;
        }
      }

      vendorShipments.push({
        shipment_id: shipmentId,
        vendor_code: vendorCode,
        vendor_name: vendorName,
        invoice_no: invoiceNo,
        invoice_date: invoiceDate ? Utilities.formatDate(new Date(invoiceDate), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '',
        total_units: totalUnits,
        carton_count: Number(cartonCount),
        remarks: remarks,
        line_items: lineItems
      });
    }

    // ── Batch totals ──────────────────────────────────────────
    batch.total_shipments = vendorShipments.length;

    var vendorSet = {};
    for (var i = 0; i < vendorShipments.length; i++) {
      vendorSet[vendorShipments[i].vendor_code] = true;
    }
    batch.total_vendors = Object.keys(vendorSet).length;

    var totalCartons = 0;
    var totalUnitsAll = 0;
    for (var i = 0; i < vendorShipments.length; i++) {
      totalCartons += vendorShipments[i].carton_count;
      totalUnitsAll += vendorShipments[i].total_units;
    }
    batch.total_cartons = totalCartons;
    batch.total_units = totalUnitsAll;

    // ── Delay calculation ─────────────────────────────────────
    var today = new Date();
    if (batch.expected_delivery && !batch.actual_delivery) {
      var expectedDate = new Date(batch.expected_delivery);
      if (today > expectedDate) {
        batch.is_delayed = true;
        batch.delay_days = Math.floor((today - expectedDate) / (1000 * 60 * 60 * 24));
      } else {
        batch.is_delayed = false;
        batch.delay_days = 0;
      }
    } else {
      batch.is_delayed = false;
      batch.delay_days = 0;
    }

    batch.vendor_shipments = vendorShipments;

    return {
      status: 'success',
      batch: batch
    };

  } catch (error) {
    Logger.log('Error in getBatchDetails: ' + error.toString());
    throw new Error('Failed to fetch batch details: ' + error.message);
  }
}

function performSKUMatching_(normalizedRows, productMaster) {
  const eanCounts = detectDuplicateEANs_(normalizedRows);
  
  return normalizedRows.map(row => {
    let matchResult = null;
    let matchedProducts = [];
    
    const vendorSKU = row.sku && String(row.sku).trim() !== '' ? String(row.sku).trim() : null;
    const invoicePrice = Number(row.unit_price) || 0;
    
    // Step 1: Try EAN match first
    if (row.ean) {
      matchResult = matchSKUByEAN_(row.ean, productMaster);
      if (matchResult) {
        if (eanCounts[row.ean] > 1 && !vendorSKU) {
          return enrichRowWithMatch_(row, matchResult, 'MULTIPLE_VARIANT');
        }
        if (vendorSKU && matchResult.sku !== vendorSKU) {
          return enrichRowWithMatch_(row, matchResult, 'SKU_MISMATCH');
        }
        const partialCheck = checkPartialMatch_(row, matchResult, invoicePrice);
        if (partialCheck.isPartial) {
          //return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck);
          return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck, checkMyId_(row, matchResult));

        }
        // ── NEW: MY ID cross-check ──
        return enrichRowWithMatch_(row, matchResult, 'MATCH', null, null, checkMyId_(row, matchResult));
      }
    }
    
    // Step 2: Try factory codes
    if (row.factory_code) {
      const factoryCodes = row.factory_code.split('|');
      
      for (const code of factoryCodes) {
        const match = matchSKUByFactoryCode_(code, productMaster);
        if (match) matchedProducts.push(match);
      }
      
      if (matchedProducts.length === 1) {
        matchResult = matchedProducts[0];
        if (vendorSKU && matchResult.sku !== vendorSKU) {
          return enrichRowWithMatch_(row, matchResult, 'SKU_MISMATCH');
        }
        const partialCheck = checkPartialMatch_(row, matchResult, invoicePrice);
        if (partialCheck.isPartial) {
          //return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck);
          return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck, checkMyId_(row, matchResult));

        }
        // ── NEW: MY ID cross-check ──
        return enrichRowWithMatch_(row, matchResult, 'MATCH', null, null, checkMyId_(row, matchResult));
        
      } else if (matchedProducts.length > 1) {
        const uniqueSKUs = [...new Set(matchedProducts.map(p => p.sku))];
        if (uniqueSKUs.length === 1) {
          matchResult = matchedProducts[0];
          if (vendorSKU && matchResult.sku !== vendorSKU) {
            return enrichRowWithMatch_(row, matchResult, 'SKU_MISMATCH');
          }
          const partialCheck = checkPartialMatch_(row, matchResult, invoicePrice);
          if (partialCheck.isPartial) {
            //return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck);
            return enrichRowWithMatch_(row, matchResult, 'PARTIAL_MATCH', null, partialCheck, checkMyId_(row, matchResult));

          }
          // ── NEW: MY ID cross-check ──
          return enrichRowWithMatch_(row, matchResult, 'MATCH', null, null, checkMyId_(row, matchResult));
        } else {
          return enrichRowWithMatch_(row, matchedProducts[0], 'MULTIPLE_MATCH', matchedProducts);
        }
      }
    }
    
    return enrichRowWithMatch_(row, null, 'UNMATCHED');
  });
}

/**
 * NEW: Check MY ID against matched SKU
 * MY ID from invoice = vendor's stored reference to our internal SKU
 * Returns null if MY ID is blank (no check needed)
 */
function checkMyId_(row, matchResult) {
  const myId = row.my_id && String(row.my_id).trim() !== '' ? String(row.my_id).trim() : null;
  if (!myId) return null; // No MY ID in invoice — skip check silently
  
  const matchedSku = matchResult ? String(matchResult.sku).trim() : '';
  const agrees = myId === matchedSku;
  
  return {
    my_id_value: myId,
    agrees: agrees,
    // If mismatch, show what MY ID says vs what we matched
    mismatch_detail: agrees ? null : myId
  };
}

function enrichRowWithMatch_(row, matchResult, matchStatus, allMatches = null, partialMatchInfo = null, myIdCheck = null) {
  const enriched = {
    ...row,
    match_status: matchStatus,
    matched_sku: matchResult ? matchResult.sku : '',
    matched_name: matchResult ? matchResult.productName : '',
    matched_by: matchResult ? matchResult.matchedBy : '',
    matched_code: matchResult ? matchResult.matchedCode : '',
    match_confidence: matchResult ? matchResult.matchConfidence : '',
    vendor_provided_sku: row.sku || row.factory_code || '',
    sku_mismatch_flag: matchStatus === 'SKU_MISMATCH',
    master_cost: matchResult ? matchResult.cost : 0,
    // ── NEW: MY ID cross-check result ──
    my_id_check: myIdCheck ? myIdCheck.agrees : null,       // true/false/null
    my_id_mismatch_value: myIdCheck ? myIdCheck.mismatch_detail : null, // the conflicting MY ID value
    // color is already carried through via ...row spread, no extra work needed
  };
  
  if (matchStatus === 'PARTIAL_MATCH' && partialMatchInfo) {
    enriched.partial_match_reason = partialMatchInfo.reason;
    enriched.name_similarity = partialMatchInfo.nameSimilarity;
    enriched.price_diff_percentage = partialMatchInfo.priceDiff;
  }
  
  if (matchStatus === 'MULTIPLE_MATCH' && allMatches) {
    enriched.multiple_matches = allMatches.map(m => ({
      sku: m.sku,
      name: m.productName,
      matchedBy: m.matchedBy,
      matchedCode: m.matchedCode,
      cost: m.cost
    }));
  }
  
  return enriched;
}

function testPoEmail() {
  sendPoEmailAndLog_(
    'PO-QY260213-1',       // ← real PO ID
    'QY',
    'nitesh@cubelelo.com',
    'nitesh@cubelelo.com',
    'test'
  );
  Logger.log('Test email sent');
}


function resendPoEmail(poId) {
  // Find vendor code from Purchase_Orders sheet
  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();

  let vendorCode = null;
  let createdBy = null;

  for (let i = 1; i < poData.length; i++) {
    if (String(poData[i][poHeader.po_id]).trim() === poId) {
      vendorCode = poData[i][poHeader.vendor_code];
      createdBy = poData[i][poHeader.created_by];
      break;
    }
  }

  if (!vendorCode) {
    Logger.log('PO not found: ' + poId);
    return;
  }

  // Get vendor email
  const vendorSheet = getSheet_(SHEET_NAMES.VENDOR_MASTERS);
  const vendorHeader = getHeaderMap_(vendorSheet);
  const vendorData = vendorSheet.getDataRange().getValues();

  let emailTo = '';
  let emailCc = '';

  for (let i = 1; i < vendorData.length; i++) {
    if (String(vendorData[i][vendorHeader.vendor_code]).trim() === vendorCode) {
      emailTo = vendorData[i][vendorHeader.primary_email] || '';
      emailCc = vendorData[i][vendorHeader.cc_emails] || '';
      break;
    }
  }

  if (!emailTo) {
    Logger.log('No email found for vendor: ' + vendorCode);
    return;
  }

  Logger.log('Resending PO: ' + poId + ' to: ' + emailTo);
  sendPoEmailAndLog_(poId, vendorCode, emailTo, emailCc, createdBy || 'resend');
  Logger.log('Resend complete for: ' + poId);
}


function pushShipmentToEasyEcom_(shipmentId, vendorCode, expectedDelivery, lines) {
  try {
    const token = getEasyEcomToken();
    
    //const items = lines
     // .filter(line => line.matched_sku || line.sku)
     const items = lines
        .filter(line => (line.matched_sku || line.sku) && line.resolution_action !== 'REQUEST_NEW_SKU')
      .map(line => ({
        sku: line.matched_sku || line.sku,
        quantity: Number(line.invoice_qty || 0),
        unitPrice: Number(line.unit_price || 0)
      }))
      .filter(item => item.quantity > 0);
    
    if (items.length === 0) {
      Logger.log('pushShipmentToEasyEcom_: No valid items for ' + shipmentId);
      return { success: false, message: 'No valid items to push' };
    }
    
    const expDate = expectedDelivery
      ? new Date(expectedDelivery)
      : new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
    
    const payload = {
      vendorId: vendorCode,
      referenceCode: shipmentId,
      expDeliveryDate: Utilities.formatDate(expDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      shippingCost: 0,
      createOrUpdate: 'I',
      isCancel: 0,
      items: items
    };
    
    Logger.log('pushShipmentToEasyEcom_ payload: ' + JSON.stringify(payload));
    
    const response = UrlFetchApp.fetch('https://api.easyecom.io/WMS/Cart/CreatePurchaseOrder', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'x-api-key': 'f68694e1bdeba69581d0d302ac07cea420b4c061',
        'Content-Type': 'application/json'
      },
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    
    const result = JSON.parse(response.getContentText());
    Logger.log('pushShipmentToEasyEcom_ response: ' + JSON.stringify(result));
    
    const eeSuccess = result.code === 200;
    const eePoId = eeSuccess ? String(result.data.poId) : '';
    
    // Write result back to Vendor_Shipments row
    const shipmentSheet = getSheet_(SHEET_NAMES.VENDOR_SHIPMENTS);
    const shipmentHeader = getHeaderMap_(shipmentSheet);
    
    updateRowByKey_(shipmentSheet, shipmentHeader, 'shipment_id', shipmentId, {
      ee_po_status: eeSuccess ? 'PUSHED' : 'FAILED',
      ee_po_reference: eePoId,
      ee_push_error: eeSuccess ? '' : (result.message || JSON.stringify(result)).slice(0, 200)
    });
    
    return { success: eeSuccess, poId: eePoId };
    
  } catch (err) {
    Logger.log('pushShipmentToEasyEcom_ error: ' + err.message);
    return { success: false, message: err.message };
  }
}

function writeNewSKURequests_(shipmentId, vendorCode, validatedRows, userEmail) {
  try {
    const sheet = getSheet_('New_SKU_Requests');
    const header = getHeaderMap_(sheet);
    const now = new Date();
    
    // Find rows where user selected REQUEST_NEW_SKU as resolution action
    const skuRequestRows = validatedRows.filter(row =>
      row.resolution_action === 'REQUEST_New_SKU' ||
      row.resolution_action === 'REQUEST_NEW_SKU'
    );
    
    if (skuRequestRows.length === 0) {
      Logger.log('writeNewSKURequests_: No SKU requests for shipment ' + shipmentId);
      return { success: true, count: 0 };
    }
    
    skuRequestRows.forEach(row => {
      const requestId = 'NSR-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      
      appendRowFromObject_(sheet, header, {
        request_id: requestId,
        shipment_id: shipmentId,
        vendor_code: vendorCode,
        factory_code: row.factory_code || '',
        //ean: row.ean || '',
        ean: row.ean && String(row.ean).trim() !== '' ? String(row.ean).trim() : '0',
        item_name: row.item_name || '',
        color: row.color || '',
        my_id: row.my_id || '',
        invoice_qty: Number(row.invoice_qty || 0),
        unit_price: Number(row.unit_price || 0),
        requested_by: userEmail,
        requested_at: now,
        status: 'PENDING',
        ee_sku: '',
        ee_product_name: '',
        notes: row.resolution_notes || '',
        resolved_at: '',
        resolved_by: ''
      });
    });
    
    Logger.log('writeNewSKURequests_: Wrote ' + skuRequestRows.length + ' SKU requests');
    return { success: true, count: skuRequestRows.length };
    
  } catch (err) {
    Logger.log('writeNewSKURequests_ error: ' + err.message);
    return { success: false, message: err.message };
  }
}


function testNewSKURequest() {
  // ── Test data — mimics an UNMATCHED row with REQUEST_NEW_SKU ──
  const testShipmentId = 'VS-TEST-SKU-' + Date.now();
  const testVendorCode = 'PW';
  const testUserEmail = Session.getActiveUser().getEmail();
  
  const testValidatedRows = [
    {
      // UNMATCHED row — user selected Request New SKU
      matched_sku: '',
      sku: '',
      factory_code: 'SSLZ01|7186A',
      ean: '6923039171869',
      item_name: 'ShengShou 6x6 Mastermorphix',
      color: 'stickerless',
      my_id: 'SSLZ01',
      invoice_qty: 1,
      unit_price: 76.44,
      match_status: 'UNMATCHED',
      resolution_action: 'REQUEST_NEW_SKU',
      resolution_notes: 'New product, not in master'
    },
    {
      // MATCH row — should be ignored by writeNewSKURequests_
      matched_sku: '1530010',
      sku: '1530010',
      factory_code: 'SSMB05|8203',
      ean: '6923039182032',
      item_name: 'SengSo 4x4 Magnetic Clock V2',
      color: 'black+white',
      my_id: '1530010',
      invoice_qty: 4,
      unit_price: 57.4,
      match_status: 'MATCH',
      resolution_action: 'ACCEPT',
      resolution_notes: ''
    }
  ];

  Logger.log('=== TEST: New SKU Request Write ===');
  Logger.log('Shipment ID: ' + testShipmentId);
  Logger.log('Vendor: ' + testVendorCode);
  Logger.log('Total rows: ' + testValidatedRows.length);
  Logger.log('REQUEST_NEW_SKU rows: ' + testValidatedRows.filter(r => r.resolution_action === 'REQUEST_NEW_SKU').length);

  // ── Run the function ────────────────────────────────────────
  Logger.log('\n--- Running writeNewSKURequests_ ---');
  const result = writeNewSKURequests_(testShipmentId, testVendorCode, testValidatedRows, testUserEmail);
  
  Logger.log('\n--- Result ---');
  Logger.log(JSON.stringify(result));
  
  if (result.success && result.count > 0) {
    Logger.log('\n✅ SUCCESS — ' + result.count + ' SKU request(s) written to New_SKU_Requests sheet');
    Logger.log('Check the New_SKU_Requests sheet for a PENDING row with shipment_id: ' + testShipmentId);
  } else if (result.success && result.count === 0) {
    Logger.log('\n⚠️ No rows written — check resolution_action filter matches exactly');
  } else {
    Logger.log('\n❌ FAILED — ' + result.message);
  }
}

function testGetBatches() {
  try {
    const result = getBatches();
    
    Logger.log('Total batches: ' + result.batches.length);
    
    if (result.batches.length > 0) {
      const firstBatch = result.batches[0];
      Logger.log('First batch ID: ' + firstBatch.batch_id);
      Logger.log('Has vendor_summary: ' + (firstBatch.vendor_summary !== undefined));
      Logger.log('vendor_summary value: ' + JSON.stringify(firstBatch.vendor_summary));
      Logger.log('Full first batch: ' + JSON.stringify(firstBatch));
    }
    
    Logger.log('SUCCESS');
  } catch (e) {
    Logger.log('ERROR: ' + e.toString());
  }
}

function apiClosePo_(payload) {
  const { po_id } = payload;
  if (!po_id) throw new Error('po_id is required');

  const now = new Date();

  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();

  let poRowIndex = -1;
  for (let i = 1; i < poData.length; i++) {
    if (String(poData[i][poHeader.po_id]).trim() === po_id) {
      poRowIndex = i;
      break;
    }
  }
  if (poRowIndex === -1) throw new Error('PO not found: ' + po_id);

  const currentStatus = String(poData[poRowIndex][poHeader.po_status] || '').trim();
  if (currentStatus === 'CLOSED' || currentStatus === 'CLOSED_CANCELLED') {
    throw new Error('PO is already closed');
  }

  // Update PO header
  updateRowByKey_(poSheet, poHeader, 'po_id', po_id, {
    po_status: 'CLOSED',
    updated_at: now
  });

  // Update all non-FULFILLED lines in one pass
  const lineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  const lineData = lineSheet.getDataRange().getValues();

  const updatedRows = [];
  for (let i = 1; i < lineData.length; i++) {
    if (
      String(lineData[i][lineHeader.po_id]).trim() === po_id &&
      String(lineData[i][lineHeader.line_status]).trim() !== 'FULFILLED'
    ) {
      lineData[i][lineHeader.line_status] = 'CLOSED';
      lineData[i][lineHeader.updated_at]  = now;
      updatedRows.push({ rowIndex: i + 1, rowData: lineData[i] });
    }
  }

  const totalCols = lineData[0].length;
  updatedRows.forEach(({ rowIndex, rowData }) => {
    lineSheet.getRange(rowIndex, 1, 1, totalCols).setValues([rowData]);
  });

  return { success: true, po_id, message: 'PO closed successfully' };
}

function apiGetPendingLines_(payload) {
  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();

  // Build map of active POs: po_id → { po_date, planned_mode, vendor_code }
  const activePOMap = {};
  for (let i = 1; i < poData.length; i++) {
    const status = String(poData[i][poHeader.po_status] || '').trim().toUpperCase();
    if (status !== 'OPEN' && status !== 'PARTIALLY_SHIPPED') continue;
    const poId = String(poData[i][poHeader.po_id] || '').trim();
    if (!poId) continue;
    activePOMap[poId] = {
      po_date:      poData[i][poHeader.po_date] ? new Date(poData[i][poHeader.po_date]).toISOString() : '',
      planned_mode: poData[i][poHeader.planned_mode],
      vendor_code:  poData[i][poHeader.vendor_code]
    };
  }

  const lineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  const lineData = lineSheet.getDataRange().getValues();

  const today = new Date();
  const rows = [];

  for (let i = 1; i < lineData.length; i++) {
    const poId = String(lineData[i][lineHeader.po_id] || '').trim();
    if (!activePOMap[poId]) continue;

    const lineStatus = String(lineData[i][lineHeader.line_status] || '').trim().toUpperCase();
    if (lineStatus !== 'OPEN' && lineStatus !== 'PARTIAL') continue;

    const po = activePOMap[poId];
    const orderedQty   = Number(lineData[i][lineHeader.ordered_qty]   || 0);
    const fulfilledQty = Number(lineData[i][lineHeader.fulfilled_qty] || 0);
    const poDate       = po.po_date ? new Date(po.po_date) : null;
    const daysPending  = poDate ? Math.floor((today - poDate) / (1000 * 60 * 60 * 24)) : 0;

    rows.push({
      po_id:             poId,
      vendor_code:       po.vendor_code,
      sku:               lineData[i][lineHeader.sku],
      sku_name:          lineData[i][lineHeader.sku_name],
      ordered_qty:       orderedQty,
      fulfilled_qty:     fulfilledQty,
      pending_qty:       orderedQty - fulfilledQty,
      days_pending:      daysPending,
      po_date:           po.po_date,
      planned_mode:      po.planned_mode,
      custom_logo:       lineData[i][lineHeader.custom_logo]       || false,
      custom_packaging:  lineData[i][lineHeader.custom_packaging]  || false,
      solving_manual:    lineData[i][lineHeader.solving_manual]    || false,
      opp_wrap:          lineData[i][lineHeader.opp_wrap]          || false,
      unit_price_rmb:    Number(lineData[i][lineHeader.unit_price_rmb] || 0)
    });
  }

  return { success: true, data: rows };
}

function apiGetSKUHistory_(payload) {
  const { sku } = payload;
  if (!sku) throw new Error('sku is required');
  const cleanSKU = String(sku).trim().toLowerCase();

  const poSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDERS);
  const poHeader = getHeaderMap_(poSheet);
  const poData = poSheet.getDataRange().getValues();

  // Build PO map: po_id → { po_date, planned_mode, vendor_code, po_status }
  const poMap = {};
  for (let i = 1; i < poData.length; i++) {
    const poId = String(poData[i][poHeader.po_id] || '').trim();
    if (!poId) continue;
    poMap[poId] = {
      po_date:      poData[i][poHeader.po_date] ? new Date(poData[i][poHeader.po_date]).toISOString() : '',
      planned_mode: poData[i][poHeader.planned_mode],
      vendor_code:  poData[i][poHeader.vendor_code],
      po_status:    poData[i][poHeader.po_status]
    };
  }

  const lineSheet = getSheet_(SHEET_NAMES.PURCHASE_ORDER_LINES);
  const lineHeader = getHeaderMap_(lineSheet);
  const lineData = lineSheet.getDataRange().getValues();

  const rows = [];

  for (let i = 1; i < lineData.length; i++) {
    const lineSKU = String(lineData[i][lineHeader.sku] || '').trim().toLowerCase();
    if (lineSKU !== cleanSKU) continue;

    const poId = String(lineData[i][lineHeader.po_id] || '').trim();
    const po   = poMap[poId] || { po_date: '', planned_mode: '', vendor_code: '', po_status: '' };

    const orderedQty   = Number(lineData[i][lineHeader.ordered_qty]   || 0);
    const fulfilledQty = Number(lineData[i][lineHeader.fulfilled_qty] || 0);
    const lineStatus   = String(lineData[i][lineHeader.line_status]   || '').trim();
    const updatedAt    = lineData[i][lineHeader.updated_at] ? new Date(lineData[i][lineHeader.updated_at]).toISOString() : '';

    let fulfillmentDays = null;
    if (lineStatus === 'FULFILLED' && po.po_date && updatedAt) {
      fulfillmentDays = Math.floor(
        (new Date(updatedAt) - new Date(po.po_date)) / (1000 * 60 * 60 * 24)
      );
    }

    rows.push({
      po_line_id:       lineData[i][lineHeader.po_line_id],
      po_id:            poId,
      vendor_code:      po.vendor_code,
      po_date:          po.po_date,
      planned_mode:     po.planned_mode,
      po_status:        po.po_status,
      ordered_qty:      orderedQty,
      fulfilled_qty:    fulfilledQty,
      pending_qty:      orderedQty - fulfilledQty,
      line_status:      lineStatus,
      unit_price_rmb:   Number(lineData[i][lineHeader.unit_price_rmb] || 0),
      fulfillment_days: fulfillmentDays,
      updated_at:       updatedAt
    });
  }

  // Sort by po_date DESC
  rows.sort((a, b) => {
    if (!a.po_date) return 1;
    if (!b.po_date) return -1;
    return new Date(b.po_date).getTime() - new Date(a.po_date).getTime();
  });

  return { success: true, sku: sku, data: rows };
}


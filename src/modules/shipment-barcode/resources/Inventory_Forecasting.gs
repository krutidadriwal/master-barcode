/**
 * ===================================================================
 * Inventory Forecasting Engine - CORE UTILITIES
 * ===================================================================
 */

// ===================================================================
//  GLOBAL CACHE & SETTINGS
// ===================================================================
let CACHE = {};
let HEADER_MAPS = {};
//const SALES_HISTORY_DAYS = 90;

// Define the exact names of your Master Sheets
const SHEETS = {
  products: "EE Product Master",
  components: "EE Component Master",
  sales: "Sales Data",
  inventory: "Inventory Data",
  ee_po: "EE Purchase Orders",       // External shipment log
  internal_po: "Internal PO Tracker",// Order book
  exclude: "Exclude List" ,            // SKUs to exclude from forecasting
  bulk_skus: "BULK_SKUs",  // NEW
  users: "Users",
  po_lines: "Purchase_Order_Lines",      
  purchase_orders: "Purchase_Orders"  

};

// SKU prefix exclusion rules — structural product taxonomy
// These SKU types are never included in forecasting output
const SKU_EXCLUDE_PREFIXES = [
  '999',  // Raw materials
  '400',  // Kreativity Brand items
  '888',  // Event Tickets
  'CLB',  // Combo Items
  '140',  // Pouch Items
  '141',  // Cube Stands
  //'TB', // TinkerBox Items
  'UV' // UV Print Cubes
];

const SKU_EXCLUDE_SUFFIXES = [
  'R',    // Refurbished / Return items
];


// ===================================================================
//  DATA ACCESS & UTILITIES
// ===================================================================

/**
 * Clears the temporary memory cache.
 */
function clearCache() {
  CACHE = {};
  HEADER_MAPS = {};
}

/**
 * Gets data from a sheet, handling caching and headers.
 */
function getSheetData(sheetName) {
  if (CACHE[sheetName]) {
    return CACHE[sheetName];
  }
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}. Please check your sheet names.`);
  }
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  if (values.length <= 1) {
    HEADER_MAPS[sheetName] = buildHeaderMap(values[0] || []);
    return [];
  }
  
  HEADER_MAPS[sheetName] = buildHeaderMap(values[0]);
  
  const data = values.slice(1);
  
  // Filter out completely blank rows
  const filteredData = data.filter(row => {
    return Array.isArray(row) && row.length > 0 && String(row[0]).trim().length > 0;
  });
  
  CACHE[sheetName] = filteredData;
  return filteredData;
}

/**
 * Creates a map of header names to column indices.
 */
function buildHeaderMap(headers) {
  const map = {};
  if (Array.isArray(headers)) {
    headers.forEach((name, index) => {
      if (typeof name === 'string' && name.trim()) {
        map[name.trim()] = index;
      }
    });
  }
  return map;
}

/**
 * Safely gets a value from a row using the column name.
 */
function getValue(row, sheetName, colName, isNumber = false) {
  if (!Array.isArray(row) || row.length === 0) {
    return isNumber ? 0 : null; 
  }
  
  const map = HEADER_MAPS[sheetName];
  if (!map || map[colName] === undefined) {
    return isNumber ? 0 : null; 
  }
  
  const value = row[map[colName]];
  
  if (isNumber) {
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
  }
  return (value === null || value === undefined) ? null : String(value).trim();
}

/**
 * Checks if row has any non-empty value.
 */
function ArrayOfRow(row) {
  return Array.isArray(row) && row.length > 0 &&
    row.some(value => value !== null && value !== undefined && String(value).trim().length > 0);
}

/**
 * ===================================================================
 * EXCLUDE LIST
 * ===================================================================
 */

/**
 * Returns a Set of SKUs that should be excluded from forecasting.
 */
function getExcludeSet() {
  const excludeSet = new Set();
  try {
    const excludeData = getSheetData(SHEETS.exclude);
    for (const row of excludeData) {
      if (!ArrayOfRow(row)) continue;
      const sku = getValue(row, SHEETS.exclude, 'Exclude List');
      if (sku) excludeSet.add(sku);
    }
  } catch (err) {
    Logger.log('Exclude List sheet not found or error: ' + err.message);
  }
  return excludeSet;
}

/**
 * ===================================================================
 * COMPONENT MAP / BOM
 * ===================================================================
 */

/**
 * Builds the component map (BOM).
 * If a child SKU appears multiple times in the row, its qty is that count.
 */
function buildComponentMap(componentData, productData) {
  const componentMap = new Map();
  const productSkuSet = new Set(productData.map(row => getValue(row, SHEETS.products, 'SKU')));

  for (const row of componentData) {
    if (!ArrayOfRow(row) || !row[0]) continue;
    
    const parentSku = getValue(row, SHEETS.components, 'Parent SKU');
    if (!parentSku) continue;

    const componentCountMap = new Map();

    let childIndex = 1;
    while (true) {
      const childColName = `Child ${childIndex}`;
      const childSku = getValue(row, SHEETS.components, childColName);
      if (!childSku) break;

      if (productSkuSet.has(childSku)) {
        componentCountMap.set(childSku, (componentCountMap.get(childSku) || 0) + 1);
      }
      childIndex++;
    }

    const componentList = [];
    for (const [childSku, qty] of componentCountMap.entries()) {
      componentList.push({ sku: childSku, qty: qty });
    }

    if (componentList.length > 0) {
      componentMap.set(parentSku, componentList);
    }
  }
  return componentMap;
}

/**
 * ===================================================================
 * TRUE DEMAND CALCULATION (WITH CHANNEL & COMBO SPLIT)
 * ===================================================================
 */

/**
 * Calculates true demand by exploding combo/kit sales.
 * Returns:
 *  - demandMap (per SKU aggregates)
 *  - dailySalesHistoryMap (per SKU, per-day aggregated for charts)
 *  - channelMap (per SKU channel-wise units)
 *  - comboDemandMap (per SKU demand originating from combos)
 */
//function calculateTrueDemand(salesData, componentMap, mode, CONFIG) {
//function calculateTrueDemand(salesData, componentMap, mode, CONFIG, explodeExclusionSet) {
  function calculateTrueDemand(salesData, componentMap, mode, CONFIG, explodeExclusionSet, rmbPriceMap) {
  //const CONFIG = getConfig();
  const demandMap = new Map(); 
  const dailyUnitsMap = new Map(); 
  const channelMap = new Map(); 
  const comboDemandMap = new Map();
  const dailyB2CUnitsMap = new Map();  // NEW — B2C only per day

  //const today = new Date();
  //const cutoffDate = new Date(today.getTime() - CONFIG.SALES_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const today = new Date();
  today.setHours(23, 59, 59, 999); // end of today

  const cutoffDate = new Date();
  cutoffDate.setHours(0, 0, 0, 0);
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.SALES_HISTORY_DAYS);

  for (const row of salesData) {
    if (!ArrayOfRow(row) || !row[0]) continue;

    const currentDate = new Date(getValue(row, SHEETS.sales, 'Date'));
    if (isNaN(currentDate.getTime()) || currentDate < cutoffDate) continue;

    const sku = getValue(row, SHEETS.sales, 'Master SKU');
    const qty = getValue(row, SHEETS.sales, 'Quantity', true);
    //const salesType = (getValue(row, SHEETS.sales, 'Sales Type') || '').toLowerCase();
    const salesTypeRaw = getValue(row, SHEETS.sales, 'Sales Type') || '';
    const salesType = salesTypeRaw.trim().toUpperCase();   // make it uppercase for consistent comparisons
    const channelNameRaw = getValue(row, SHEETS.sales, 'Channel Name') || 'Unknown';
    const channelKey = channelNameRaw.toLowerCase().trim() || 'unknown';

    if (!sku || qty <= 0) continue;

    const dateKey = currentDate.toISOString().split('T')[0];
    const isB2BOrder = (salesType === 'B2B');

    const isBulkChannel = channelKey === 'bulk';

    // -----------------------------
    // INTERNAL FUNCTION
    // -----------------------------

    // Helper to update demand for any target SKU

    // Helper to update demand for any target SKU
//const updateForSku = (targetSku, targetQty, isFromCombo, isB2BOrder) => {
  const updateForSku = (targetSku, targetQty, isFromCombo, isB2BOrder, parentSku = null) => {

  // ----------------------------
  // (1) Initialize demand object
  // ----------------------------
  let demand = demandMap.get(targetSku) || {
    total90Day: 0,
    total30Day: 0,
    total15Day: 0,
    total30to60Day: 0,
    total60to90Day: 0,
    avgDailySales: 0,

    b2bUnits: 0,
    b2bOrders: 0,
    b2cUnits: 0,
    b2bOrderSizes: [],  // NEW: track individual B2B order sizes
    bulkOrderSizes: [],   // NEW: BULK channel order sizes
    bulkOrders: 0,         // NEW: BULK channel order count
    bulkUnits: 0,         // NEW — BULK channel units total
    b2bRegularUnits: 0,   // NEW — regular B2B only, excludes BULK — feeds ADS


  };

  // ----------------------------
  // (2) B2B / B2C Proper Handling
  // ----------------------------

  if (isFromCombo) {
    // Combo-component → units only, do NOT count order
    if (isB2BOrder) {
      demand.b2bUnits += targetQty;
    } else {
      demand.b2cUnits += targetQty;
    }
  } else {
  // Parent SKU → units + order count
  if (isB2BOrder) {
    demand.b2bUnits += targetQty;

    if (isBulkChannel) {
      demand.bulkUnits += targetQty;        // NEW
      // BULK: track units + order size separately, excluded from Croston ADS
      if (!Array.isArray(demand.bulkOrderSizes)) demand.bulkOrderSizes = [];
      demand.bulkOrderSizes.push(targetQty);
      demand.bulkOrders = (demand.bulkOrders || 0) + 1;
    } else {
      // Regular B2B: feeds Croston ADS calculation
      demand.b2bRegularUnits += targetQty;  // NEW — regular B2B only
      demand.b2bOrders += 1;
      if (!Array.isArray(demand.b2bOrderSizes)) demand.b2bOrderSizes = [];
      demand.b2bOrderSizes.push(targetQty);
    }
  } else {
    demand.b2cUnits += targetQty;
  }
}



  // ----------------------------
  // (3) Date bucket calculation
  // ----------------------------
  const daysSinceSale = (today.getTime() - currentDate.getTime()) / (24 * 60 * 60 * 1000);

  demand.total90Day += targetQty;

  if (daysSinceSale <= 15) {
    demand.total15Day += targetQty;
  }

  if (daysSinceSale <= 30) {
    demand.total30Day += targetQty;
  }

  if (daysSinceSale > 30 && daysSinceSale <= 60) {
    demand.total30to60Day += targetQty;
  }

  if (daysSinceSale > 60 && daysSinceSale <= 90) {
    demand.total60to90Day += targetQty;
  }

  // ----------------------------
  // (4) Store updated demand
  // ----------------------------
  demandMap.set(targetSku, demand);

 // ----------------------------
// (5) Daily units for chart
// ----------------------------

// Total daily tracking (ALL sales — B2C + B2B + BULK)
    if (!dailyUnitsMap.has(targetSku)) dailyUnitsMap.set(targetSku, {});
      const dailyMapTotal = dailyUnitsMap.get(targetSku);
      dailyMapTotal[dateKey] = (dailyMapTotal[dateKey] || 0) + targetQty;

// B2C only daily tracking
    if (!isB2BOrder) {
      if (!dailyB2CUnitsMap.has(targetSku)) dailyB2CUnitsMap.set(targetSku, {});
        const dailyB2CMap = dailyB2CUnitsMap.get(targetSku);
        dailyB2CMap[dateKey] = (dailyB2CMap[dateKey] || 0) + targetQty;
    }
  // ----------------------------
  // (6) Channel aggregation
  // ----------------------------
  if (!channelMap.has(targetSku)) channelMap.set(targetSku, new Map());
  const chanMap = channelMap.get(targetSku);
  chanMap.set(channelKey, (chanMap.get(channelKey) || 0) + targetQty);

  // ----------------------------
  // (7) Combo demand tracking
  // ----------------------------
  if (isFromCombo) {
    comboDemandMap.set(targetSku, (comboDemandMap.get(targetSku) || 0) + targetQty);
    // NEW — track which parent contributed how many units
  if (parentSku) {
    if (!demand.comboBreakdown) demand.comboBreakdown = {};
    demand.comboBreakdown[parentSku] = 
      (demand.comboBreakdown[parentSku] || 0) + targetQty;
  }
  }
};

    // -------------------------------------------------
    // 1. Base sale for parent SKU
    // -------------------------------------------------
    updateForSku(sku, qty, false, isB2BOrder);

    // -------------------------------------------------
    // 2. Explode combo/kit sales into their components
    // -------------------------------------------------
    const components = componentMap.get(sku);
if (components && !explodeExclusionSet.has(sku)) {
  // Only explode if parent SKU is NOT in exclusion set
  for (const comp of components) {
    updateForSku(comp.sku, comp.qty * qty, true, isB2BOrder, sku);
  }
}
  }

  // -------------------------------------------------
  // FINALIZE: Calculate ADS (still old logic for Phase-1)
  // -------------------------------------------------
const dailySalesHistoryMap = new Map();

for (const [sku, demand] of demandMap.entries()) {

  // PHASE-3: Replace old ADS with new hybrid model
  //const adsB2C = calculateHybridB2C_ADS(demand, CONFIG);
  const rmbPrice = rmbPriceMap ? (rmbPriceMap.get(sku) || 0) : 0;
  const adsB2C = calculateHybridB2C_ADS(demand, CONFIG, rmbPrice);
  const adsB2B = calculateB2B_ADS(demand, CONFIG);

  demand._adsB2C = adsB2C;
  demand._adsB2B = adsB2B;
  demand.avgDailySales = adsB2C + adsB2B;
  demand._adsTotal = demand.avgDailySales;


  const dailyMap = dailyUnitsMap.get(sku) || {};

// Fill calendar gaps with 0 so stdDev uses real 30-day windows
/*const history = [];
for (let i = CONFIG.SALES_HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split('T')[0];
    history.push({
        date: d,
        units: dailyMap[dateKey] || 0
    });
}*/
const yesterday = new Date();
yesterday.setHours(0, 0, 0, 0);
yesterday.setDate(yesterday.getDate() - 1);

const history = [];
for (let i = CONFIG.SALES_HISTORY_DAYS - 1; i >= 0; i--) {
  const d = new Date(yesterday);
  d.setDate(d.getDate() - i);
  const dateKey = d.toISOString().split('T')[0];
  history.push({
    date: d,
    units: dailyMap[dateKey] || 0
  });
}

dailySalesHistoryMap.set(sku, history);
demand.dailyHistory = history;

// NEW — B2C only history with same gap-fill
const dailyB2CMap = dailyB2CUnitsMap.get(sku) || {};
/*const historyB2C = [];
for (let i = CONFIG.SALES_HISTORY_DAYS - 1; i >= 0; i--) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  const dateKey = d.toISOString().split('T')[0];
  historyB2C.push({ date: d, units: dailyB2CMap[dateKey] || 0 });
}*/
const historyB2C = [];
for (let i = CONFIG.SALES_HISTORY_DAYS - 1; i >= 0; i--) {
  const d = new Date(yesterday);
  d.setDate(d.getDate() - i);
  const dateKey = d.toISOString().split('T')[0];
  historyB2C.push({ date: d, units: dailyB2CMap[dateKey] || 0 });
}

demand.dailyHistoryB2C = historyB2C;

  // -----------------------------
  // 🔵 DEBUG to inspect whether daily history is correctly built
  // -----------------------------
  Logger.log("BUILD HISTORY — SKU: " + sku + 
             " | Days: " + history.length +
             " | FirstDay: " + (history[0] ? history[0].date : "N/A") +
             " | LastDay: " + (history[history.length-1] ? history[history.length-1].date : "N/A"));

}


  return { demandMap, dailySalesHistoryMap, channelMap, comboDemandMap };
}

function calculateB2B_SafetyStock(demand) {
  const b2bUnits = demand.b2bUnits || 0;
  const b2bOrders = demand.b2bOrders || 0;
  const orderSizes = Array.isArray(demand.b2bOrderSizes) ? demand.b2bOrderSizes.slice() : [];

  // No B2B → no SS_B2B
  if (b2bOrders === 0 || b2bUnits === 0 || orderSizes.length === 0) {
    return 0;
  }

  // --- Basic stats ---
  const avgSize = b2bUnits / b2bOrders;           // mean bulk order size
  //const SALES_DAYS = typeof SALES_HISTORY_DAYS !== 'undefined' ? SALES_HISTORY_DAYS : 90;
  const SALES_DAYS = CONFIG.SALES_HISTORY_DAYS;
  const interval = SALES_DAYS / b2bOrders;        // avg days between B2B orders
  const probability = interval > 0 ? (1 / interval) : 0;
  const protectionFactor = 1.2;                   // stability multiplier

  // Expected (Croston-style) contribution
  const expectedB2B = avgSize * probability * protectionFactor;

  // --- Percentile 80 for this SKU's bulk size distribution ---
  orderSizes.sort((a, b) => a - b);
  const n = orderSizes.length;
  const idx = Math.floor(0.8 * (n - 1));          // 80th percentile index
  const threshold = orderSizes[idx];

  // --- Volatility (Coefficient of Variation) ---
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const diff = orderSizes[i] - avgSize;
    variance += diff * diff;
  }
  variance = variance / n;
  const stdDev = Math.sqrt(variance);
  const cv = avgSize > 0 ? (stdDev / avgSize) : 0;

  // --- Decide if this SKU needs half-order protection ---
  const needsHalfOrder =
    b2bOrders === 1 ||          // very sporadic
    avgSize > threshold ||      // avg size > typical larger order
    cv > 0.5;                   // highly volatile bulk pattern

  const halfOrder = needsHalfOrder ? avgSize * 0.5 : 0;

  // Final B2B safety stock
  const SS_B2B = Math.max(expectedB2B, halfOrder);

  return SS_B2B;
}


/**
 * Hybrid Weighted ADS for B2C demand.
 * Trend-sensitive, low-velocity smoothing, spike-proof.
 */
/*function calculateHybridB2C_ADS(demand, CONFIG) {
  //const CONFIG = getConfig();
  const d15 = demand.total15Day || 0;
  const d30 = demand.total30Day || 0;
  const d60 = demand.total30to60Day || 0;
  const d90 = demand.total60to90Day || 0;

  // Convert buckets into daily ADS
  const ads15 = d15 / 15;
  const ads30 = d30 / 30;
  const ads60 = d60 / 30;   // 30-to-60 day bucket = 30 days
  const ads90 = d90 / 30;   // 60-to-90 day bucket = 30 days
  // Weighted ADS
  let weightedADS =
      ads15 * CONFIG.ADS_WEIGHT_15D +
      ads30 * CONFIG.ADS_WEIGHT_30D +
      ads60 * CONFIG.ADS_WEIGHT_60D +
      ads90 * CONFIG.ADS_WEIGHT_90D;

  // Smoothing for low velocity SKUs
  if (weightedADS > 0 && weightedADS < CONFIG.LOW_VELOCITY_FLOOR) {
    weightedADS = CONFIG.LOW_VELOCITY_FLOOR;
  }

  return weightedADS;
}*/

function calculateHybridB2C_ADS(demand, CONFIG, rmbPrice) {
  const d15 = demand.total15Day || 0;
  const d30 = demand.total30Day || 0;
  const d60 = demand.total30to60Day || 0;
  const d90 = demand.total60to90Day || 0;

  const ads15 = d15 / 15;
  const ads30 = d30 / 30;
  const ads60 = d60 / 30;
  const ads90 = d90 / 30;

  let weightedADS =
    ads15 * CONFIG.ADS_WEIGHT_15D +
    ads30 * CONFIG.ADS_WEIGHT_30D +
    ads60 * CONFIG.ADS_WEIGHT_60D +
    ads90 * CONFIG.ADS_WEIGHT_90D;

  // Cost-aware velocity floor:
  // Only apply LOW_VELOCITY_FLOOR for items below RMB cost threshold
  // Expensive slow-movers get their true tiny ADS — no artificial inflation
  const costThreshold = CONFIG.LOW_VELOCITY_COST_THRESHOLD || 150;
  const applyFloor = !rmbPrice || rmbPrice < costThreshold;

  if (weightedADS > 0 && weightedADS < CONFIG.LOW_VELOCITY_FLOOR && applyFloor) {
    weightedADS = CONFIG.LOW_VELOCITY_FLOOR;
  }

  return weightedADS;
}

function calculateB2B_ADS(demand, CONFIG) {
  //const CONFIG = getConfig();
  //const b2bUnits = demand.b2bUnits || 0;
  //const b2bOrders = demand.b2bOrders || 0;
  // Use b2bRegularUnits — excludes BULK channel
  const b2bUnits = demand.b2bRegularUnits || 0;
  const b2bOrders = demand.b2bOrders || 0;

  // If no B2B activity, ADS_B2B = 0
  if (b2bOrders === 0 || b2bUnits === 0) return 0;

  // avgSize = avg order size
  const avgSize = b2bUnits / b2bOrders;

  // interval = DAYS / orders
  //const DAYS = typeof SALES_HISTORY_DAYS !== "undefined" ? SALES_HISTORY_DAYS : 90;
  const DAYS = CONFIG.SALES_HISTORY_DAYS;

  const interval = DAYS / b2bOrders;

  // probability of order per day
  const probability = interval > 0 ? (1 / interval) : 0;

  // expected B2B per day (Croston-like)
  const expectedB2B = avgSize * probability * CONFIG.B2B_MULTIPLIER;

  return expectedB2B;  // units/day
}

function calculate_SS_B2C(demand, leadTime, CONFIG) {
  //const CONFIG = getConfig();
  const Z = CONFIG.SERVICE_LEVEL_Z; // 95% service level
  const dailyHistory = demand.dailyHistory || [];

    // 🔴 DEBUG HERE
  Logger.log("SS_B2C DEBUG — SKU dailyHistory: " + JSON.stringify({
    sku: demand.sku,
    historyLength: dailyHistory.length,
    historySample: dailyHistory.slice(-10)   // Show last 10 days for inspection
  }));


  // If not enough history, no SS_B2C can be computed
  if (dailyHistory.length === 0) return 0;

  // Calculate standard deviation of B2C demand in the last 30 days
  const last30 = dailyHistory.slice(-30).map(d => d.units);  // Last 30 days
  const mean30 = last30.reduce((a, b) => a + b, 0) / last30.length;
  const variance = last30.reduce((a, b) => a + Math.pow(b - mean30, 2), 0) / last30.length;
  const stdDev30 = Math.sqrt(variance);
  // ✅ ADD THIS LINE — saves stdDev30 so calculate_SS_B2B can read it
  demand.stdDev30 = stdDev30;

  // Calculate B2C safety stock using Z-score and standard deviation
  return Z * stdDev30 * Math.sqrt(leadTime);
}

function calculate_SS_BULK(demand, leadTime, CONFIG, sku, bulkSkuSet) {
  if (!bulkSkuSet || !bulkSkuSet.has(sku)) return 0;
  const bulkSizes = Array.isArray(demand.bulkOrderSizes) ? demand.bulkOrderSizes.slice() : [];
  const bulkOrders = demand.bulkOrders || 0;

  // No BULK history → no SS_BULK
  if (bulkOrders === 0 || bulkSizes.length === 0) return 0;

  // --- Step 1: Remove outliers (qty > mean + 2×stdDev) ---
  const mean = bulkSizes.reduce((a, b) => a + b, 0) / bulkSizes.length;
  const variance = bulkSizes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / bulkSizes.length;
  const stdDev = Math.sqrt(variance);
  const outlierThreshold = mean + 2 * stdDev;

  const cleanedSizes = bulkSizes.filter(s => s <= outlierThreshold);

  // If all orders are outliers (edge case), fall back to median
  const workingSizes = cleanedSizes.length > 0 ? cleanedSizes : bulkSizes;

  // --- Step 2: Percentile of cleaned sizes ---
  workingSizes.sort((a, b) => a - b);
  const n = workingSizes.length;
  const pct = CONFIG.BULK_PERCENTILE / 100;           // e.g. 75 → 0.75
  const idx = Math.floor(pct * (n - 1));
  const percentileSize = workingSizes[idx];

  // --- Step 3: Expected BULK orders during lead time ---
  const bulkFrequency = bulkOrders / CONFIG.SALES_HISTORY_DAYS; // orders per day
  const expectedBulkDuringLeadTime = bulkFrequency * leadTime;

  // --- Final SS_BULK ---
  const SS_BULK = percentileSize * expectedBulkDuringLeadTime;

  return SS_BULK;
}



function calculate_SS_B2B(demand, mode, CONFIG) {
  const b2bOrders = demand.b2bOrders || 0;
  const b2bUnits = demand.b2bUnits || 0;
  const orderSizes = Array.isArray(demand.b2bOrderSizes) ? demand.b2bOrderSizes : [];

  // No regular B2B activity → no SS_B2B
  if (b2bOrders === 0 || b2bUnits === 0 || orderSizes.length === 0) return 0;

  // Average order size
  const avgSize = b2bUnits / b2bOrders;

  // Average interval between B2B orders (days)
  const avgInterval = CONFIG.SALES_HISTORY_DAYS / b2bOrders;

  // Coefficient of Variation — uses B2C stdDev as demand volatility proxy
  const ads30 = demand._adsB2C || 0;
  const stdDev30 = demand.stdDev30 || 0;
  const CV = ads30 > 0 ? (stdDev30 / ads30) : 0;

  // CV factor: high volatility → full order, low volatility → half order
  const CV_factor = CV >= 0.5 ? 1.0 : 0.5;

  // √(avgInterval) = statistically grounded interval factor
  // Replaces arbitrary PROTECTION_DAYS multiplier
  const SS_B2B = avgSize * CV_factor * Math.sqrt(avgInterval);

  return SS_B2B;
}



/**
 * ===================================================================
 * INVENTORY & STOCK
 * ===================================================================
/**
 * Calculates total available stock.
 *
 * - Standalone stock comes from Inventory Data:
 *     nodeStock = InStock (Fulfillable) + Inbound (Shipped)
 *
 * - Kits ADD inventory to their components:
 *     For each KIT SKU with stock:
 *       childTotal += kitStock * qtyPerCombo
 *
 * - Combos (non-kit parents) do NOT affect inventory.
 *
 * @param {Array} inventoryData  - rows from Inventory Data
 * @param {Map} componentMap     - parentSku -> [{ sku, qty }]
 * @param {Array} productData    - rows from Product Master (not used here but kept for signature consistency)
 * @param {Set} kitSkuSet        - set of SKUs that are kit_product
 */
//function calculateAvailableStock(inventoryData, componentMap, productData, kitSkuSet) {
  function calculateAvailableStock(inventoryData, componentMap, productData, kitSkuSet, explodeExclusionSet) {
  const standaloneStockMap = new Map();  // direct stock per SKU (incl. KIT SKUs)
  const stockByLocationMap = new Map();
  const reservedMap = new Map();

  // 1. Standalone stock and reserved
  for (const row of inventoryData) {
    if (!ArrayOfRow(row) || !row[0]) continue; 
    
    const sku = getValue(row, SHEETS.inventory, 'Master SKU');
    if (!sku) continue;

    const location = getValue(row, SHEETS.inventory, 'Channel Name') || 'Warehouse';
    const inStock = getValue(row, SHEETS.inventory, 'InStock (Fulfillable)', true);
    const inbound = getValue(row, SHEETS.inventory, 'Inbound (Shipped)', true);
    const reserved = getValue(row, SHEETS.inventory, 'Reserved (Total)', true);

    //const nodeStock = inStock + inbound;
    const nodeStock = inStock + inbound + reserved;

    standaloneStockMap.set(sku, (standaloneStockMap.get(sku) || 0) + nodeStock);

    if (!stockByLocationMap.has(sku)) stockByLocationMap.set(sku, {});
    //stockByLocationMap.get(sku)[location] = nodeStock;
    const locMap = stockByLocationMap.get(sku);
    locMap[location] = (locMap[location] || 0) + nodeStock;

    reservedMap.set(sku, (reservedMap.get(sku) || 0) + reserved);
  }

 // 2. Kits contribute child inventory
const kitsContributionMap = new Map();

// for (const kitSku of kitSkuSet) {
//   const kitStock = standaloneStockMap.get(kitSku) || 0;
//   if (kitStock <= 0) continue;

//   const components = componentMap.get(kitSku);
//   if (!components || components.length === 0) continue;

//   for (const comp of components) {
//     const childSku = comp.sku;
//     const qtyPerCombo = comp.qty || 1;
//     const added = kitStock * qtyPerCombo;
//     kitsContributionMap.set(childSku, (kitsContributionMap.get(childSku) || 0) + added);
//   }
// }

// REPLACE WITH:
for (const kitSku of kitSkuSet) {
  // Skip kit stock contribution if kitSku is in exclusion set
  if (explodeExclusionSet.has(kitSku)) {
    Logger.log('EXPLODE_EXCLUSION: skipping kit stock for ' + kitSku);
    continue;
  }

  const kitStock = standaloneStockMap.get(kitSku) || 0;
  if (kitStock <= 0) continue;

  const components = componentMap.get(kitSku);
  if (!components || components.length === 0) continue;

  for (const comp of components) {
    const childSku = comp.sku;
    const qtyPerCombo = comp.qty || 1;
    const added = kitStock * qtyPerCombo;
    kitsContributionMap.set(childSku,
      (kitsContributionMap.get(childSku) || 0) + added);
  }
}
for (const [childSku, kitQty] of kitsContributionMap.entries()) {
  if (kitQty <= 0) continue;
  if (!stockByLocationMap.has(childSku)) stockByLocationMap.set(childSku, {});
  const locMap = stockByLocationMap.get(childSku);
  locMap['Kit Stock'] = (locMap['Kit Stock'] || 0) + kitQty;
}

// 3. Final available = standalone + kits contribution
const availableStockMap = new Map();
const allSkus = new Set([
  ...standaloneStockMap.keys(),
  ...kitsContributionMap.keys()
]);

for (const sku of allSkus) {
  const standalone = standaloneStockMap.get(sku) || 0;
  const fromKits = kitsContributionMap.get(sku) || 0;
  availableStockMap.set(sku, standalone + fromKits);
}

  // grossStockMap = standalone stock (for reference)
  const grossStockMap = standaloneStockMap;

  return { availableStockMap, grossStockMap, stockByLocationMap, reservedMap };
}


/**
 * ===================================================================
 * PO BALANCE, IN-TRANSIT & HISTORY (USING PO STATUS ID)
 * ===================================================================
 */

/**
 * Calculates:
 *  - inProduction per SKU (from Internal PO Tracker → Qty Remaining)
 *  - inTransit per SKU (from EE Purchase Orders → PO Status ID = 3, Pending Qty)
 *  - per-SKU PO history (from EE Purchase Orders → PO Status ID = 5)
 */


function calculatePOBalance(eePoData) {
  const CONFIG = getConfig();
  const inProductionMap = new Map();
  const inProductionPOsMap = new Map();
  const inTransitSupplierMap = new Map();
  const inTransitSupplierPOs = new Map();
  const historyBySku = new Map();

  const today = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // ================================================================
  // EE PURCHASE ORDERS — always runs
  // Handles: inTransit + history
  // Handles: inProduction (PENDING_PIPELINE) only if source = ee_po/both
  // ================================================================
  const eeSheetName = SHEETS.ee_po;

  for (const row of eePoData) {
    if (!ArrayOfRow(row) || !row[0]) continue;

    const sku = getValue(row, eeSheetName, 'SKU');
    if (!sku) continue;

    const poRef = getValue(row, eeSheetName, 'PO Ref Num') || '';
    const originalQty = getValue(row, eeSheetName, 'Original Quantity', true);
    const pendingQty = getValue(row, eeSheetName, 'Pending Quantity', true);
    const statusIdRaw = getValue(row, eeSheetName, 'PO Status ID');
    const statusId = statusIdRaw !== null && statusIdRaw !== undefined
      ? String(statusIdRaw).trim() : '';
    const createdStr = getValue(row, eeSheetName, 'PO Created Date');
    const updatedStr = getValue(row, eeSheetName, 'PO Updated Date');

    let transportMode = 'Unknown';
    if (poRef.toUpperCase().startsWith('A-')) transportMode = 'AIR';
    else if (poRef.toUpperCase().startsWith('S-')) transportMode = 'SEA';

    if (originalQty <= 0) continue;

    if (statusId === '3') {
      const transitQty = pendingQty;
      if (transitQty <= 0) continue;

      if (poRef === 'PENDING_PIPELINE') {
        // → inProduction from EE PO — only if config allows
        if (
          CONFIG.PENDING_PIPELINE_SOURCE === 'ee_po' ||
          CONFIG.PENDING_PIPELINE_SOURCE === 'both'
        ) {
          inProductionMap.set(sku,
            (inProductionMap.get(sku) || 0) + transitQty);

          if (!inProductionPOsMap.has(sku)) inProductionPOsMap.set(sku, []);
          inProductionPOsMap.get(sku).push({
            poId: poRef,
            qty: transitQty,
            status: 'In Production',
            transportMode: 'Unknown',
            etaDate: null,
            daysRemaining: null,
            isDelayed: false,
            source: 'ee_po'
          });
        }
        // If source = po_lines only → skip PENDING_PIPELINE entirely

      } else {
        // → inTransit — ALWAYS runs regardless of config
        inTransitSupplierMap.set(sku,
          (inTransitSupplierMap.get(sku) || 0) + transitQty);

        if (!inTransitSupplierPOs.has(sku)) inTransitSupplierPOs.set(sku, []);
        inTransitSupplierPOs.get(sku).push({
          poId: poRef,
          qty: transitQty,
          status: 'In Transit',
          transportMode: transportMode,
          etaDate: null,
          daysRemaining: null,
          isDelayed: false,
          source: 'ee_po'
        });
      }
    }

    // --- HISTORY: always runs ---
    if (statusId === '5') {
      const historyQty = originalQty;
      const orderDate = createdStr ? new Date(createdStr) : null;
      const receivedDate = updatedStr ? new Date(updatedStr) : null;

      let actualLeadTime = 0;
      if (orderDate && receivedDate &&
          !isNaN(orderDate.getTime()) && !isNaN(receivedDate.getTime())) {
        actualLeadTime = Math.round(
          (receivedDate.getTime() - orderDate.getTime()) / dayMs
        );
      }

      if (!historyBySku.has(sku)) historyBySku.set(sku, []);
      const vendorCode = getValue(row, eeSheetName, 'Vendor Code') || '';
      historyBySku.get(sku).push({
        poId: poRef,
        qty: historyQty,
        orderDate: orderDate ? orderDate.toISOString() : null,
        receivedDate: receivedDate ? receivedDate.toISOString() : null,
        transportMode: transportMode,
        actualLeadTime: actualLeadTime,
        vendorCode: vendorCode
      });
    }
  }

  // ================================================================
  // SOURCE B: Purchase_Order_Lines → inProduction only
  // ================================================================
  if (
    CONFIG.PENDING_PIPELINE_SOURCE === 'po_lines' ||
    CONFIG.PENDING_PIPELINE_SOURCE === 'both'
  ) {
    try {
      const poData = getSheetData(SHEETS.purchase_orders);
      const openPoMap = new Map();

      for (const row of poData) {
        if (!ArrayOfRow(row) || !row[0]) continue;
        const poId = getValue(row, SHEETS.purchase_orders, 'po_id');
        const poStatus = getValue(row, SHEETS.purchase_orders, 'po_status');
        const plannedMode = getValue(row, SHEETS.purchase_orders, 'planned_mode') || 'Unknown';
        //if (poId && poStatus === 'OPEN') {
          const activeStatuses = ['OPEN', 'PARTIALLY_SHIPPED'];
        if (poId && activeStatuses.includes(poStatus)) {
          openPoMap.set(poId, { mode: plannedMode.toUpperCase() });
        }
      }

      Logger.log('SOURCE B — Open POs found: ' + openPoMap.size);

      const poLinesData = getSheetData(SHEETS.po_lines);
      const poLinesSheet = SHEETS.po_lines;

      for (const row of poLinesData) {
        if (!ArrayOfRow(row) || !row[0]) continue;

        const sku = getValue(row, poLinesSheet, 'sku');
        if (!sku) continue;

        const poId = getValue(row, poLinesSheet, 'po_id');
        if (!openPoMap.has(poId)) continue;

        const orderedQty = getValue(row, poLinesSheet, 'ordered_qty', true);
        const fulfilledQty = getValue(row, poLinesSheet, 'fulfilled_qty', true);
        const pendingQty = orderedQty - fulfilledQty;

        if (pendingQty <= 0) continue;

        const transportMode = openPoMap.get(poId).mode;

        inProductionMap.set(sku,
          (inProductionMap.get(sku) || 0) + pendingQty);

        if (!inProductionPOsMap.has(sku)) inProductionPOsMap.set(sku, []);
        inProductionPOsMap.get(sku).push({
          poId: poId,
          qty: pendingQty,
          status: 'In Production',
          transportMode: transportMode,
          etaDate: null,
          daysRemaining: null,
          isDelayed: false,
          source: 'po_lines'
        });
      }

      Logger.log('SOURCE B — po_lines processing complete.');

    } catch (err) {
      Logger.log('Purchase_Order_Lines source error: ' + err.message);
    }
  }

  // ================================================================
  // Build final poBalanceMap
  // ================================================================
  const poBalanceMap = new Map();
  const allSkus = new Set([
    ...inProductionMap.keys(),
    ...inProductionPOsMap.keys(),
    ...inTransitSupplierMap.keys(),
    ...historyBySku.keys()
  ]);

  for (const sku of allSkus) {
    poBalanceMap.set(sku, {
      inProduction: inProductionMap.get(sku) || 0,
      inProductionPOs: inProductionPOsMap.get(sku) || [],
      inTransitSupplier: inTransitSupplierMap.get(sku) || 0,
      inTransitSupplierPOs: inTransitSupplierPOs.get(sku) || [],
      history: historyBySku.get(sku) || []
    });
  }

  return poBalanceMap;
}

/**
 * ===================================================================
 * METRICS & RULES
 * ===================================================================
 */

/**
 * Calculates sales metrics for the UI modal.
 */
function calculateSalesMetrics(demand) {
  let salesVelocity = 0;
  if (demand.total30to60Day > 0) {
    salesVelocity = ((demand.total30Day - demand.total30to60Day) / demand.total30to60Day) * 100;
  } else if (demand.total30Day > 0) {
    salesVelocity = 100;
  }

  // Round to 1 decimal place
  salesVelocity = Number(salesVelocity.toFixed(1));

  return {
    total90Day: demand.total90Day,
    total30Day: demand.total30Day,
    salesVelocity: salesVelocity
  };
}

function calculateRecommendedOrderQty(avgDailySales, monthlyMovingAvg, productRules, supplyPipeline, mode, CONFIG) {
  const safetyStockUnits = productRules.Safety_Stock_Units || 0;
  const baseLeadTime = productRules.Lead_Time_Days || 0; // already includes transit for SEA, transit only for AIR
  const moq = productRules.MOQ || 0;

  // ✅ Use configurable buffers
  const bufferDays = mode === 'sea' ? CONFIG.BUFFER_SEA : CONFIG.BUFFER_AIR;

  // ADS priority: use MMA if available, else fall back to avgDailySales
  //const ads = monthlyMovingAvg > 0 ? (monthlyMovingAvg / 30) : avgDailySales;
  const ads = avgDailySales;


  // Target stock = Safety + ADS × (Lead Time + Buffer)
  const targetStock = safetyStockUnits + (ads * (baseLeadTime + bufferDays));

  let requiredQty = targetStock - supplyPipeline;

  if (requiredQty <= 0) {
    return { targetStock, reorderQty: 0 };
  }

  let reorderQty;

  if (mode === 'sea' && moq > 0) {
    // ✅ SEA: MOQ-based rounding (no 50% rule)
    reorderQty = Math.ceil(requiredQty / moq) * moq;
    if (reorderQty < 0) reorderQty = 0; // safety
    // ✅ ADD THIS: if we need stock but rounding gave 0, use 1 MOQ
    if (requiredQty > 0 && reorderQty === 0) reorderQty = moq;
  } else {
    // ✅ AIR: ignore MOQ, just ceil the requirement
    reorderQty = Math.ceil(requiredQty);
  }

  //return { targetStock, reorderQty };
    return {
    targetStock,
    reorderQty,
    rawReorderQty: Math.ceil(requiredQty)  // before MOQ rounding
  };
}

/**
 * Determines urgency level based on Days of Cover and Lead Time.
 *  - critical (Urgent): daysOfCover < leadTime
 *  - warning (Low Stock): leadTime <= daysOfCover < leadTime + 15
 *  - healthy otherwise
 */
function getUrgencyLevel(daysOfCover, leadTime) {
  if (daysOfCover <= 0) return 'critical';
  if (daysOfCover < leadTime) return 'critical';
  if (daysOfCover < leadTime + 15) return 'warning';
  return 'healthy';
}

/**
 * ===================================================================
 * API ENTRY POINTS
 * ===================================================================
 */

/**
 * Main GET entry point for the Web App. Routes requests to forecast or analytics.
 */
 function doGet(e) {
  try {
    const request = e.parameter.request;
    const action  = e.parameter.action;
    const mode    = e.parameter.mode || 'sea';
    let result    = {};

    // ── Finance GET routes (use ?action=...) ──────────────────────────────
    if (!request && action) {
      switch (action) {
        case 'ping':
          return successResponse_({ message: 'pong', timestamp: new Date().toISOString() });
        case 'get_vendor_accounts':
          return successResponse_({ records: getSheetData_('VendorAccounts') });
        case 'get_purchase_invoices':
          return successResponse_({ records: getSheetData_('PurchaseInvoices') });
        default:
          return errorResponse_('Action not supported via GET: ' + action);
      }
    }

    // ── No request param → backward-compat: return PO data (old Code.gs URL) ──
    if (!request) {
      result = getPurchaseOrdersData();
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── Inventory Forecasting GET routes (use ?request=...) ──────────────
    switch (request) {
      case 'forecast':
        result = e.parameter.debug == '1'
          ? runForecastDebug(mode, e)
          : runFullForecast(mode, e);
        break;
      case 'trace':
        result = runSkuTrace(mode, e);
        break;
      case 'analytics':
        result = runAnalyticsReport();
        break;
      case 'purchase_orders':
        result = getPurchaseOrdersData();
        break;
      default:
        throw new Error(
          "Invalid 'request' parameter. Must be 'forecast', 'trace', 'analytics', or 'purchase_orders'."
        );
    }

    clearCache();

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log("Error in doGet: " + error.message + " (Stack: " + error.stack + ")");
    return ContentService
      .createTextOutput(JSON.stringify({
        error: "Error in doGet: " + error.message + " (Stack: " + error.stack + ")"
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


function getPurchaseOrdersData() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("EE Purchase Orders");

  if (!sheet) {
    return { error: true, message: 'Sheet "EE Purchase Orders" not found.' };
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return { headers: [], lines: [] };
  }

  var h = data[0].map(function(col) { return col.toString().trim().toLowerCase(); });

  var poIdIdx       = findCol(h, ["po id",           "po_id"]);
  var poRefIdx      = findCol(h, ["po ref num",      "po_ref_num",   "po_ref", "ref_num", "reference_number"]);
  var vendorNameIdx = findCol(h, ["vendor name",     "vendor_name",  "supplier_name", "vendor"]);
  var vendorCodeIdx = findCol(h, ["vendor code",     "vendor_code",  "supplier_code"]);
  var statusIdx     = findCol(h, ["po status id",    "po_status_id", "status_id", "po_status", "status"]);
  var totalValIdx   = findCol(h, ["total po value",  "total_po_value", "total_value", "po_value"]);
  var createdIdx    = findCol(h, ["po created date", "po_created_date", "created_date", "date_created"]);
  var updatedIdx    = findCol(h, ["po updated date", "po_updated_date", "updated_date", "date_updated"]);
  var skuIdx        = findCol(h, ["sku"]);
  var origQtyIdx    = findCol(h, ["original quantity",  "original_quantity", "ordered_qty", "ordered_quantity", "quantity"]);
  var pendingQtyIdx = findCol(h, ["pending quantity",   "pending_quantity",  "pending_qty", "fulfilled_qty", "fulfillment_qty"]);
  var itemPriceIdx  = findCol(h, ["item price",         "item_price",        "unit_price",  "price"]);

  if (skuIdx === -1) skuIdx = 0;

  var headersMap = {};
  var linesList  = [];

  for (var i = 1; i < data.length; i++) {
    var row      = data[i];
    var poId     = poIdIdx  !== -1 ? (row[poIdIdx]  || "").toString().trim() : "";
    var poRefNum = poRefIdx !== -1 ? (row[poRefIdx] || "").toString().trim() : "";

    if (!poRefNum) poRefNum = poId;
    if (!poId)     poId     = poRefNum;
    if (!poRefNum) continue;

    if (!headersMap[poRefNum]) {
      headersMap[poRefNum] = {
        po_id:           poId,
        po_ref_num:      poRefNum,
        vendor_name:     vendorNameIdx !== -1 ? (row[vendorNameIdx] || "").toString().trim() || null : null,
        vendor_code:     vendorCodeIdx !== -1 ? (row[vendorCodeIdx] || "").toString().trim() || null : null,
        po_status_id:    statusIdx     !== -1 ? (row[statusIdx]     || "").toString().trim() || null : null,
        total_po_value:  totalValIdx   !== -1 ? (parseFloat(row[totalValIdx])  || null) : null,
        po_created_date: createdIdx    !== -1 ? (row[createdIdx]    || "").toString().trim() || null : null,
        po_updated_date: updatedIdx    !== -1 ? (row[updatedIdx]    || "").toString().trim() || null : null,
      };
    }

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
  return { headers: headersList, lines: linesList };
}


/**
 * Main POST entry point for the Web App (e.g., creating a PO).
 */

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');

    const action = payload.action;

    // 🔒 NORMALIZE draftId (GLOBAL)
    const normalizedDraftId =
      payload.draftId ||
      payload.id ||
      (payload.draft && payload.draft.id);

    if (normalizedDraftId) {
      payload.draftId = normalizedDraftId;
    }

    let result;
    switch (payload.action) {


      case 'run_inventory_forecast':
      case 'forecast':   // ✅ alias for UI
        result = apiRunInventoryForecast(payload);
        break;

      // 🟢 NEW: Forecast → Draft
     case 'create_draft_from_forecast': {
          //const effectivePayload = payload.payload || payload;
          const effectivePayload = payload.payload ?? payload;
          result = apiCreateDraftFromForecast(effectivePayload);
         break;
    }

      case 'get_draft_orders':
      case 'get_drafts':
          result = apiGetDraftOrders();
        break;

      case 'get_draft_by_id':
      case 'get_draft_details':
          result = apiGetDraftById(payload.draftId);
        break;

       // ✅ Vendor dropdown master list (FIX for issue #4)
      case 'get_vendor_masters':
        result = apiGetVendorMasters();
        break;

      case 'cancel_draft':
          result = apiCancelDraft(payload.id);
        break;

      case "search_sku_catalog":
          result = apiSearchSkuCatalog(payload.query);
        break;

      case "add_sku_to_draft":
         result = apiAddSkuToDraft(payload.draftId, payload.sku, payload.qty);
        break;

      case "save_draft":
          result = apiSaveDraft(payload);
        break;


      case "submit_draft":
          result = apiSubmitDraft_(payload);
        break;

      //case 'save_customization':
        //  return apiSaveCustomization(payload);  // ← return directly, not result =

        // REPLACE WITH:
      case 'save_customization':
          return apiSaveCustomization(payload.payload || payload);

      case "get_pos":
          result = apiGetPurchaseOrders_(payload);
        break;

      case "get_purchase_order_details":
          result = apiGetPurchaseOrderDetails_(payload);
        break;

      // 🚚 Vendor Shipment — Upload & Normalize (Phase 1)
      case "upload_shipment_docs": {
        result = apiUploadAndNormalizeVendorShipment(payload);
        break;
      }

      case "get_product_master":
        result = apiGetProductMasterList();
        break;

      case "allocate_to_open_pos":
        result = apiAllocateToOpenPOs(payload);
        break;

      case "get_review_data":
        result = apiGetReviewData(payload);
        break;

      case 'create_manual_draft':
        result = apiCreateManualDraft(payload);
        break;

      case 'get_open_batches':
        result = apiGetOpenBatches(payload);
        break;

      case 'create_vendor_shipment':
          result = apiCreateVendorShipment(payload);
        break;


      case 'get_batches':
          result = getBatches();
        break;

      case 'get_batch_details':
          result = getBatchDetails(payload.batch_id);
        break;

      case 'get_batches_finance':       return getBatchesFinance();
      case 'get_batch_finance_detail':  return getBatchFinanceDetail(payload.batch_id);
      case 'update_batch_tracking':     return updateBatchTracking(payload);
      case 'get_fx_rates':              return getFXRates();
      case 'log_payment':               return logPayment(payload);
      case 'get_payments':              return getPayments(payload);
      case 'get_vendor_accounts':       return getVendorAccounts();
      case 'get_agent_invoices':        return getAgentInvoices();
      case 'log_agent_invoice':         return logAgentInvoice(payload);
      case 'map_invoice_shipments':     return mapInvoiceToShipments(payload);
      case 'get_shipment_costing':    result = getShipmentCosting(payload); break;
      case 'update_shipment_costing': result = updateShipmentCosting(payload); break;
      case 'sync_shipment_costing':   result = syncShipmentCostingApi(); break;
      case 'update_shipment_finance': result = updateShipmentFinance(payload); break;
      case 'close_po':                result = apiClosePo_(payload); break;
      case 'get_pending_lines':       result = apiGetPendingLines_(payload); break;
      case 'get_sku_history':         result = apiGetSKUHistory_(payload); break;

      case 'get_forecasting_config':
        return apiGetForecastingConfig();

      case 'save_forecasting_config':
        return apiSaveForecastingConfig(payload);

      case 'get_amazon_forecast':
        result = apiGetAmazonForecast();
        break;
 
      case 'confirm_amazon_shipment_plan':
        result = apiConfirmAmazonShipmentPlan(payload);
        break;
 
      case 'get_amazon_config':
        result = apiGetAmazonConfig();
        break;
 
      case 'save_amazon_config':
        result = apiSaveAmazonConfig(payload);
        break;
 
      case 'reset_amazon_config':
        result = resetAmazonConfig();
        break;

      case 'verify_user':
        return apiVerifyUser(payload);

      case 'get_amazon_sku_supply_chain':
        result = apiGetAmazonSkuSupplyChain(payload);
        break;
        
      case 'getNewSkuRequests':
        result = apiGetNewSkuRequests(payload); break;
      case 'getNewSkuRequestById':
        result = apiGetNewSkuRequestById(payload); break;
      case 'saveNewSkuDraft':
        result = apiSaveNewSkuDraft(payload); break;
      case 'getNextAvailableSku':
        result = apiGetNextAvailableSku(payload); break;
      case 'getPricingConfig':
        result = apiGetPricingConfig(payload); break;
      case 'getTagsByCategory':
        result = apiGetTagsByCategory(payload); break;
      case 'createSkuOnEasyEcom':
        result = apiCreateSkuOnEasyEcom(payload); break;
      case 'createSkuOnZoho':
        result = apiCreateSkuOnZoho(payload); break;
      case 'createSkuOnShopify':
        result = apiCreateSkuOnShopify(payload); break;
      case 'updateEePurchaseOrder':
        result = apiUpdateEePurchaseOrder(payload); break;
      case 'rejectSkuRequest':
        result = apiRejectSkuRequest(payload); break;
      case 'createManualSkuRequest':
        result = apiCreateManualSkuRequest(payload); break;
      case 'getParentSkuDetails':
        result = apiGetParentSkuDetails(payload); break;
      case 'getBrands':
        result = apiGetBrands(payload); break;
      case 'getVariants':
        result = apiGetVariants(payload); break;
    
            // ── FINANCE CASES (merged from finance.gs) ────────────────────────────
      // NOTE: get_vendor_accounts, get_batches_finance, get_fx_rates already
      //       exist above and those handlers take precedence.

      case 'get_purchase_invoices':
        return successResponse_({ records: getSheetData_('PurchaseInvoices') });

      case 'get_payment_logs':
        return successResponse_({ records: getSheetData_('PaymentLogs') });

      case 'get_settlement_ledger':
      case 'get_settlement_records':
        return successResponse_({ records: getSheetData_('SettlementLedger') });

      case 'get_vendor_ledger':
        return successResponse_({ records: getSheetData_('VendorLedger') });

      case 'get_vendor_shipments':
        return successResponse_({ records: getSheetData_('Vendor_Shipments') });

      case 'add_invoice':
      case 'add_purchase_invoice':
      case 'insert_purchase_invoice':
        return addPurchaseInvoice(payload);

      case 'insert_vendor_account':
      case 'add_vendor_account':
        return addVendorAccount(payload);

      case 'add_payment':
      case 'add_payment_log':
      case 'insert_payment_log':
        return addPaymentLog(payload);

      case 'add_adjustment_entry':
        return addAdjustmentEntry(payload);

      case 'log_settlement_record':
      case 'add_settlement':
        if (payload.record) {
          const _sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SettlementLedger');
          const _r = payload.record;
          _sheet.appendRow([
            _r.Date || _r.date || new Date().toISOString().split('T')[0],
            'SET-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            _r['Payment ID'] || _r.paymentId || '',
            _r['Vendor ID']  || _r.vendorCode || '',
            _r['Invoice ID'] || _r.invoiceId  || '',
            _r.RMB || _r.rmb || 0,
            _r.ER1 || _r.er1 || 0,
            _r.ER2 || _r.er2 || 0,
            _r['Forex Gain / Loss'] || _r.forexGainLoss || 0,
            _r.Notes || _r.remarks || _r.notes || 'Manual Entry'
          ]);
          return successResponse_({ message: 'Settlement logged' });
        }
        return errorResponse_('No record provided for settlement');

      case 'update_purchase_invoice':
        return updatePurchaseInvoice_(payload);

      case 'update_payment_log':
        return updatePaymentLog_(payload);

      case 'commit_eod_engine':
        return commitEodEngine_(payload);

      case 'sync_shipments':
        syncShipmentsToInvoices_();
        return successResponse_({ message: 'Synchronization triggered successfully' });

      case 'delete_row':
        return deleteRowByUniqueId_(payload.table, payload.idColumn, payload.targetId);


      default:
        throw new Error(`Invalid 'action' parameter: ${action}`);
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log("Error in doPost: " + error.message + " (Stack: " + error.stack + ")");
    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'error',
        message: error.message
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


/**
 * ===================================================================
 * CORE FORECASTING ORCHESTRATOR
 * ===================================================================
 */

/**
 * Runs the complete forecasting model based on the active transport mode.
 * mode: 'sea' | 'air'
 */
/**
/**
 * Returns a Set of SKUs that are kit products
 * based on EE Component Master (Product Type = 'kit_product').
 */
function getKitSkuSet(componentData) {
  const kitSet = new Set();
  const sheetName = SHEETS.components;

  for (const row of componentData) {
    if (!ArrayOfRow(row) || !row[0]) continue;

    const parentSku = getValue(row, sheetName, 'Parent SKU');
    const productType = getValue(row, sheetName, 'Product Type');
    if (parentSku && productType === 'kit_product') {
      kitSet.add(parentSku);
    }
  }

  return kitSet;
}

/**
 * Runs the complete forecasting model based on the active transport mode.
 * mode: 'sea' | 'air'
 */


function runFullForecast(mode) {

  // Load ALL data once
  const CONFIG = getConfig();  // ← add here
  const allProductData = getSheetData(SHEETS.products);
  const componentData = getSheetData(SHEETS.components);
  const salesData = getSheetData(SHEETS.sales);
  const inventoryData = getSheetData(SHEETS.inventory);
  const eePoData = getSheetData(SHEETS.ee_po);
  //const internalPoData = getSheetData(SHEETS.internal_po);
  const excludeSet = getExcludeSet();
  const bulkSkuSet = getBulkSkuSet();  // NEW
  const r2 = (v) => Math.round((v || 0) * 100) / 100;  // 2 decimal places
  const ri = (v) => Math.round(v || 0);                  // integer

    // ← ADD HERE — after data loads, before step 1️⃣
  const explodeExclusionSet = new Set();
  for (const row of allProductData) {
    const sku = getValue(row, SHEETS.products, 'SKU');
    const explodeExclusion = getValue(row, SHEETS.products, 'Explode_Exclusion');
    if (sku && String(explodeExclusion).trim() === 'Yes') {
      explodeExclusionSet.add(sku);
    }
  }
  Logger.log('Explode_Exclusion SKUs: ' + explodeExclusionSet.size);

  // 1️⃣ Identify KIT SKUs
  const kitSkuSet = getKitSkuSet(componentData);

  // 2️⃣ Build BOM
  const componentMap = buildComponentMap(componentData, allProductData);

  // 3️⃣ Calculate inventory with KIT contribution
  // const {
  //   availableStockMap,
  //   grossStockMap,
  //   stockByLocationMap,
  //   reservedMap
  // } = calculateAvailableStock(inventoryData, componentMap, allProductData, kitSkuSet);
  // REPLACE WITH:
const {
  availableStockMap,
  grossStockMap,
  stockByLocationMap,
  reservedMap
} = calculateAvailableStock(inventoryData, componentMap, allProductData, kitSkuSet, explodeExclusionSet);


  // 4️⃣ Calculate PO balances
  //const poBalanceMap = calculatePOBalance(internalPoData, eePoData);
  const poBalanceMap = calculatePOBalance(eePoData);


// ADD THIS — build RMB price map before demand calculation
const rmbPriceMap = new Map();
for (const row of allProductData) {
  const sku = getValue(row, SHEETS.products, 'SKU');
  const rmbPrice = getValue(row, SHEETS.products, 'RMB_Price', true);
  if (sku) rmbPriceMap.set(sku, rmbPrice || 0);
}

  // 5️⃣ TRUE DEMAND calculation (Now includes b2bOrderSizes + SS_B2B)
  const {
  demandMap,
  dailySalesHistoryMap,
  channelMap,
  comboDemandMap
} = calculateTrueDemand(salesData, componentMap, mode, CONFIG, explodeExclusionSet, rmbPriceMap);
//} = calculateTrueDemand(salesData, componentMap, mode, CONFIG, explodeExclusionSet);

  // 6️⃣ Filter SKUs
  const productData = allProductData.filter(row => {
    const sku = getValue(row, SHEETS.products, "SKU");
    const category = getValue(row, SHEETS.products, "Category Name");
    const cost = getValue(row, SHEETS.products, "Cost", true);
    const isKit = sku && kitSkuSet.has(sku);

    // if (!sku) return false;
    // if (excludeSet.has(sku)) return false;

    // // Prefix + suffix exclusion
    // const skuUpper = sku.toUpperCase();
    // if (SKU_EXCLUDE_PREFIXES.some(prefix => skuUpper.startsWith(prefix.toUpperCase()))) return false;
    // if (SKU_EXCLUDE_SUFFIXES.some(suffix => skuUpper.endsWith(suffix.toUpperCase()))) return false;

    //   // if ((category || '').trim().toLowerCase() !== 'active_skus') return false;
    //   // if (isKit) return false;

    //   // REPLACE WITH:
    // if ((category || '').trim().toLowerCase() !== 'active_skus') return false;
    // if (isKit && !explodeExclusionSet.has(sku)) return false;
    // ↑ Kit SKUs with Explode_Exclusion=Yes are allowed through as standalone

    // REPLACE WITH:
if (!sku) return false;
if (excludeSet.has(sku)) return false;

/*const isExplodeExcluded = explodeExclusionSet.has(sku);

// Explode_Exclusion SKUs bypass prefix/suffix/kit filters
if (!isExplodeExcluded) {
  const skuUpper = sku.toUpperCase();
  if (SKU_EXCLUDE_PREFIXES.some(prefix => 
    skuUpper.startsWith(prefix.toUpperCase()))) return false;
  if (SKU_EXCLUDE_SUFFIXES.some(suffix => 
    skuUpper.endsWith(suffix.toUpperCase()))) return false;
  if (isKit) return false;
}*/

const isExplodeExcluded = explodeExclusionSet.has(sku);

// ALL mode — skip prefix/suffix/kit exclusions entirely
if (mode !== 'all') {
  if (!isExplodeExcluded) {
    const skuUpper = sku.toUpperCase();
    if (SKU_EXCLUDE_PREFIXES.some(prefix =>
      skuUpper.startsWith(prefix.toUpperCase()))) return false;
    if (SKU_EXCLUDE_SUFFIXES.some(suffix =>
      skuUpper.endsWith(suffix.toUpperCase()))) return false;
    if (isKit) return false;
  }
}

if ((category || '').trim().toLowerCase() !== 'active_skus') return false;

    const demand = demandMap.get(sku) || { avgDailySales: 0 };
    const ads = demand.avgDailySales || 0;
    const mma = ads * 30;

    // AIR MODE FILTER
    /*if (mode === "air") {
      const isHighCost = cost > CONFIG.MIN_COST_AIR;    
      const isLowMover = mma < CONFIG.LOW_MMA_AIR;

      if (!isHighCost && !isLowMover) return false;
    }
    */
    // AIR MODE — no cost filter, all active SKUs included
    // SEA MODE FILTER
    if (mode === "all") {
    return true; // include everything that passed category check
  }

    // SEA MODE FILTER
    if (mode === "sea") {
    //if (rmbPrice >= CONFIG.MIN_COST_AIR) return false;
   //   if (rmbPrice > 0 && rmbPrice >= CONFIG.MIN_COST_AIR) return false;
     const rowRmbPrice = getValue(row, SHEETS.products, 'RMB_Price', true) || 0;
  if (rowRmbPrice > 0 && rowRmbPrice >= CONFIG.MIN_COST_AIR) return false;

  }
    return true;
  });

  // 7️⃣ Combo Usage Map
  const productNameMap = new Map(allProductData.map(r => [
    getValue(r, SHEETS.products, 'SKU'),
    getValue(r, SHEETS.products, 'Product Name')
  ]));

  const comboUsageMap = new Map();
  for (const [parentSku, components] of componentMap.entries()) {
    const comboName = productNameMap.get(parentSku) || parentSku;

    for (const comp of components) {
      if (!comboUsageMap.has(comp.sku)) comboUsageMap.set(comp.sku, []);
      comboUsageMap.get(comp.sku).push({
        comboSKU: parentSku,
        comboName: comboName,
        qtyPerCombo: comp.qty || 1
      });
    }
  }

  // 8️⃣ Build Final Forecast Output
  const finalForecastData = [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (const row of productData) {
    const sku = getValue(row, SHEETS.products, 'SKU');
    const unitCost = getValue(row, SHEETS.products, 'Cost', true);
    const leadTimeProduction = getValue(row, SHEETS.products, 'Lead_Time', true);
    const moq = getValue(row, SHEETS.products, 'MOQ', true);
    const rmbPrice = getValue(row, SHEETS.products, 'RMB_Price', true) || 0;
    const weightGm = getValue(row, SHEETS.products, 'Weight', true) || 0;
    const brand = getValue(row, SHEETS.products, 'Brand') || '';

    // MUST: Fetch demand FIRST (fixes your error)
    const demand = demandMap.get(sku) || {
      avgDailySales: 0,
      _adsB2C: 0,
      _adsB2B: 0,
      SS_B2B: 0
    };

    // SAFETY STOCK (Manual)
    const sheetSafetyStock = getValue(row, SHEETS.products, 'Threshold_Qty', true) || 0;
    // Calculate B2C SS and B2B SS
      // Lead times
    const leadTimeSea = (leadTimeProduction || 0) + CONFIG.SEA_TRANSIT_DAYS;
    const leadTimeAir = CONFIG.AIR_TRANSIT_DAYS;
    const leadTimeBase = mode === "sea" ? leadTimeSea : leadTimeAir;


    
let SS_B2C;
if (mode === 'sea') {
  SS_B2C = calculate_SS_B2C(demand, leadTimeSea, CONFIG); // For Sea
} else if (mode === 'air') {
  SS_B2C = calculate_SS_B2C(demand, CONFIG.AIR_TRANSIT_DAYS, CONFIG); // For Air
} else {
  SS_B2C = 0; // Default fallback (if required)
}

    //const SS_B2B = (mode === 'sea') ? calculate_SS_B2B(demand) : 0;
// PHASE-2: Calculate B2B Safety Stock (Only for Sea)
  let SS_B2B = 0;
  if (mode === 'sea') {
    SS_B2B = calculate_SS_B2B(demand,mode, CONFIG); 
  }

  //const finalSafetyStock = SS_B2C + SS_B2B + (sheetSafetyStock || 0);
  const SS_BULK = (mode === 'sea')
  ? calculate_SS_BULK(demand, leadTimeSea, CONFIG, sku, bulkSkuSet)
  : 0;
  // NEW — add this line
  const suggestBulkSs = !bulkSkuSet.has(sku) && (demand.bulkOrders || 0) >= 2;

  const finalSafetyStock = SS_B2C + SS_B2B + SS_BULK + (sheetSafetyStock || 0);

  demand.SS_B2C = SS_B2C;
  demand.SS_B2B = SS_B2B;
  demand.finalSafetyStock = finalSafetyStock; // Total Safety Stock for this SKU

    // Effective Final Safety Stock
    //const effectiveSafetyStockUnits = finalSafetyStock + extraInventory;
    const effectiveSafetyStockUnits = finalSafetyStock;
    // Inventory
    const availableStock =
      availableStockMap.get(sku) || grossStockMap.get(sku) || 0;

    const poBalance = poBalanceMap.get(sku) || {
      inProduction: 0,
      inProductionPOs: [],        // NEW
      inTransitSupplier: 0,
      inTransitSupplierPOs: [],
      history: []
    };

  

    // Demand
    const avgDailySales = demand.avgDailySales || 0;
    const monthlyMovingAvg = avgDailySales * 30;
    const daysOfCover = avgDailySales > 0 ? availableStock / avgDailySales : 999;

    // ✅ ADD: effective cover includes inTransit for urgency only
    const inTransitQty = poBalance.inTransitSupplier || 0;
    const effectiveDaysOfCover = avgDailySales > 0 ? (availableStock + inTransitQty) / avgDailySales : 999;

    // Supply pipeline
    const supplyPipeline =
      availableStock +
      (poBalance.inProduction || 0) +
      (poBalance.inTransitSupplier || 0);

    // Reorder logic
    const productRules = {
      Cost: unitCost,
      Lead_Time_Days: leadTimeBase,
      Safety_Stock_Units: effectiveSafetyStockUnits,  // NEW
      MOQ: moq
    };

    //const { targetStock, reorderQty } = calculateRecommendedOrderQty(
      const { targetStock, reorderQty, rawReorderQty } = calculateRecommendedOrderQty(
      avgDailySales,
      monthlyMovingAvg,
      productRules,
      supplyPipeline,
      mode,
      CONFIG
    );

    // Sales metrics
    const {
      total90Day: total90dSales,
      total30Day: total30dSales,
      salesVelocity
    } = calculateSalesMetrics(demand);

    // Sales history
    const salesHistory90 = dailySalesHistoryMap.get(sku) || [];
    const cutoff30 = new Date(now - 30 * dayMs);
    const salesHistory30 = salesHistory90.filter(d => d.date >= cutoff30);

    // Peak sales day
    let peakSalesDay = { units: 0, date: 'N/A' };
    if (salesHistory90.length > 0) {
      const best = salesHistory90.reduce(
        (max, d) => (d.units > max.units ? d : max),
        salesHistory90[0]
      );
      peakSalesDay = {
        units: best.units,
        date: best.date.toISOString().split('T')[0]
      };
    }

    // Channel Split
    const channelUnitsMap = channelMap.get(sku) || new Map();
    let channelTotalUnits = 0;
    for (const v of channelUnitsMap.values()) channelTotalUnits += v;

    const channelSplit = {};
    if (channelTotalUnits > 0) {
      for (const [channelKey, units] of channelUnitsMap.entries()) {
        channelSplit[channelKey] = {
          units: units,
          percentage: (units / channelTotalUnits) * 100
        };
      }
    }

    // Urgency Logic
    //const urgencyLevel = getUrgencyLevel(daysOfCover, leadTimeBase);
    //const urgencyLevel = getUrgencyLevel(effectiveDaysOfCover, leadTimeBase);
    // --- Stockout gap detection ---
// Check if available stock runs out BEFORE earliest inbound arrives
let stockoutGapDays = 0;
const inTransitPOs = poBalance.inTransitSupplierPOs || [];

if (inTransitPOs.length > 0 && avgDailySales > 0) {
  // Find earliest arriving PO
  const earliestPO = inTransitPOs.reduce((min, po) => {
    return (po.daysRemaining < min.daysRemaining) ? po : min;
  }, inTransitPOs[0]);

  const daysUntilInbound = Math.max(earliestPO.daysRemaining, 0);

  if (daysOfCover < daysUntilInbound) {
    stockoutGapDays = Math.ceil(daysUntilInbound - daysOfCover);
  }
}

// Urgency: force critical if stockout gap exists
let urgencyLevel = getUrgencyLevel(effectiveDaysOfCover, leadTimeBase);
if (stockoutGapDays > 0) urgencyLevel = 'critical';


    const stockoutDate = new Date(now + daysOfCover * dayMs).toISOString();
    const recommendedReorderDate = new Date(
      now + (daysOfCover - leadTimeBase) * dayMs
    ).toISOString();

    const forecast = {
      riskLevel:
        urgencyLevel === "critical"
          ? "high"
          : urgencyLevel === "warning"
          ? "medium"
          : "low",
      stockoutDate: stockoutDate,
      recommendedReorderDate: recommendedReorderDate,
      daysOfCoverRemaining: Math.floor(daysOfCover)
    };

    // Combo impact
    //const comboUsage = comboUsageMap.get(sku) || [];
    // NEW — enrich with sales data from comboBreakdown
    const comboUsage = comboUsageMap.get(sku) || [];
    const comboBreakdown = demand.comboBreakdown || {};
    const enrichedComboUsage = comboUsage.map(combo => ({
      ...combo,
      unitsSold90Days: comboBreakdown[combo.comboSKU] || 0
    }));
    const comboDemand90 = comboDemandMap.get(sku) || 0;
    const comboImpactPercent =
      total90dSales > 0 ? (comboDemand90 / total90dSales) * 100 : 0;
    
    // FINAL OUTPUT RECORD
    // Add these helper functions at the top of runFullForecast,
// just before the finalForecastData loop:

const r2 = (v) => Math.round((v || 0) * 100) / 100;  // 2 decimal places
const ri = (v) => Math.round(v || 0);                  // integer

// Then update finalForecastData.push() as follows:

finalForecastData.push({
  masterSKU: sku,
  productName: getValue(row, SHEETS.products, 'Product Name'),
  unitCost: unitCost,
  mode: mode,

  businessRules: {
    supplier: getValue(row, SHEETS.products, 'Supplier_Code') || 'N/A',
    moq: moq,
    safetyStock: ri(effectiveSafetyStockUnits),
    unitCost: unitCost,
    leadTimeSea: leadTimeSea,
    leadTimeAir: leadTimeAir,
  },

  leadTimeAir: leadTimeAir,
  leadTimeSea: leadTimeSea,

  sale15Days: ri(demand.total15Day),
  sale30Days: ri(total30dSales),
  sale90Days: ri(total90dSales),
  total30dSales: ri(total30dSales),
  total90dSales: ri(total90dSales),

  monthlyMovingAvg: r2(monthlyMovingAvg),
  avgDailySales: r2(avgDailySales),
  avgDailySalesX30: r2(avgDailySales * 30),

  salesVelocity: salesVelocity,  // already rounded to 1dp

  adsB2C: r2(demand._adsB2C),
  adsB2B: r2(demand._adsB2B),

  mmaNormal: r2((demand._adsB2C || 0) * 30),
  mmaFinal: r2(demand.avgDailySales * 30),

  sheetSafetyStock: ri(sheetSafetyStock),
  SS_B2C: ri(SS_B2C),
  SS_B2B: ri(SS_B2B),
  SS_BULK: ri(SS_BULK),
  finalSafetyStock: ri(finalSafetyStock),
  effectiveSafetyStockUnits: ri(effectiveSafetyStockUnits),

  safetyStockDebug: {
    SS_B2C: ri(SS_B2C),
    SS_B2B: ri(SS_B2B),
    SS_BULK: ri(SS_BULK),
    sheetSafetyStock: ri(sheetSafetyStock),
    finalSafetyStock: ri(finalSafetyStock),
    effectiveSafetyStockUnits: ri(effectiveSafetyStockUnits),
    SS_B2C_days: avgDailySales > 0 ? Math.round(SS_B2C / avgDailySales) : 0,
    SS_B2B_days: avgDailySales > 0 ? Math.round(SS_B2B / avgDailySales) : 0,
    SS_BULK_days: avgDailySales > 0 ? Math.round(SS_BULK / avgDailySales) : 0,
    finalSafetyStock_days: avgDailySales > 0 ? Math.round(finalSafetyStock / avgDailySales) : 0,
  },

  demandCoverageDebug: {
    avgDailySales: r2(avgDailySales),
    leadTimeBase: leadTimeBase,
    bufferDays: mode === 'sea' ? CONFIG.BUFFER_SEA : CONFIG.BUFFER_AIR,
    leadTimePlusBuffer: leadTimeBase + (mode === 'sea' ? CONFIG.BUFFER_SEA : CONFIG.BUFFER_AIR),
    adsCoverage: ri(avgDailySales * (leadTimeBase + (mode === 'sea' ? CONFIG.BUFFER_SEA : CONFIG.BUFFER_AIR))),
    targetStock: ri(effectiveSafetyStockUnits + (avgDailySales * (leadTimeBase + (mode === 'sea' ? CONFIG.BUFFER_SEA : CONFIG.BUFFER_AIR)))),
    supplyPipeline: ri(supplyPipeline),
    requiredQty: ri((effectiveSafetyStockUnits + (avgDailySales * (leadTimeBase + (mode === 'sea' ? CONFIG.BUFFER_SEA : CONFIG.BUFFER_AIR)))) - supplyPipeline)
  },

  suggestBulkSs: suggestBulkSs,
  b2bRegularUnits: ri(demand.b2bRegularUnits),
  bulkUnits: ri(demand.bulkUnits),
  bulkOrders: demand.bulkOrders || 0,
  b2bUnits: ri(demand.b2bUnits),
  b2bOrders: demand.b2bOrders || 0,

  inStock: ri(availableStock),
  inProduction: ri(poBalance.inProduction),
  inProductionPOs: poBalance.inProductionPOs || [],
  inTransit: ri(poBalance.inTransitSupplier),
  inboundETA: (poBalance.inTransitSupplierPOs || [])[0]?.etaDate || null,

  daysOfCover: Math.floor(daysOfCover),
  effectiveDaysOfCover: Math.floor(effectiveDaysOfCover),
  reorderQty: Math.ceil(reorderQty),
  rawReorderQty: Math.ceil(rawReorderQty || reorderQty),  // pre-MOQ
  urgencyLevel: urgencyLevel,
  stockoutGapDays: stockoutGapDays,
  rmb_price: rmbPrice,
  weight_gm: weightGm,
  brand: brand,
  rmb_price: rmbPrice || null,          // null instead of 0 — easier to check on frontend
  rmb_price_missing: rmbPrice === 0,    // explicit flag

  kitStockContribution: ri((() => {
    let total = 0;
    for (const kitSku of kitSkuSet) {
      const components = componentMap.get(kitSku) || [];
      const comp = components.find(c => c.sku === sku);
      if (!comp) continue;
      const kitStock = grossStockMap.get(kitSku) || 0;
      total += kitStock * (comp.qty || 1);
    }
    return total;
  })()),


      stockByLocation: stockByLocationMap.get(sku) || {},
      reservedQty: reservedMap.get(sku) || 0,
      inTransitPOs: poBalance.inTransitSupplierPOs || [],

      salesHistory90: salesHistory90.map(d => ({
        date: d.date.toISOString().split("T")[0],
        units: d.units
      })),
      salesHistory30: salesHistory30.map(d => ({
        date: d.date.toISOString().split("T")[0],
        units: d.units
      })),

      peakSalesDay: peakSalesDay,

      outOfStock90Days: 0,
      outOfStock30Days: 0,
      lastStockoutStart: null,
      lastStockoutEnd: null,

      //comboUsage: comboUsage,
      comboUsage: enrichedComboUsage,  // ← new
      comboImpactPercent: comboImpactPercent,

      poHistory: poBalance.history || [],

      salesHistory90B2C: demand.dailyHistoryB2C? demand.dailyHistoryB2C.map(d => ({ date: d.date.toISOString().split('T')[0], units: d.units })): [],

      channelSplit: channelSplit,

      forecast: forecast
    });
  }

  return finalForecastData;
}


function runSkuTrace(mode, e) {
  Logger.log("===== SKU TRACE MODE START =====");

  const sku = e?.parameter?.sku;
  if (!sku) {
    Logger.log("ERROR: No SKU provided.");
    return { error: "No SKU provided" };
  }

  // Get full forecast data
  const fullData = runFullForecast(mode, e);

  // Find the specific SKU
  const item = fullData.find(x => x.masterSKU === sku);

  if (!item) {
    Logger.log("SKU not found: " + sku);
    Logger.log("===== SKU TRACE MODE END =====");
    return { error: "SKU not found", sku };
  }

  // ========== BUILD TRACE REPORT ==========
  const trace = {
    sku: item.masterSKU,
    productName: item.productName,

    // --- RAW SALES ---
    sales: {
      sale15Days: item.sale15Days,
      sale30Days: item.sale30Days,
      sale90Days: item.sale90Days,
      total30dSales: item.total30dSales,
      total90dSales: item.total90dSales
    },

    // --- ADS DETAILS ---
    ads: {
      adsB2C: item.adsB2C || 0,
      adsB2B: item.adsB2B || 0,
      adsTotal: item.avgDailySales || (item.adsB2C + item.adsB2B),
      avgDailySalesX30: item.avgDailySalesX30,
      mmaNormal: item.mmaNormal,
      mmaFinal: item.mmaFinal
    },

    // --- B2B RAW ---
    b2b: {
      b2bUnits: item.b2bUnits || 0,
      b2bOrders: item.b2bOrders || 0
    },

    // --- INVENTORY ---
    inventory: {
      inStock: item.inStock,
      inTransit: item.inTransit,
      reservedQty: item.reservedQty,
      inboundETA: item.inboundETA
    },

    // --- PIPELINE ---
    pipeline: {
      inTransitPOs: item.inTransitPOs || []
    },

    // --- COVER & FORECAST ---
    forecast: {
      daysOfCover: item.daysOfCover,
      salesVelocity: item.salesVelocity,
      leadTimeAir: item.leadTimeAir,
      leadTimeSea: item.leadTimeSea
    },

    // --- REORDER ---
    reorder: {
      reorderQty: item.reorderQty,
      urgencyLevel: item.urgencyLevel
    },

    // --- ALL FIELDS RAW ---
    rawItemData: item
  };

  Logger.log("TRACE RESULT:\n" + JSON.stringify(trace, null, 2));
  Logger.log("===== SKU TRACE MODE END =====");

  return trace;
}



function runForecastDebug(mode, e) {
  Logger.log("===== DEBUG FORECAST START =====");

  const fullData = runFullForecast(mode, e);
  const debugSKU = e?.parameter?.sku;

  // If single SKU is requested → return only that one
  if (debugSKU) {
    const found = fullData.find(row => row.masterSKU === debugSKU);

    if (found) {
      Logger.log("DEBUG RESULT:\n" + JSON.stringify(found, null, 2));
      Logger.log("===== DEBUG FORECAST END =====");
      return [found];  
    } else {
      Logger.log("SKU NOT FOUND: " + debugSKU);
      Logger.log("===== DEBUG FORECAST END =====");
      return [];
    }
  }

  // If no SKU → return top 10 by MMA_Final
  const top10 = fullData
    .sort((a, b) => (b.mmaFinal || 0) - (a.mmaFinal || 0))
    .slice(0, 10);

  Logger.log("===== TOP 10 (REAL DATA) =====");
  Logger.log(JSON.stringify(top10, null, 2));
  Logger.log("===== DEBUG FORECAST END =====");

  return top10;
}


/**
 * ===================================================================
 * ANALYTICS ENDPOINT
 * ===================================================================
 */

/**
 * Runs the simple Inventory Analytics report.
 */
function runAnalyticsReport() {
  const productData = getSheetData(SHEETS.products);
  const inventoryData = getSheetData(SHEETS.inventory);
  
  const analyticsMap = new Map();
  
  // Map product costs and basic info
  for (const row of productData) {
    if (!ArrayOfRow(row) || !row[0]) continue;
    const sku = getValue(row, SHEETS.products, 'SKU');
    const cost = getValue(row, SHEETS.products, 'Cost', true);
    const name = getValue(row, SHEETS.products, 'Product Name');
    if (sku) {
      analyticsMap.set(sku, {
        cost: cost,
        name: name,
        stock: 0,
        inTransit: 0,
        totalValue: 0
      });
    }
  }
  
  // Add inventory data (stock; in-transit from vendor is handled elsewhere)
  for (const row of inventoryData) {
    if (!ArrayOfRow(row) || !row[0]) continue;
    const sku = getValue(row, SHEETS.inventory, 'Master SKU');
    const inStock = getValue(row, SHEETS.inventory, 'InStock (Fulfillable)', true);
    const inbound = getValue(row, SHEETS.inventory, 'Inbound (Shipped)', true);
    
    if (analyticsMap.has(sku)) {
      const data = analyticsMap.get(sku);
      const nodeStock = inStock + inbound;
      data.stock += nodeStock;
      data.totalValue += nodeStock * data.cost;
      analyticsMap.set(sku, data);
    }
  }

  const masterSkuList = Array.from(analyticsMap.entries()).map(([id, data]) => ({
    id: id,
    name: data.name,
    cost: data.cost,
    stockOnHand: data.stock,
    stockInTransit: 0, // vendor in-transit not included here
    stockOnOrder: 0,   // could be extended with inProduction
    totalValue: data.totalValue,
    salesVelocity: 10, // placeholder
    ean: null
  }));

  return { 
    masterSkuList: masterSkuList,
    spendByVendorData: [
      { name: 'Vendor A', value: 45000 },
      { name: 'Vendor B', value: 32000 }
    ]
  };
}

function getBulkSkuSet() {
  const bulkSkuSet = new Set();
  try {
    const data = getSheetData(SHEETS.bulk_skus);
    for (const row of data) {
      if (!ArrayOfRow(row)) continue;
      const sku = getValue(row, SHEETS.bulk_skus, 'SKU');
      if (sku) bulkSkuSet.add(sku.trim());
    }
  } catch (err) {
    Logger.log('BULK_SKUs sheet not found: ' + err.message);
  }
  return bulkSkuSet;
}

function testSourceB() {
  clearCache();
  const CONFIG = getConfig();
  Logger.log('PENDING_PIPELINE_SOURCE: ' + CONFIG.PENDING_PIPELINE_SOURCE);

  const poData = getSheetData(SHEETS.purchase_orders);
  Logger.log('Purchase_Orders rows: ' + poData.length);

  const poLinesData = getSheetData(SHEETS.po_lines);
  Logger.log('Purchase_Order_Lines rows: ' + poLinesData.length);

  // Check OPEN POs
  let openCount = 0;
  for (const row of poData) {
    const poId = getValue(row, SHEETS.purchase_orders, 'po_id');
    const status = getValue(row, SHEETS.purchase_orders, 'po_status');
    Logger.log('PO: ' + poId + ' | status: [' + status + ']');
    if (status === 'OPEN') openCount++;
  }
  Logger.log('OPEN POs: ' + openCount);
}
function testSheetsConstant() {
  Logger.log('SHEETS object: ' + JSON.stringify(SHEETS));
  Logger.log('purchase_orders value: ' + SHEETS.purchase_orders);
  Logger.log('po_lines value: ' + SHEETS.po_lines);
}

function fixMalformedPoId() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const poSheet = ss.getSheetByName('Purchase_Orders');
  const poLineSheet = ss.getSheetByName('Purchase_Order_Lines');

  const oldId = 'PO-Puzzle Wholesale260319-1';
  const newId = 'PO-PW260319-1';

  // Fix Purchase_Orders
  const poData = poSheet.getDataRange().getValues();
  for (let i = 1; i < poData.length; i++) {
    if (String(poData[i][0]).trim() === oldId) {
      poSheet.getRange(i + 1, 1).setValue(newId);
      Logger.log('Fixed PO header: ' + oldId + ' → ' + newId);
    }
  }

  // Fix Purchase_Order_Lines
  const lineData = poLineSheet.getDataRange().getValues();
  const poIdCol = 1; // po_id is second column (index 1)
  let fixedLines = 0;
  for (let i = 1; i < lineData.length; i++) {
    if (String(lineData[i][poIdCol]).trim() === oldId) {
      poLineSheet.getRange(i + 1, poIdCol + 1).setValue(newId);
      fixedLines++;
    }
  }

  SpreadsheetApp.flush();
  Logger.log('Fixed ' + fixedLines + ' line items');
}

function debugInProduction() {
  clearCache();

  const poData = getSheetData(SHEETS.purchase_orders);
  const openPoMap = new Map();

  // Build open PO map
  for (const row of poData) {
    if (!ArrayOfRow(row) || !row[0]) continue;
    const poId = getValue(row, SHEETS.purchase_orders, 'po_id');
    const poStatus = getValue(row, SHEETS.purchase_orders, 'po_status');
    const plannedMode = getValue(row, SHEETS.purchase_orders, 'planned_mode') || 'Unknown';
    const activeStatuses = ['OPEN', 'PARTIALLY_SHIPPED', 'IN_TRANSIT', 'CONFIRMED'];

    if (poId && activeStatuses.includes(poStatus)) {
    //if (poId && poStatus === 'OPEN') {
      openPoMap.set(poId, { mode: plannedMode.toUpperCase() });
    }
  }

  Logger.log('Open POs: ' + openPoMap.size);
  for (const [poId, info] of openPoMap.entries()) {
    Logger.log('  ' + poId + ' | mode: ' + info.mode);
  }

  // Check all lines
  const poLinesData = getSheetData(SHEETS.po_lines);
  const poLinesSheet = SHEETS.po_lines;

  let totalLines = 0;
  let skippedNoOpenPO = 0;
  let skippedZeroQty = 0;
  let included = 0;

  for (const row of poLinesData) {
    if (!ArrayOfRow(row) || !row[0]) continue;
    totalLines++;

    const sku = getValue(row, poLinesSheet, 'sku');
    const poId = getValue(row, poLinesSheet, 'po_id');
    const orderedQty = getValue(row, poLinesSheet, 'ordered_qty', true);
    const fulfilledQty = getValue(row, poLinesSheet, 'fulfilled_qty', true);
    const pendingQty = orderedQty - fulfilledQty;

    if (!openPoMap.has(poId)) {
      skippedNoOpenPO++;
      Logger.log('SKIPPED (no open PO): SKU=' + sku +
        ' | po_id=[' + poId + ']' +
        ' | orderedQty=' + orderedQty);
      continue;
    }

    if (pendingQty <= 0) {
      skippedZeroQty++;
      Logger.log('SKIPPED (zero pending): SKU=' + sku +
        ' | ordered=' + orderedQty +
        ' | fulfilled=' + fulfilledQty);
      continue;
    }

    included++;
    Logger.log('INCLUDED: SKU=' + sku +
      ' | po_id=' + poId +
      ' | pending=' + pendingQty);
  }

  Logger.log('=== SUMMARY ===');
  Logger.log('Total lines: ' + totalLines);
  Logger.log('Included: ' + included);
  Logger.log('Skipped - no open PO: ' + skippedNoOpenPO);
  Logger.log('Skipped - zero pending qty: ' + skippedZeroQty);
}

function testExplodeExclusion() {
  clearCache();
  const allProductData = getSheetData(SHEETS.products);

  const explodeExclusionSet = new Set();
  for (const row of allProductData) {
    const sku = getValue(row, SHEETS.products, 'SKU');
    const val = getValue(row, SHEETS.products, 'Explode_Exclusion');
    if (sku && String(val).trim() === 'Yes') {
      explodeExclusionSet.add(sku);
    }
  }

  Logger.log('Explode_Exclusion SKUs (' + explodeExclusionSet.size + '):');
  for (const sku of explodeExclusionSet) {
    Logger.log('  ' + sku);
  }
}

function testStep6Filter() {
  clearCache();
  const CONFIG = getConfig();
  const allProductData = getSheetData(SHEETS.products);
  const componentData = getSheetData(SHEETS.components);
  const kitSkuSet = getKitSkuSet(componentData);
  const excludeSet = getExcludeSet();

  const explodeExclusionSet = new Set();
  for (const row of allProductData) {
    const sku = getValue(row, SHEETS.products, 'SKU');
    const val = getValue(row, SHEETS.products, 'Explode_Exclusion');
    if (sku && String(val).trim() === 'Yes') explodeExclusionSet.add(sku);
  }

  let passed = 0;
  let blockedPrefix = 0;
  let blockedCategory = 0;
  let blockedKit = 0;
  let blockedExcludeList = 0;

  for (const row of allProductData) {
    const sku = getValue(row, SHEETS.products, 'SKU');
    const category = getValue(row, SHEETS.products, 'Category Name');
    const isKit = sku && kitSkuSet.has(sku);
    const isExplodeExcluded = explodeExclusionSet.has(sku);

    if (!sku) continue;
    if (excludeSet.has(sku)) { blockedExcludeList++; continue; }

    if (!isExplodeExcluded) {
      const skuUpper = sku.toUpperCase();
      if (SKU_EXCLUDE_PREFIXES.some(p => skuUpper.startsWith(p.toUpperCase()))) {
        blockedPrefix++; continue;
      }
      if (isKit) { blockedKit++; continue; }
    }

    if ((category || '').trim().toLowerCase() !== 'active_skus') {
      blockedCategory++; continue;
    }

    passed++;
  }

  Logger.log('Passed filter: ' + passed);
  Logger.log('Blocked by prefix: ' + blockedPrefix);
  Logger.log('Blocked by category: ' + blockedCategory);
  Logger.log('Blocked by kit: ' + blockedKit);
  Logger.log('Blocked by exclude list: ' + blockedExcludeList);
}
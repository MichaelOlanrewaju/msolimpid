// ═══════════════════════════════════════════════════════════════════════════════
// CODE.GS — MSO LIMPID CO. LTD & M&M OIL & GAS LTD
// Google Apps Script Backend — Operations Dashboard
// ───────────────────────────────────────────────────────────────────────────────
// HOW TO DEPLOY:
//   1. Go to script.google.com → New Project → paste this file
//   2. Replace REPLACE_WITH_MSO_SHEET_ID and REPLACE_WITH_MRS_SHEET_ID below
//   3. Run seedAllData() ONCE to populate your sheets with structure + mock data
//   4. Deploy → New Deployment → Web App → Execute as Me → Anyone → Deploy
//   5. Copy the Web App URL into your dashboard HTML files (SCRIPT_URL variable)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CONFIG ────────────────────────────────────────────────────────────────────
var CONFIG = {
  MSO_SHEET_ID: 'REPLACE_WITH_MSO_SHEET_ID',   // MSO Limpid Google Sheet ID
  MRS_SHEET_ID: 'REPLACE_WITH_MRS_SHEET_ID',   // M&M Oil & Gas Google Sheet ID
  TIMEZONE:     'Africa/Lagos',
  APP_NAME:     'MSO Limpid Operations',
  VERSION:      '1.0.0',

  // Fuel prices (₦ per litre/kg) — update these or use the price sheet
  PRICES: {
    MSO: { PMS: 891, AGO: 1161, LPG: 500 },
    MRS: { PMS: 891, AGO: 1161, LPG: 500 }
  },

  // Users — passwords are plain text here for simplicity; hash in production
  USERS: [
    { username: 'owner',   password: 'owner123',  role: 'owner',      station: 'both',  displayName: 'Idowu Egba' },
    { username: 'sup.mso', password: 'mso2025',   role: 'supervisor', station: 'mso',   displayName: 'MSO Supervisor' },
    { username: 'sup.mrs', password: 'mrs2025',   role: 'supervisor', station: 'mrs',   displayName: 'MRS Supervisor' },
    { username: 'chidi',   password: 'pump02',    role: 'attendant',  station: 'mso',   displayName: 'Chidi' },
    { username: 'emeka',   password: 'pump01',    role: 'attendant',  station: 'mrs',   displayName: 'Emeka' },
    { username: 'bola',    password: 'pump03',    role: 'attendant',  station: 'mrs',   displayName: 'Bola' },
    { username: 'fatima',  password: 'pump04',    role: 'attendant',  station: 'mrs',   displayName: 'Fatima' },
  ],

  // Sheet tab names
  TABS: {
    DAILY_SALES:     'DAILY_SALES',
    DISCHARGE:       'DISCHARGE',
    TANK_DIP:        'TANK_DIP',
    EXPENSES:        'EXPENSES',
    PRICE_HISTORY:   'PRICE_HISTORY',
    EDIT_REQUESTS:   'EDIT_REQUESTS',
    AUDIT_LOG:       'AUDIT_LOG',
    USERS:           'USERS',
    ANNOUNCEMENTS:   'ANNOUNCEMENTS',
    INCIDENTS:       'INCIDENTS',
    PURCHASE_ORDERS: 'PURCHASE_ORDERS',
    SYSTEM_LOG:      'SYSTEM_LOG',
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// HTTP ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var result = route(action, body);
    return respond(result);
  } catch(err) {
    return respond({ ok: false, error: err.message });
  }
}

function doGet(e) {
  var action = e.parameter.action;
  return respond(route(action, e.parameter));
}

function route(action, params) {
  switch(action) {
    case 'login':           return handleLogin(params);
    case 'getDashboard':    return handleGetDashboard(params);
    case 'saveSales':       return handleSaveSales(params);
    case 'saveDischarge':   return handleSaveDischarge(params);
    case 'saveDip':         return handleSaveDip(params);
    case 'saveExpense':     return handleSaveExpense(params);
    case 'updatePrice':     return handleUpdatePrice(params);
    case 'getRecords':      return handleGetRecords(params);
    case 'getPnL':          return handleGetPnL(params);
    case 'requestEdit':     return handleRequestEdit(params);
    case 'approveEdit':     return handleApproveEdit(params);
    case 'getAnnouncements':return handleGetAnnouncements(params);
    case 'ping':            return { ok: true, message: 'MSO Limpid API online', version: CONFIG.VERSION };
    default:                return { ok: false, error: 'Unknown action: ' + action };
  }
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

function handleLogin(p) {
  var u = p.username ? p.username.toLowerCase().trim() : '';
  var pw = p.password || '';
  var user = CONFIG.USERS.filter(function(x){ return x.username === u && x.password === pw; })[0];
  if (!user) return { ok: false, error: 'Invalid username or password' };
  auditLog(getSheet(user.station === 'mrs' ? 'MRS' : 'MSO'), 'LOGIN', user.username, 'Logged in');
  return {
    ok: true,
    username:    user.username,
    displayName: user.displayName,
    role:        user.role,
    station:     user.station,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

function handleGetDashboard(p) {
  var station = (p.station || 'mso').toUpperCase();
  var ss = getSheet(station);
  var today = todayStr();

  // Sales today
  var sales = readSheet(ss, CONFIG.TABS.DAILY_SALES);
  var todaySales = sales.filter(function(r){ return r.DATE === today; });

  // Pump totals
  var pumps = {};
  todaySales.forEach(function(r) {
    var k = r.PUMP_ID;
    if (!pumps[k]) pumps[k] = { litres: 0, naira: 0, product: r.PRODUCT };
    pumps[k].litres += parseFloat(r.LITRES || 0);
    pumps[k].naira  += parseFloat(r.AMOUNT || 0);
  });

  // Payment breakdown
  var payBreakdown = { Cash: 0, POS: 0, Transfer: 0 };
  todaySales.forEach(function(r) {
    var m = r.PAYMENT_METHOD || 'Cash';
    payBreakdown[m] = (payBreakdown[m] || 0) + parseFloat(r.AMOUNT || 0);
  });

  // Total revenue & litres
  var totalRevenue = todaySales.reduce(function(a,r){ return a + parseFloat(r.AMOUNT||0); }, 0);
  var totalLitres  = todaySales.reduce(function(a,r){ return a + parseFloat(r.LITRES||0); }, 0);

  // Expenses today
  var expenses = readSheet(ss, CONFIG.TABS.EXPENSES);
  var todayExp  = expenses.filter(function(r){ return r.DATE === today; });
  var totalExp  = todayExp.reduce(function(a,r){ return a + parseFloat(r.AMOUNT||0); }, 0);

  // Latest dip readings
  var dips = readSheet(ss, CONFIG.TABS.TANK_DIP);
  var latestDips = {};
  dips.forEach(function(r) {
    if (!latestDips[r.TANK] || r.DATE+r.TIME > latestDips[r.TANK].DATE+latestDips[r.TANK].TIME) {
      latestDips[r.TANK] = r;
    }
  });

  // 7-day sales for chart
  var chart7 = build7DayChart(ss);

  // Pending edit requests
  var edits = readSheet(ss, CONFIG.TABS.EDIT_REQUESTS);
  var pendingEdits = edits.filter(function(r){ return r.STATUS === 'PENDING'; });

  // Current prices
  var prices = readSheet(ss, CONFIG.TABS.PRICE_HISTORY);
  var currentPrices = {};
  prices.forEach(function(r) {
    if (!currentPrices[r.PRODUCT] || r.EFFECTIVE_DATE > currentPrices[r.PRODUCT].EFFECTIVE_DATE) {
      currentPrices[r.PRODUCT] = r;
    }
  });

  // Announcements
  var ann = readSheet(ss, CONFIG.TABS.ANNOUNCEMENTS);
  var activeAnn = ann.filter(function(r){ return r.ACTIVE === 'TRUE' || r.ACTIVE === true; });

  return {
    ok: true,
    station:      station,
    date:         today,
    totalRevenue: totalRevenue,
    totalLitres:  totalLitres,
    totalExpenses:totalExp,
    pumps:        pumps,
    payment:      payBreakdown,
    tanks:        latestDips,
    chart7:       chart7,
    recentSales:  todaySales.slice(-10).reverse(),
    expenses:     todayExp,
    pendingEdits: pendingEdits.length,
    prices:       currentPrices,
    announcements:activeAnn,
  };
}

function build7DayChart(ss) {
  var sales = readSheet(ss, CONFIG.TABS.DAILY_SALES);
  var days = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    days.push(formatDate(d));
  }
  return days.map(function(day) {
    var daySales = sales.filter(function(r){ return r.DATE === day; });
    return {
      date:    day,
      pms_L:   sumBy(daySales.filter(function(r){ return r.PRODUCT === 'PMS'; }), 'LITRES'),
      ago_L:   sumBy(daySales.filter(function(r){ return r.PRODUCT === 'AGO'; }), 'LITRES'),
      lpg_L:   sumBy(daySales.filter(function(r){ return r.PRODUCT === 'LPG'; }), 'LITRES'),
      pms_N:   sumBy(daySales.filter(function(r){ return r.PRODUCT === 'PMS'; }), 'AMOUNT'),
      ago_N:   sumBy(daySales.filter(function(r){ return r.PRODUCT === 'AGO'; }), 'AMOUNT'),
      total_N: sumBy(daySales, 'AMOUNT'),
    };
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAVE SALES
// ═══════════════════════════════════════════════════════════════════════════════
// Expected params: station, pump_id, product, opening_meter, closing_meter,
//                  litres, price_per_litre, amount, payment_method, attendant, notes

function handleSaveSales(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = ss.getSheetByName(CONFIG.TABS.DAILY_SALES);
  var id = generateId('SALE');

  tab.appendRow([
    id,
    p.date       || todayStr(),
    p.time       || timeStr(),
    p.pump_id    || '',
    p.product    || '',
    parseFloat(p.opening_meter  || 0),
    parseFloat(p.closing_meter  || 0),
    parseFloat(p.litres         || 0),
    parseFloat(p.price_per_litre|| 0),
    parseFloat(p.amount         || 0),
    p.payment_method || 'Cash',
    p.attendant  || p.username || '',
    p.notes      || '',
    'POSTED',
    id,
  ]);

  auditLog(ss, 'SAVE_SALES', p.username || '', 'Pump: ' + p.pump_id + ' | ' + p.litres + 'L | ₦' + p.amount);
  return { ok: true, id: id, message: 'Sales entry saved successfully' };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAVE DISCHARGE (truck delivery)
// ═══════════════════════════════════════════════════════════════════════════════

function handleSaveDischarge(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = ss.getSheetByName(CONFIG.TABS.DISCHARGE);
  var id = generateId('DISCH');

  tab.appendRow([
    id,
    p.date          || todayStr(),
    p.time          || timeStr(),
    p.product       || '',
    p.tank          || '',
    parseFloat(p.litres_ordered  || 0),
    parseFloat(p.litres_received || 0),
    p.truck_no      || '',
    p.driver_name   || '',
    p.waybill_no    || '',
    p.depot         || '',
    parseFloat(p.cost || 0),
    p.supervisor    || p.username || '',
    p.notes         || '',
    id,
  ]);

  auditLog(ss, 'DISCHARGE', p.username || '', p.product + ' | ' + p.litres_received + 'L received');
  return { ok: true, id: id, message: 'Discharge recorded successfully' };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAVE TANK DIP
// ═══════════════════════════════════════════════════════════════════════════════

function handleSaveDip(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = ss.getSheetByName(CONFIG.TABS.TANK_DIP);
  var id = generateId('DIP');

  tab.appendRow([
    id,
    p.date       || todayStr(),
    p.time       || timeStr(),
    p.tank       || '',
    parseFloat(p.reading_cm   || 0),
    parseFloat(p.litres       || 0),
    parseFloat(p.capacity     || 0),
    p.reading_type || 'MANUAL',
    p.staff      || p.username || '',
    p.notes      || '',
    id,
  ]);

  auditLog(ss, 'TANK_DIP', p.username || '', 'Tank: ' + p.tank + ' | ' + p.litres + 'L');
  return { ok: true, id: id, message: 'Tank dip recorded successfully' };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SAVE EXPENSE
// ═══════════════════════════════════════════════════════════════════════════════

function handleSaveExpense(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = ss.getSheetByName(CONFIG.TABS.EXPENSES);
  var id = generateId('EXP');

  tab.appendRow([
    id,
    p.date      || todayStr(),
    p.time      || timeStr(),
    p.category  || '',
    p.description || '',
    parseFloat(p.amount || 0),
    p.payment_method || 'Cash',
    p.receipt_no     || '',
    p.approved_by    || '',
    p.staff      || p.username || '',
    p.notes      || '',
    id,
  ]);

  auditLog(ss, 'EXPENSE', p.username || '', p.category + ' | ₦' + p.amount);
  return { ok: true, id: id, message: 'Expense recorded successfully' };
}


// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE PUMP PRICE
// ═══════════════════════════════════════════════════════════════════════════════

function handleUpdatePrice(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = ss.getSheetByName(CONFIG.TABS.PRICE_HISTORY);
  var id = generateId('PRICE');

  tab.appendRow([
    id,
    p.date           || todayStr(),
    p.time           || timeStr(),
    p.product        || '',
    parseFloat(p.old_price || 0),
    parseFloat(p.new_price || 0),
    p.effective_date || todayStr(),
    p.reason         || '',
    p.updated_by     || p.username || '',
    id,
  ]);

  auditLog(ss, 'PRICE_UPDATE', p.username || '', p.product + ': ₦' + p.old_price + ' → ₦' + p.new_price);
  return { ok: true, id: id, message: 'Price updated successfully' };
}


// ═══════════════════════════════════════════════════════════════════════════════
// RECORDS (query history)
// ═══════════════════════════════════════════════════════════════════════════════

function handleGetRecords(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = p.tab || CONFIG.TABS.DAILY_SALES;
  var from = p.from || '';
  var to   = p.to   || '';

  var rows = readSheet(ss, tab);
  if (from) rows = rows.filter(function(r){ return r.DATE >= from; });
  if (to)   rows = rows.filter(function(r){ return r.DATE <= to; });
  if (p.product) rows = rows.filter(function(r){ return r.PRODUCT === p.product; });
  if (p.pump_id) rows = rows.filter(function(r){ return r.PUMP_ID === p.pump_id; });

  return { ok: true, count: rows.length, records: rows };
}


// ═══════════════════════════════════════════════════════════════════════════════
// P&L REPORT
// ═══════════════════════════════════════════════════════════════════════════════

function handleGetPnL(p) {
  var station  = (p.station||'mso').toUpperCase();
  var ss       = getSheet(station);
  var from     = p.from || monthStartStr();
  var to       = p.to   || todayStr();

  var sales    = readSheet(ss, CONFIG.TABS.DAILY_SALES).filter(function(r){ return r.DATE >= from && r.DATE <= to; });
  var expenses = readSheet(ss, CONFIG.TABS.EXPENSES).filter(function(r){ return r.DATE >= from && r.DATE <= to; });
  var discharges = readSheet(ss, CONFIG.TABS.DISCHARGE).filter(function(r){ return r.DATE >= from && r.DATE <= to; });

  var totalRevenue  = sumBy(sales, 'AMOUNT');
  var totalExpenses = sumBy(expenses, 'AMOUNT');
  var totalCOGS     = sumBy(discharges, 'COST');
  var grossProfit   = totalRevenue - totalCOGS;
  var netProfit     = grossProfit - totalExpenses;

  // Product breakdown
  var products = ['PMS','AGO','LPG'];
  var byProduct = {};
  products.forEach(function(prod) {
    var ps = sales.filter(function(r){ return r.PRODUCT === prod; });
    byProduct[prod] = { litres: sumBy(ps,'LITRES'), revenue: sumBy(ps,'AMOUNT') };
  });

  // Daily trend
  var days = getDaysRange(from, to);
  var daily = days.map(function(d) {
    return {
      date: d,
      revenue:  sumBy(sales.filter(function(r){ return r.DATE === d; }), 'AMOUNT'),
      expenses: sumBy(expenses.filter(function(r){ return r.DATE === d; }), 'AMOUNT'),
    };
  });

  // Expense breakdown by category
  var expCats = {};
  expenses.forEach(function(r) {
    expCats[r.CATEGORY] = (expCats[r.CATEGORY] || 0) + parseFloat(r.AMOUNT || 0);
  });

  return {
    ok:           true,
    station:      station,
    from:         from,
    to:           to,
    totalRevenue: totalRevenue,
    totalCOGS:    totalCOGS,
    grossProfit:  grossProfit,
    totalExpenses:totalExpenses,
    netProfit:    netProfit,
    margin:       totalRevenue > 0 ? Math.round(netProfit/totalRevenue*100) : 0,
    byProduct:    byProduct,
    expensesByCategory: expCats,
    daily:        daily,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// EDIT REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

function handleRequestEdit(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var tab = ss.getSheetByName(CONFIG.TABS.EDIT_REQUESTS);
  var id = generateId('EDIT');

  tab.appendRow([
    id,
    todayStr(),
    timeStr(),
    p.record_id   || '',
    p.record_tab  || '',
    p.field       || '',
    p.old_value   || '',
    p.new_value   || '',
    p.reason      || '',
    p.requested_by || p.username || '',
    'PENDING',
    '',  // approved_by
    '',  // approved_at
    id,
  ]);

  auditLog(ss, 'EDIT_REQUEST', p.username || '', 'Record: ' + p.record_id + ' | Field: ' + p.field);
  return { ok: true, id: id, message: 'Edit request submitted. Awaiting owner approval.' };
}

function handleApproveEdit(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);

  // Update edit request status
  var editTab = ss.getSheetByName(CONFIG.TABS.EDIT_REQUESTS);
  var data = editTab.getDataRange().getValues();
  var headers = data[0];
  var idCol   = headers.indexOf('ID');
  var statCol = headers.indexOf('STATUS');
  var apprCol = headers.indexOf('APPROVED_BY');
  var aprtCol = headers.indexOf('APPROVED_AT');

  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === p.edit_id) {
      editTab.getRange(i+1, statCol+1).setValue(p.approve ? 'APPROVED' : 'REJECTED');
      editTab.getRange(i+1, apprCol+1).setValue(p.username);
      editTab.getRange(i+1, aprtCol+1).setValue(todayStr() + ' ' + timeStr());

      // If approved, apply the change to the target record
      if (p.approve) {
        applyEditToRecord(ss, data[i][headers.indexOf('RECORD_TAB')], data[i][headers.indexOf('RECORD_ID')], data[i][headers.indexOf('FIELD')], data[i][headers.indexOf('NEW_VALUE')]);
      }
      break;
    }
  }

  auditLog(ss, 'EDIT_' + (p.approve?'APPROVED':'REJECTED'), p.username || '', 'Edit ID: ' + p.edit_id);
  return { ok: true, message: (p.approve ? 'Edit approved and applied.' : 'Edit request rejected.') };
}

function applyEditToRecord(ss, tabName, recordId, field, newValue) {
  try {
    var tab  = ss.getSheetByName(tabName);
    var data = tab.getDataRange().getValues();
    var headers = data[0];
    var idCol    = headers.indexOf('ID');
    var fieldCol = headers.indexOf(field);
    if (fieldCol < 0) return;
    for (var i = 1; i < data.length; i++) {
      if (data[i][idCol] === recordId) {
        tab.getRange(i+1, fieldCol+1).setValue(newValue);
        break;
      }
    }
  } catch(e) {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

function handleGetAnnouncements(p) {
  var station = (p.station||'mso').toUpperCase();
  var ss = getSheet(station);
  var ann = readSheet(ss, CONFIG.TABS.ANNOUNCEMENTS);
  return { ok: true, announcements: ann.filter(function(r){ return r.ACTIVE === 'TRUE'; }) };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SHEET HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getSheet(station) {
  var id = (station||'').toUpperCase() === 'MRS' ? CONFIG.MRS_SHEET_ID : CONFIG.MSO_SHEET_ID;
  return SpreadsheetApp.openById(id);
}

function readSheet(ss, tabName) {
  var tab  = ss.getSheetByName(tabName);
  if (!tab) return [];
  var data = tab.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function(h){ return String(h).trim().toUpperCase().replace(/ /g,'_'); });
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i){ obj[h] = row[i]; });
    return obj;
  });
}

function auditLog(ss, action, user, detail) {
  try {
    var tab = ss.getSheetByName(CONFIG.TABS.AUDIT_LOG);
    tab.appendRow([todayStr(), timeStr(), action, user, detail, Session.getActiveUser().getEmail()]);
  } catch(e) {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// DATE & UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function todayStr() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}
function timeStr() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'HH:mm');
}
function formatDate(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}
function monthStartStr() {
  var d = new Date(); d.setDate(1);
  return formatDate(d);
}
function getDaysRange(from, to) {
  var days = [], d = new Date(from);
  var end = new Date(to);
  while (d <= end) { days.push(formatDate(d)); d.setDate(d.getDate()+1); }
  return days;
}
function sumBy(arr, key) {
  return arr.reduce(function(a, r){ return a + parseFloat(r[key] || 0); }, 0);
}
function generateId(prefix) {
  return (prefix || 'ID') + '_' + new Date().getTime() + '_' + Math.floor(Math.random()*1000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SEED DATA — RUN THIS ONCE TO POPULATE YOUR SHEETS
// ═══════════════════════════════════════════════════════════════════════════════
// In Apps Script editor: Run → seedAllData()
// This creates all tabs and fills them with realistic mock data.

function seedAllData() {
  Logger.log('Seeding MSO sheet...');
  seedStation('MSO');
  Logger.log('Seeding MRS sheet...');
  seedStation('MRS');
  Logger.log('Done! Both sheets populated.');
}

function seedStation(station) {
  var ss = getSheet(station);
  createAllTabs(ss, station);
  seedSales(ss, station);
  seedDischarge(ss, station);
  seedDips(ss, station);
  seedExpenses(ss, station);
  seedPrices(ss, station);
  seedUsers(ss);
  seedAnnouncements(ss, station);
  seedEditRequests(ss);
}

// ── TAB SCHEMAS ──────────────────────────────────────────────────────────────

function createAllTabs(ss, station) {
  var schemas = {
    DAILY_SALES: [
      'ID','DATE','TIME','PUMP_ID','PRODUCT',
      'OPENING_METER','CLOSING_METER','LITRES',
      'PRICE_PER_LITRE','AMOUNT','PAYMENT_METHOD',
      'ATTENDANT','NOTES','STATUS','REF'
    ],
    DISCHARGE: [
      'ID','DATE','TIME','PRODUCT','TANK',
      'LITRES_ORDERED','LITRES_RECEIVED','TRUCK_NO',
      'DRIVER_NAME','WAYBILL_NO','DEPOT','COST',
      'SUPERVISOR','NOTES','REF'
    ],
    TANK_DIP: [
      'ID','DATE','TIME','TANK','READING_CM',
      'LITRES','CAPACITY','READING_TYPE','STAFF','NOTES','REF'
    ],
    EXPENSES: [
      'ID','DATE','TIME','CATEGORY','DESCRIPTION',
      'AMOUNT','PAYMENT_METHOD','RECEIPT_NO',
      'APPROVED_BY','STAFF','NOTES','REF'
    ],
    PRICE_HISTORY: [
      'ID','DATE','TIME','PRODUCT',
      'OLD_PRICE','NEW_PRICE','EFFECTIVE_DATE',
      'REASON','UPDATED_BY','REF'
    ],
    EDIT_REQUESTS: [
      'ID','DATE','TIME','RECORD_ID','RECORD_TAB',
      'FIELD','OLD_VALUE','NEW_VALUE','REASON',
      'REQUESTED_BY','STATUS','APPROVED_BY','APPROVED_AT','REF'
    ],
    AUDIT_LOG: ['DATE','TIME','ACTION','USER','DETAIL','EMAIL'],
    USERS:     ['USERNAME','ROLE','DISPLAY_NAME','STATION','ACTIVE'],
    ANNOUNCEMENTS: ['ID','DATE','TITLE','MESSAGE','PRIORITY','ACTIVE','AUTHOR'],
    INCIDENTS: [
      'ID','DATE','TIME','TYPE','DESCRIPTION',
      'REPORTED_BY','STATUS','RESOLVED_AT','NOTES'
    ],
    PURCHASE_ORDERS: [
      'ID','DATE','PRODUCT','QUANTITY_L','SUPPLIER',
      'UNIT_PRICE','TOTAL_COST','STATUS','EXPECTED_DATE','NOTES'
    ],
    SYSTEM_LOG: ['DATE','TIME','EVENT','DETAILS'],
  };

  Object.keys(schemas).forEach(function(tabName) {
    var existing = ss.getSheetByName(tabName);
    var tab = existing || ss.insertSheet(tabName);
    if (!existing || tab.getLastRow() === 0) {
      var headers = schemas[tabName];
      tab.getRange(1, 1, 1, headers.length).setValues([headers]);
      tab.getRange(1, 1, 1, headers.length)
        .setBackground('#1a237e').setFontColor('#ffffff')
        .setFontWeight('bold').setFontSize(10);
      tab.setFrozenRows(1);
    }
  });
}

// ── SEED SALES (30 days of data) ─────────────────────────────────────────────

function seedSales(ss, station) {
  var tab = ss.getSheetByName(CONFIG.TABS.DAILY_SALES);
  if (tab.getLastRow() > 1) { Logger.log('DAILY_SALES already has data, skipping.'); return; }

  var pumps = station === 'MSO'
    ? [{id:'P1',prod:'PMS'},{id:'P2',prod:'PMS'},{id:'P3',prod:'PMS'},{id:'P4',prod:'PMS'},{id:'AP1',prod:'AGO'},{id:'LPG',prod:'LPG'}]
    : [{id:'P1',prod:'PMS'},{id:'P2',prod:'PMS'},{id:'P3',prod:'PMS'},{id:'AP1',prod:'AGO'}];

  var attendants = station === 'MSO' ? ['Chidi','MSO Supervisor'] : ['Emeka','Bola','Fatima','MRS Supervisor'];
  var methods = ['Cash','Cash','Cash','POS','POS','Transfer'];
  var prices = station === 'MSO' ? {PMS:891,AGO:1161,LPG:500} : {PMS:891,AGO:1161,LPG:500};
  var rows = [];

  for (var d = 29; d >= 0; d--) {
    var date = new Date(); date.setDate(date.getDate() - d);
    var dateStr = formatDate(date);
    var salesPerDay = 8 + Math.floor(Math.random() * 6);

    for (var s = 0; s < salesPerDay; s++) {
      var pump = pumps[Math.floor(Math.random() * pumps.length)];
      var price = prices[pump.prod];
      var litres = pump.prod === 'LPG'
        ? 5 + Math.floor(Math.random() * 20)
        : pump.prod === 'AGO'
          ? 30 + Math.floor(Math.random() * 120)
          : 10 + Math.floor(Math.random() * 50);
      var amount = litres * price;
      var method = methods[Math.floor(Math.random() * methods.length)];
      var attendant = attendants[Math.floor(Math.random() * attendants.length)];
      var hour = 6 + Math.floor(Math.random() * 17);
      var min  = Math.floor(Math.random() * 60);
      var timeS = (hour<10?'0':'')+hour+':'+(min<10?'0':'')+min;
      var opening = 10000 + Math.floor(Math.random() * 90000);
      var id = generateId('SALE');

      rows.push([
        id, dateStr, timeS, pump.id, pump.prod,
        opening, opening + litres, litres,
        price, amount, method,
        attendant, '', 'POSTED', id
      ]);
    }
  }

  if (rows.length > 0) {
    tab.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  Logger.log(station + ' DAILY_SALES: ' + rows.length + ' rows seeded.');
}

// ── SEED DISCHARGE ───────────────────────────────────────────────────────────

function seedDischarge(ss, station) {
  var tab = ss.getSheetByName(CONFIG.TABS.DISCHARGE);
  if (tab.getLastRow() > 1) return;

  var products = ['PMS','PMS','AGO','LPG'];
  var tanks = {PMS: station==='MSO'?'PMS_TANK_1':'PMS_TANK_A', AGO:'AGO_TANK_1', LPG:'LPG_TANK_1'};
  var depots = ['NNPC Depot Apapa','MRS Depot','Forte Oil','Total Energies Depot'];
  var rows = [];

  for (var i = 0; i < 12; i++) {
    var d = new Date(); d.setDate(d.getDate() - Math.floor(i * 2.5));
    var prod = products[Math.floor(Math.random() * products.length)];
    var litresOrd = prod === 'LPG' ? 1000 : prod === 'AGO' ? 5000 : 33000;
    var litresRec = litresOrd - Math.floor(Math.random() * 100);
    var costPerL  = prod === 'PMS' ? 780 : prod === 'AGO' ? 1020 : 430;
    var id = generateId('DISCH');

    rows.push([
      id, formatDate(d), '09:00',
      prod, tanks[prod],
      litresOrd, litresRec,
      'LT-' + (1000 + i),
      'Driver ' + (i+1),
      'WB-' + (5000 + i),
      depots[Math.floor(Math.random()*depots.length)],
      litresRec * costPerL,
      'Supervisor', '', id
    ]);
  }

  if (rows.length) tab.getRange(2,1,rows.length,rows[0].length).setValues(rows);
  Logger.log(station + ' DISCHARGE: ' + rows.length + ' rows seeded.');
}

// ── SEED TANK DIPS ───────────────────────────────────────────────────────────

function seedDips(ss, station) {
  var tab = ss.getSheetByName(CONFIG.TABS.TANK_DIP);
  if (tab.getLastRow() > 1) return;

  var tanks = station === 'MSO'
    ? [{id:'PMS',cap:33000},{id:'AGO',cap:11000},{id:'LPG',cap:5000}]
    : [{id:'PMS',cap:22000},{id:'AGO',cap:8000}];

  var rows = [];
  for (var d = 29; d >= 0; d--) {
    var date = new Date(); date.setDate(date.getDate() - d);
    var dateStr = formatDate(date);
    tanks.forEach(function(t) {
      var pct = 0.3 + Math.random() * 0.65;
      var litres = Math.floor(t.cap * pct);
      var cm = Math.floor(pct * 200);
      var id = generateId('DIP');
      rows.push([id, dateStr, '07:00', t.id, cm, litres, t.cap, 'MANUAL', 'Supervisor', '', id]);
    });
  }

  if (rows.length) tab.getRange(2,1,rows.length,rows[0].length).setValues(rows);
  Logger.log(station + ' TANK_DIP: ' + rows.length + ' rows seeded.');
}

// ── SEED EXPENSES ─────────────────────────────────────────────────────────────

function seedExpenses(ss, station) {
  var tab = ss.getSheetByName(CONFIG.TABS.EXPENSES);
  if (tab.getLastRow() > 1) return;

  var cats = [
    {cat:'Generator Fuel',   min:12000, max:25000},
    {cat:'Staff Meals',      min:6000,  max:12000},
    {cat:'Cleaning Supplies',min:2000,  max:6000},
    {cat:'Maintenance',      min:5000,  max:35000},
    {cat:'Stationery',       min:1000,  max:4000},
    {cat:'Miscellaneous',    min:1500,  max:8000},
    {cat:'Security',         min:10000, max:20000},
    {cat:'Fuel (Gen)',       min:8000,  max:18000},
  ];
  var rows = [];

  for (var d = 29; d >= 0; d--) {
    var date = new Date(); date.setDate(date.getDate() - d);
    var dateStr = formatDate(date);
    var numExp = 2 + Math.floor(Math.random() * 4);
    for (var e = 0; e < numExp; e++) {
      var cat = cats[Math.floor(Math.random() * cats.length)];
      var amount = cat.min + Math.floor(Math.random() * (cat.max - cat.min));
      var id = generateId('EXP');
      rows.push([
        id, dateStr, '10:00', cat.cat, cat.cat + ' - daily',
        amount, 'Cash', '', 'Supervisor', 'Staff', '', id
      ]);
    }
  }

  if (rows.length) tab.getRange(2,1,rows.length,rows[0].length).setValues(rows);
  Logger.log(station + ' EXPENSES: ' + rows.length + ' rows seeded.');
}

// ── SEED PRICES ───────────────────────────────────────────────────────────────

function seedPrices(ss, station) {
  var tab = ss.getSheetByName(CONFIG.TABS.PRICE_HISTORY);
  if (tab.getLastRow() > 1) return;

  var history = [
    ['PMS', 617,  702,  '2023-06-01', 'NNPC price adjustment'],
    ['PMS', 702,  891,  '2024-02-15', 'Government deregulation'],
    ['AGO', 950,  1100, '2023-08-01', 'Depot price increase'],
    ['AGO', 1100, 1161, '2024-03-10', 'Market rate adjustment'],
    ['LPG', 400,  450,  '2023-09-01', 'Supply cost increase'],
    ['LPG', 450,  500,  '2024-01-20', 'Market adjustment'],
  ];

  var rows = history.map(function(h) {
    var id = generateId('PRICE');
    return [id, h[4].slice(0,7)+'-01', '08:00', h[0], h[1], h[2], h[3], h[4], 'Idowu Egba', id];
  });

  if (rows.length) tab.getRange(2,1,rows.length,rows[0].length).setValues(rows);
  Logger.log(station + ' PRICE_HISTORY: ' + rows.length + ' rows seeded.');
}

// ── SEED USERS ────────────────────────────────────────────────────────────────

function seedUsers(ss) {
  var tab = ss.getSheetByName(CONFIG.TABS.USERS);
  if (tab.getLastRow() > 1) return;

  var rows = CONFIG.USERS.map(function(u) {
    return [u.username, u.role, u.displayName, u.station, 'TRUE'];
  });
  if (rows.length) tab.getRange(2,1,rows.length,rows[0].length).setValues(rows);
}

// ── SEED ANNOUNCEMENTS ────────────────────────────────────────────────────────

function seedAnnouncements(ss, station) {
  var tab = ss.getSheetByName(CONFIG.TABS.ANNOUNCEMENTS);
  if (tab.getLastRow() > 1) return;

  var rows = [
    [generateId('ANN'), todayStr(), 'Staff Meeting',       'Monthly staff review meeting scheduled for Saturday 9AM at station.',                          'NORMAL', 'TRUE',  'Idowu Egba'],
    [generateId('ANN'), todayStr(), 'DPR Inspection',      'DPR inspection due in 2 weeks. Ensure all metres are calibrated and records are up to date.',  'HIGH',   'TRUE',  'Idowu Egba'],
    [generateId('ANN'), todayStr(), 'Price Update Notice', 'Current PMS price: ₦891/L. AGO: ₦1,161/L. LPG: ₦500/kg. No changes expected this week.',     'NORMAL', 'TRUE',  'Idowu Egba'],
  ];
  if (rows.length) tab.getRange(2,1,rows.length,rows[0].length).setValues(rows);
}

// ── SEED EDIT REQUESTS ────────────────────────────────────────────────────────

function seedEditRequests(ss) {
  var tab = ss.getSheetByName(CONFIG.TABS.EDIT_REQUESTS);
  if (tab.getLastRow() > 1) return;

  var d = new Date(); d.setDate(d.getDate() - 1);
  var id = generateId('EDIT');
  tab.getRange(2,1,1,14).setValues([[
    id, formatDate(d), '07:15',
    'SALE_SAMPLE_001', 'DAILY_SALES',
    'LITRES', '40', '45',
    'Metre reading error on P2 morning shift',
    'Chidi', 'PENDING', '', '', id
  ]]);
}


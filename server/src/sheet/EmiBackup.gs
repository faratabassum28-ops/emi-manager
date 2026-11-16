/**
 * EMI Manager  <->  Google Sheet backup connector
 * ------------------------------------------------------------------
 * The website sends a full copy of its data to this script every time it backs up.
 * The script writes it into THIS spreadsheet:
 *   Students / Instalments / Payments / Follow-ups   -> readable tabs you can open, filter and print
 *   _raw_*                                           -> hidden tabs holding every record exactly (used to RESTORE)
 *   _Backup Info                                     -> when the last backup ran and what it contained
 * Once a day it also saves a dated COPY of the whole spreadsheet into a Google Drive folder
 * ("EMI Manager backups") and deletes copies older than the number you chose on the website.
 *
 * SETUP (once, about 3 minutes)
 *  1. Make a NEW Google Sheet (name it e.g. "EMI Manager - Backup"). Do not use a sheet people edit by hand:
 *     every backup replaces the tabs below.
 *  2. In the sheet:  Extensions -> Apps Script.  Delete what is there and paste this whole file. Save.
 *  3. Choose the function  setupSheet  and press Run. Allow access when Google asks (it needs Sheets + Drive).
 *  4. Deploy -> New deployment -> type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     Press Deploy and copy the "Web app URL".
 *  5. On the website:  Settings -> Backup & restore -> paste that URL -> Save -> Test connection -> Back up now.
 *
 *  The sheet stays private. Only someone who has BOTH the web-app URL and the secret key below can use the script.
 *  If you change this file later: Deploy -> Manage deployments -> edit -> New version.
 */

var SECRET_KEY    = "__SECRET_KEY__";          // filled in for you by the website's "Copy Apps Script" button
var BACKUP_FOLDER = "EMI Manager backups";     // Google Drive folder that receives the dated copies
var COPY_PREFIX   = "EMI Manager backup ";     // dated copies are named  EMI Manager backup 2026-11-15 18-30
var TIME_ZONE     = "Asia/Kolkata";

/* ---------------------------------------------------------------- web app */

function doGet(e) {
  // Never returns data. Just a way to see that the deployment is alive.
  return json_({ ok: true, message: "EMI Manager backup script is running. Data is only exchanged with the website." });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    check_(body.token);
    lock.waitLock(60000);
    switch (body.action) {
      case "ping":   return json_(ping_());
      case "begin":  return json_({ ok: true });
      case "table":  return json_(writeTable_(body));
      case "finish": return json_(finish_(body));
      case "list":   return json_({ ok: true, tables: SpreadsheetApp.getActive().getSheets().map(function (s) { return s.getName(); }) });
      case "read":   return json_(readTable_(body));
      default:       throw new Error("Unknown action: " + body.action);
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function check_(token) {
  if (!SECRET_KEY || SECRET_KEY.indexOf("__") === 0) throw new Error("Secret key not set in the script");
  if (token !== SECRET_KEY) throw new Error("Wrong secret key");
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------- actions */

function ping_() {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets().map(function (s) { return s.getName(); });
  return { ok: true, name: ss.getName(), url: ss.getUrl(), tabs: sheets.length, has_backup: sheets.indexOf("_Backup Info") >= 0 };
}

// One piece of one table. offset 0 starts the tab afresh; later pieces append below.
function writeTable_(b) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(b.name) || ss.insertSheet(b.name);
  var cols = b.headers.length;
  if (b.offset === 0) {
    sh.clear();
    if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
    var head = sh.getRange(1, 1, 1, cols);
    head.setNumberFormat("@");
    head.setValues([b.headers]);
    head.setFontWeight("bold");
    if (b.name.charAt(0) !== "_") { head.setBackground("#2c5aa0"); head.setFontColor("#ffffff"); }
    sh.setFrozenRows(1);
  }
  var n = b.rows.length;
  if (n) {
    var needRows = b.offset + 1 + n;
    if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
    (b.text || []).forEach(function (c) { sh.getRange(2 + b.offset, c + 1, n, 1).setNumberFormat("@"); });
    sh.getRange(2 + b.offset, 1, n, cols).setValues(b.rows);
  }
  return { ok: true, written: n };
}

function finish_(b) {
  var ss = SpreadsheetApp.getActive();

  // info tab
  var info = ss.getSheetByName("_Backup Info") || ss.insertSheet("_Backup Info");
  info.clear();
  var rows = [["EMI Manager backup", ""], ["Last backup (IST)", b.stamp || ""], ["Started by", b.trigger || ""]];
  var counts = b.counts || {};
  Object.keys(counts).forEach(function (k) { rows.push([k, counts[k]]); });
  rows.push(["", ""], ["Note", "Tabs starting with _raw_ hold every record exactly and are used to restore the website. Do not edit them."]);
  info.getRange(1, 1, rows.length, 2).setValues(rows);
  info.getRange(1, 1, 1, 2).setFontWeight("bold");
  info.setColumnWidth(1, 200); info.setColumnWidth(2, 420);

  // tidy: readable tabs first, raw tabs last and hidden, default empty "Sheet1" removed
  var order = ["Students", "Instalments", "Payments", "Follow-ups", "_Backup Info"];
  order.forEach(function (name, i) {
    var s = ss.getSheetByName(name);
    if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
  });
  ss.getSheets().forEach(function (s) {
    var nm = s.getName();
    if (nm.indexOf("_raw_") === 0) { if (!s.isSheetHidden()) s.hideSheet(); }
    else if (["Students", "Instalments", "Payments", "Follow-ups"].indexOf(nm) >= 0) {
      try { s.autoResizeColumns(1, Math.min(s.getLastColumn(), 20)); } catch (x) {}
    }
  });
  var blank = ss.getSheetByName("Sheet1");
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() <= 1 && blank.getLastColumn() <= 1) ss.deleteSheet(blank);
  SpreadsheetApp.flush();

  var out = { ok: true, spreadsheet_url: ss.getUrl() };
  if (b.makeCopy) {
    var folder = getFolder_();
    var name = COPY_PREFIX + Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH-mm");
    var file = DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
    out.copy_url = file.getUrl();
    out.copy_name = name;
    out.copies_kept = prune_(folder, Number(b.keep) || 0);
  }
  return out;
}

// Keep the newest `keep` dated copies, move the rest to the Drive bin. Only touches files made by this script.
function prune_(folder, keep) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(COPY_PREFIX) === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  if (keep > 0) files.slice(keep).forEach(function (f) { f.setTrashed(true); });
  return keep > 0 ? Math.min(files.length, keep) : files.length;
}

function getFolder_() {
  var it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

// For restoring: hand back the rows of one tab, a page at a time.
function readTable_(b) {
  var sh = SpreadsheetApp.getActive().getSheetByName(b.name);
  if (!sh) throw new Error("Tab not found: " + b.name);
  var last = sh.getLastRow() - 1;
  var offset = Number(b.offset) || 0;
  var limit = Number(b.limit) || 2000;
  if (last <= offset) return { ok: true, rows: [], more: false };
  var n = Math.min(limit, last - offset);
  var values = sh.getRange(2 + offset, 1, n, sh.getLastColumn()).getValues();
  var rows = values.map(function (r) { return r.map(function (c) { return String(c); }); });
  return { ok: true, rows: rows, more: offset + n < last };
}

/* ---------------------------------------------------------------- run once by hand */

// Run this once (step 3). It makes Google ask for the permissions the script needs.
function setupSheet() {
  var ss = SpreadsheetApp.getActive();
  getFolder_();
  if (!ss.getSheetByName("_Backup Info")) {
    var info = ss.insertSheet("_Backup Info");
    info.getRange(1, 1).setValue("Waiting for the first backup from the website…");
  }
  SpreadsheetApp.getUi().alert("Ready. Now deploy this script as a Web app (Deploy -> New deployment), copy the Web app URL and paste it on the website.");
}

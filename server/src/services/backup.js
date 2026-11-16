// Backup & restore.
//
// What gets saved:  every collection the app owns (programs, batches, students, enrollments, instalments,
// payments, reminders, activity log, settings, users, adjustment types), nothing else.
//
// Where it goes:
//   1. A Google Sheet (through a small Apps Script web app, the same pattern as Lead FMS). The sheet holds
//      readable tabs (Students / Instalments / Payments) for people, and `_raw_*` tabs that hold every
//      record losslessly so the app can be restored from the sheet alone.
//   2. A downloadable .json file (Settings -> Backup & restore -> Download), optionally with payment proofs.
//
// When: after any change (at most once per `interval_minutes`), plus a full daily run that also keeps a
// dated copy of the sheet in Google Drive. A "Back up now" button is always there.
//
// Restore never deletes anything. "Add missing" only inserts records that are not in the database;
// "Overwrite" also replaces records whose id exists with the backup's version.
const mongoose = require('mongoose');
const M = require('../models');
const S = require('./snapshot');
const cache = require('./cache');
const E = require('../lib/emi');
const { getSettings } = require('./settings');
const { todayIST } = require('../lib/dates');

const { EJSON } = mongoose.mongo.BSON;
const FORMAT = 1;
const sid = (x) => String(x);

// Order matters for restore (parents before children), though nothing enforces foreign keys.
const COLLECTIONS = [
  ['settings', () => M.Setting],
  ['users', () => M.User],
  ['programs', () => M.Program],
  ['batches', () => M.Batch],
  ['adjustmenttypes', () => M.AdjustmentType],
  ['students', () => M.Student],
  ['enrollments', () => M.Enrollment],
  ['instalments', () => M.Instalment],
  ['payments', () => M.Payment],
  ['reminderlogs', () => M.ReminderLog],
  ['activitylogs', () => M.ActivityLog],
];
const NAMES = COLLECTIONS.map(([n]) => n);
const modelOf = (name) => (COLLECTIONS.find(([n]) => n === name) || [])[1]?.();

/* ---------------------------------------------------------------- settings */
const DEFAULT_BACKUP = { enabled: false, url: '', secret: '', interval_minutes: 30, daily_hour: 2, keep_copies: 14, on_change: true };

async function readConfig() {
  const doc = await M.Setting.findOne({ key: 'main' }, 'backup').lean();
  const cfg = { ...DEFAULT_BACKUP, ...((doc && doc.backup) || {}) };
  if (!cfg.url && process.env.BACKUP_SHEET_URL) cfg.url = process.env.BACKUP_SHEET_URL;
  if (!cfg.secret && process.env.BACKUP_SECRET) cfg.secret = process.env.BACKUP_SECRET;
  return cfg;
}

const SCRIPT_URL = /^https:\/\/script\.google(usercontent)?\.com\//;

function cleanConfig(input, current) {
  const next = { ...current };
  const num = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${label} must be a whole number from ${min} to ${max}`), { status: 400 });
    return n;
  };
  if (input.url !== undefined) {
    const url = String(input.url).trim();
    if (url && !SCRIPT_URL.test(url)) throw Object.assign(new Error('The Google Script link should start with https://script.google.com/…'), { status: 400 });
    next.url = url;
  }
  if (input.secret !== undefined && String(input.secret).trim()) next.secret = String(input.secret).trim();
  if (input.enabled !== undefined) next.enabled = !!input.enabled;
  if (input.on_change !== undefined) next.on_change = !!input.on_change;
  if (input.interval_minutes !== undefined) next.interval_minutes = num(input.interval_minutes, 5, 1440, 'Backup interval (minutes)');
  if (input.daily_hour !== undefined) next.daily_hour = num(input.daily_hour, 0, 23, 'Daily backup hour');
  if (input.keep_copies !== undefined) next.keep_copies = num(input.keep_copies, 0, 90, 'Dated copies to keep');
  if (next.enabled && !next.url) throw Object.assign(new Error('Paste the Google Script link before switching backups on'), { status: 400 });
  return next;
}

// What the browser may see: never the secret itself.
const publicConfig = (cfg) => ({ ...cfg, secret: undefined, has_secret: !!cfg.secret });

/* ---------------------------------------------------------------- reading the database */
async function readCollection(name) {
  const Model = modelOf(name);
  const docs = await Model.collection.find({}).toArray(); // raw driver docs: ObjectIds, Dates, Binary stay exact
  if (name === 'settings') docs.forEach((d) => { delete d.backup; }); // the backup config (with its secret) is not part of a backup
  return docs;
}

async function readAll() {
  const out = {};
  for (const name of NAMES) out[name] = await readCollection(name);
  return out;
}

const countsOf = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));

/* ---------------------------------------------------------------- JSON bundle (download / restore) */
async function buildBundle({ includeFiles = false, data } = {}) {
  data = data || (await readAll());
  const bundle = {
    app: 'emi-manager',
    format: FORMAT,
    created_at: new Date().toISOString(),
    counts: countsOf(data),
    collections: Object.fromEntries(Object.entries(data).map(([k, docs]) => [k, docs.map((d) => EJSON.serialize(d, { relaxed: false }))])),
  };
  if (includeFiles) {
    const files = await M.FileDoc.collection.find({}).toArray();
    bundle.files = files.map((f) => EJSON.serialize(f, { relaxed: false }));
    bundle.counts.files = files.length;
  }
  return bundle;
}

function parseBundle(raw) {
  let b = raw;
  if (Buffer.isBuffer(raw) || typeof raw === 'string') {
    try { b = JSON.parse(String(raw)); } catch { throw Object.assign(new Error('That file is not a valid backup (it is not JSON)'), { status: 400 }); }
  }
  if (!b || b.app !== 'emi-manager' || !b.collections || typeof b.collections !== 'object') throw Object.assign(new Error('That file is not an EMI Manager backup'), { status: 400 });
  if (b.format > FORMAT) throw Object.assign(new Error('This backup was made by a newer version of the app'), { status: 400 });
  return b;
}

/* ---------------------------------------------------------------- restore */
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// mode: 'missing' (insert records that do not exist) | 'overwrite' (also replace records with the same id)
async function restoreBundle(bundle, { mode = 'missing', dryRun = false, files = true } = {}) {
  if (!['missing', 'overwrite'].includes(mode)) throw Object.assign(new Error('Unknown restore mode'), { status: 400 });
  const report = {};
  const errors = [];
  const plan = [...COLLECTIONS.map(([n]) => n), ...(files && bundle.files ? ['files'] : [])];
  for (const name of plan) {
    const src = name === 'files' ? bundle.files : bundle.collections[name];
    if (!Array.isArray(src)) continue;
    const Model = name === 'files' ? M.FileDoc : modelOf(name);
    const docs = src.map((d) => EJSON.deserialize(d, { relaxed: false }));
    const r = { in_backup: docs.length, already_there: 0, added: 0, replaced: 0, failed: 0 };
    for (const part of chunk(docs, 500)) {
      const ids = part.map((d) => d._id);
      const have = new Set((await Model.collection.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((d) => sid(d._id)));
      r.already_there += have.size;
      const missing = part.filter((d) => !have.has(sid(d._id)));
      const clash = part.filter((d) => have.has(sid(d._id)));
      if (dryRun) {
        r.added += missing.length;
        if (mode === 'overwrite') r.replaced += clash.length;
        continue;
      }
      const ops = missing.map((d) => ({ insertOne: { document: d } }));
      if (mode === 'overwrite') {
        for (const d of clash) {
          if (name === 'settings') { const { _id, ...rest } = d; ops.push({ updateOne: { filter: { _id }, update: { $set: rest } } }); } // keep this site's backup config
          else ops.push({ replaceOne: { filter: { _id: d._id }, replacement: d } });
        }
      }
      if (!ops.length) continue;
      try {
        const res = await Model.collection.bulkWrite(ops, { ordered: false });
        r.added += res.insertedCount || 0;
        r.replaced += res.modifiedCount || 0;
      } catch (e) {
        const w = e.result || {};
        r.added += (w.insertedCount ?? e.insertedCount) || 0;
        r.replaced += (w.modifiedCount ?? e.modifiedCount) || 0;
        const bad = (e.writeErrors || []).length || ops.length - ((w.insertedCount ?? e.insertedCount) || 0);
        r.failed += bad;
        errors.push(`${name}: ${String((e.writeErrors && e.writeErrors[0] && e.writeErrors[0].errmsg) || e.message).slice(0, 200)}`);
      }
    }
    report[name] = r;
  }
  if (!dryRun) cache.bump();
  return { dry_run: dryRun, mode, report, errors: errors.slice(0, 10) };
}

/* ---------------------------------------------------------------- Google Sheet tables */
const fmtD = (s) => (s ? E.fmtDate(s) : '');
const istStamp = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16) : '');

// Human-readable tabs, built from the same maths as the app (statuses are calculated, never typed).
async function readableTables(data, settings) {
  const today = todayIST();
  const snapData = {
    enrollments: data.enrollments.map((e) => ({ ...e })),
    instalments: data.instalments,
    payments: data.payments,
  };
  const stuBy = new Map(data.students.map((s) => [sid(s._id), s]));
  const batchBy = new Map(data.batches.map((b) => [sid(b._id), b]));
  const progBy = new Map(data.programs.map((p) => [sid(p._id), p]));
  const rows = S.computeSnapshot({
    enrollments: snapData.enrollments.map((e) => {
      const b = batchBy.get(sid(e.batch)) || {};
      return { ...e, student: stuBy.get(sid(e.student)) || { full_name: '(missing student)', phone: '' }, batch: { ...b, program: progBy.get(sid(b.program)) || null } };
    }),
    instalments: snapData.instalments,
    payments: snapData.payments,
    rules: settings.reminder,
    today,
  });

  const students = {
    name: 'Students',
    headers: ['Program', 'Batch', 'Student', 'Phone', 'Email', 'City', 'Enrolled on', 'Closed by', 'Total fee', 'Net payable', 'Paid', 'Balance', 'EMIs paid', 'EMIs total', 'Next due', 'Next amount', 'Status', 'Enrollment id'],
    text: [0, 1, 2, 3, 4, 5, 6, 7, 14, 16, 17],
    rows: rows.map((r) => [
      r.batch.program ? r.batch.program.name : '', r.batch.batch_name || '', r.student.full_name, r.student.phone, r.student.email || '', r.student.city || '', fmtD(r.enrollment.enrollment_date), r.enrollment.closed_by || '',
      r.enrollment.total_fee, r.enrollment.net_payable, r.paid, r.balance, r.emis_paid, r.emi_total, r.next ? fmtD(r.next.due_date) : '', r.next ? r.next.balance : '', r.status, r.id,
    ]),
  };
  const instalments = {
    name: 'Instalments',
    headers: ['Program', 'Batch', 'Student', 'Phone', 'Type', 'EMI no.', 'Due date', 'Amount due', 'Paid', 'Balance', 'Status', 'Days overdue', 'Paid on'],
    text: [0, 1, 2, 3, 4, 6, 10, 12],
    rows: rows.flatMap((r) => r.instalments.map((i) => [
      r.batch.program ? r.batch.program.name : '', r.batch.batch_name || '', r.student.full_name, r.student.phone, i.type, i.emi_number || '', fmtD(i.due_date), i.amount_due, i.amount_paid, i.balance, i.status, i.days_overdue || 0, fmtD(i.paid_on),
    ])),
  };
  const payments = {
    name: 'Payments',
    headers: ['Date', 'Program', 'Batch', 'Student', 'Phone', 'Amount', 'Mode', 'Applied to', 'Note', 'Recorded by', 'Verified', 'Verified by', 'Reversal', 'Proof file', 'Payment id'],
    text: [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    rows: rows.flatMap((r) => {
      const label = new Map(r.instalments.map((i) => [sid(i._id), i.type === 'EMI' ? `EMI ${i.emi_number}` : i.type]));
      return [...r.payments].sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1)).map((p) => [
        fmtD(p.payment_date), r.batch.program ? r.batch.program.name : '', r.batch.batch_name || '', r.student.full_name, r.student.phone, p.amount, p.mode,
        (p.allocations || []).map((a) => label.get(sid(a.instalment))).filter(Boolean).join(', '), p.note || '', p.recorded_by_name || '', p.verified ? 'Yes' : 'No', p.verified_by || '', p.reversal_of ? 'Reversal' : '', p.screenshot || '', sid(p._id),
      ]);
    }),
  };
  const followups = {
    name: 'Follow-ups',
    headers: ['When (IST)', 'Student', 'Channel', 'Outcome', 'Promised date', 'By', 'Notes'],
    text: [0, 1, 2, 3, 4, 5, 6],
    rows: (() => {
      const enrBy = new Map(rows.map((r) => [r.id, r]));
      return [...data.reminderlogs].sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at)).slice(0, 20000).map((l) => {
        const r = enrBy.get(sid(l.enrollment));
        return [istStamp(l.sent_at), r ? r.student.full_name : '', l.channel, l.outcome, fmtD(l.promised_date), l.sent_by_name || '', l.notes || ''];
      });
    })(),
  };
  return [students, instalments, payments, followups];
}

const CELL_LIMIT = 45000;
const slices = (str, n) => { const out = []; for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n)); return out.length ? out : ['']; };
// Every record, losslessly, one row each: `_id` then the EJSON text (split over extra columns if one record is huge).
function rawTables(data) {
  return NAMES.map((name) => {
    const parts = data[name].map((d) => {
      const json = EJSON.stringify(d, { relaxed: false });
      return [sid(d._id), ...slices(json, CELL_LIMIT)];
    });
    const width = Math.max(1, ...parts.map((p) => p.length - 1));
    return {
      name: `_raw_${name}`,
      headers: ['_id', ...Array.from({ length: width }, (_, i) => (i ? `json_${i + 1}` : 'json'))],
      text: Array.from({ length: width + 1 }, (_, i) => i),
      rows: parts.map((p) => [...p, ...Array(width + 1 - p.length).fill('')]),
    };
  });
}

/* ---------------------------------------------------------------- talking to the Apps Script */
const soft = (m) => Object.assign(new Error(m), { transient: true });
const snippet = (t) => String(t).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

async function scriptOnce(cfg, body, { timeoutMs = 90000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res; let txt;
  try {
    res = await fetch(cfg.url.trim(), {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.secret, ...body }),
    });
    txt = await res.text();
  } catch (e) {
    throw soft(e && e.name === 'AbortError' ? 'Google took too long to answer' : `Could not reach Google (${(e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'network error'})`);
  } finally { clearTimeout(timer); }
  let j;
  try { j = JSON.parse(txt); } catch {
    const sn = snippet(txt);
    const login = /sign in|accounts\.google|authorization/i.test(sn);
    const err = new Error(`Google did not return data (HTTP ${res.status}): ${sn || 'empty answer'}${login ? ' — deploy the script as a Web app with access “Anyone”' : ''}`);
    err.transient = !login && (res.status >= 500 || res.status === 429 || res.status === 200 || res.status === 302);
    throw err;
  }
  if (!j.ok) {
    const err = new Error(j.error || 'The Google Script refused the request (check the secret key)');
    err.transient = /too many|timed out|try again|temporar|rate limit|service invoked|unavailable/i.test(err.message);
    throw err;
  }
  return j;
}

async function scriptCall(cfg, body, opts) {
  let err;
  const tries = (opts && opts.tries) || 3;
  const wait = (opts && opts.waitMs) ?? 3000;
  for (let a = 1; a <= tries; a++) {
    try { return await scriptOnce(cfg, body, opts); } catch (e) { err = e; if (!e.transient || a === tries) break; await new Promise((r) => setTimeout(r, a * wait)); }
  }
  throw err;
}

// Send rows in pieces so one request never gets huge.
function* pieces(rows, maxChars = 900000, maxRows = 4000) {
  let cur = []; let size = 0;
  for (const r of rows) {
    const len = r.reduce((n, c) => n + String(c).length + 3, 0);
    if (cur.length && (size + len > maxChars || cur.length >= maxRows)) { yield cur; cur = []; size = 0; }
    cur.push(r); size += len;
  }
  yield cur;
}

async function pushToSheet(cfg, tables, { makeCopy, counts, trigger }) {
  const runId = `${Date.now()}`;
  await scriptCall(cfg, { action: 'begin', runId, tables: tables.map((t) => t.name) });
  for (const t of tables) {
    let offset = 0;
    for (const rows of pieces(t.rows)) {
      await scriptCall(cfg, { action: 'table', runId, name: t.name, headers: t.headers, text: t.text, rows, offset, total: t.rows.length });
      offset += rows.length;
    }
  }
  const fin = await scriptCall(cfg, { action: 'finish', runId, makeCopy: !!makeCopy, keep: cfg.keep_copies, counts, trigger, stamp: istStamp(new Date()) }, { tries: 1 });
  return { spreadsheet_url: fin.spreadsheet_url || '', copy_url: fin.copy_url || '', copy_name: fin.copy_name || '', copies_kept: fin.copies_kept };
}

async function pullFromSheet(cfg) {
  const info = await scriptCall(cfg, { action: 'list' });
  const have = new Set(info.tables || []);
  const collections = {};
  for (const name of NAMES) {
    const tab = `_raw_${name}`;
    if (!have.has(tab)) continue;
    const docs = [];
    let offset = 0;
    for (;;) {
      const page = await scriptCall(cfg, { action: 'read', name: tab, offset, limit: 2000 });
      for (const row of page.rows) {
        const json = row.slice(1).join('');
        if (json) docs.push(JSON.parse(json));
      }
      if (!page.more) break;
      offset += page.rows.length;
    }
    collections[name] = docs;
  }
  if (!Object.keys(collections).length) throw Object.assign(new Error('That sheet has no backup tabs yet. Run “Back up now” first.'), { status: 400 });
  return { app: 'emi-manager', format: FORMAT, collections };
}

/* ---------------------------------------------------------------- running a backup */
let running = null;
let dirty = false;
let lastStartedAt = 0;
let lastDailyOn = '';

const markDirty = () => { dirty = true; };

async function runBackup({ trigger = 'manual', by = 'system' } = {}) {
  if (running) return running; // one at a time; a second click shares the first run
  running = (async () => {
    const t0 = Date.now();
    lastStartedAt = t0;
    const log = { trigger, by, ok: false };
    try {
      const cfg = await readConfig();
      if (!cfg.url) throw new Error('No Google Sheet is connected yet');
      if (!cfg.secret) throw new Error('No secret key is set yet');
      dirty = false; // anything written from here on will trigger the next run
      const data = await readAll();
      const settings = await getSettings();
      const tables = [...(await readableTables(data, settings)), ...rawTables(data)];
      log.counts = countsOf(data);
      const makeCopy = (trigger === 'daily' || trigger === 'manual') && cfg.keep_copies > 0;
      log.sheet = { ok: true, ...(await pushToSheet(cfg, tables, { makeCopy, counts: log.counts, trigger })) };
      log.ok = true;
    } catch (e) {
      dirty = true; // try again at the next opportunity
      log.error = String(e.message || e).slice(0, 500);
      log.sheet = { ok: false, error: log.error };
    }
    log.ms = Date.now() - t0;
    try { await M.BackupLog.create(log); } catch (e) { console.error('backup log failed', e.message); }
    return log;
  })().finally(() => { running = null; });
  return running;
}

// Pure: should a backup run now? (unit-tested)
function decide(cfg, { now = new Date(), dirty: isDirty, lastStartedAt: last, lastDailyOn: lastDay, today, hourIST }) {
  if (!cfg.enabled || !cfg.url || !cfg.secret) return null;
  if (hourIST >= cfg.daily_hour && lastDay !== today && now.getTime() - last >= 10 * 60000) return 'daily';
  if (cfg.on_change && isDirty && now.getTime() - last >= cfg.interval_minutes * 60000) return 'auto';
  return null;
}

async function tick() {
  try {
    const cfg = await readConfig();
    const now = new Date();
    const ist = new Date(now.getTime() + 330 * 60000);
    const today = ist.toISOString().slice(0, 10);
    if (!lastDailyOn) {
      // after a restart, learn whether today's daily backup already happened
      const last = await M.BackupLog.findOne({ trigger: 'daily', ok: true }).sort({ createdAt: -1 }).lean();
      lastDailyOn = last ? istStamp(last.createdAt).slice(0, 10) : 'never';
    }
    const why = decide(cfg, { now, dirty, lastStartedAt, lastDailyOn, today, hourIST: ist.getUTCHours() });
    if (!why) return;
    const out = await runBackup({ trigger: why, by: 'schedule' });
    if (out.ok && why === 'daily') lastDailyOn = today;
  } catch (e) {
    console.error('backup tick failed', e.message);
  }
}

let timer = null;
function startScheduler() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 20 * 1000).unref?.();
}

/* ---------------------------------------------------------------- status & health check */
async function status() {
  const cfg = await readConfig();
  const [lastOk, last, recent] = await Promise.all([
    M.BackupLog.findOne({ ok: true }).sort({ createdAt: -1 }).lean(),
    M.BackupLog.findOne({}).sort({ createdAt: -1 }).lean(),
    M.BackupLog.find({}).sort({ createdAt: -1 }).limit(15).lean(),
  ]);
  const ageMin = lastOk ? Math.round((Date.now() - new Date(lastOk.createdAt).getTime()) / 60000) : null;
  let health = 'off';
  if (cfg.enabled) health = !lastOk ? 'pending' : ageMin > 26 * 60 ? 'stale' : last && !last.ok ? 'failing' : 'ok';
  return { config: publicConfig(cfg), running: !!running, dirty, health, last_ok_at: lastOk ? lastOk.createdAt : null, age_minutes: ageMin, last_error: last && !last.ok ? last.error : null, recent, now_ist: istStamp(new Date()), models: NAMES };
}

// Compare what is stored with what the ledger says it should be, and look for orphans and missing proof files.
async function audit() {
  const data = await readAll();
  const issues = [];
  const idsOf = (name) => new Set(data[name].map((d) => sid(d._id)));
  const enr = idsOf('enrollments'); const stu = idsOf('students'); const bat = idsOf('batches'); const ins = idsOf('instalments');
  const add = (level, code, text, items = []) => issues.push({ level, code, text, count: items.length || undefined, sample: items.slice(0, 8) });

  const orphanI = data.instalments.filter((i) => !enr.has(sid(i.enrollment)));
  if (orphanI.length) add('error', 'orphan_instalments', 'Instalments that belong to a missing enrollment', orphanI.map((i) => sid(i._id)));
  const orphanP = data.payments.filter((p) => !enr.has(sid(p.enrollment)));
  if (orphanP.length) add('error', 'orphan_payments', 'Payments that belong to a missing enrollment', orphanP.map((p) => sid(p._id)));
  const noStu = data.enrollments.filter((e) => !stu.has(sid(e.student)));
  if (noStu.length) add('error', 'enrollment_no_student', 'Enrollments whose student record is missing', noStu.map((e) => sid(e._id)));
  const noBat = data.enrollments.filter((e) => !bat.has(sid(e.batch)));
  if (noBat.length) add('error', 'enrollment_no_batch', 'Enrollments whose batch is missing', noBat.map((e) => sid(e._id)));
  const badAlloc = data.payments.filter((p) => (p.allocations || []).some((a) => !ins.has(sid(a.instalment))));
  if (badAlloc.length) add('warn', 'alloc_missing_instalment', 'Payments allocated to an instalment that no longer exists', badAlloc.map((p) => sid(p._id)));

  // ledger vs stored instalment totals
  const instBy = new Map(); const payBy = new Map();
  data.instalments.forEach((i) => { const k = sid(i.enrollment); (instBy.get(k) || instBy.set(k, []).get(k)).push(i); });
  data.payments.forEach((p) => { const k = sid(p.enrollment); (payBy.get(k) || payBy.set(k, []).get(k)).push(p); });
  const drift = [];
  const planOff = [];
  for (const e of data.enrollments) {
    const is = instBy.get(sid(e._id)) || [];
    const ps = payBy.get(sid(e._id)) || [];
    const map = E.recalcFromPayments(is.map((i) => ({ id: i._id, amount_due: i.amount_due })), ps);
    if (is.some((i) => (map.get(sid(i._id)) || {}).amount_paid !== (i.amount_paid || 0))) drift.push(sid(e._id));
    const emis = is.filter((i) => i.type === 'EMI' && !i.waived);
    if (!e.manual_status && !is.some((i) => i.waived) && emis.length && E.sum(emis, (i) => i.amount_due) !== e.balance_due) planOff.push(sid(e._id));
  }
  if (drift.length) add('error', 'ledger_drift', 'Instalment “paid” totals that do not match the payment ledger', drift);
  if (planOff.length) add('warn', 'plan_sum', 'Enrollments whose EMI amounts do not add up to the balance due', planOff);
  const dupPhones = (() => { const seen = new Map(); data.students.forEach((s) => seen.set(s.phone, (seen.get(s.phone) || 0) + 1)); return [...seen].filter(([, n]) => n > 1).map(([p]) => p); })();
  if (dupPhones.length) add('warn', 'dup_phone', 'Phone numbers used by more than one student', dupPhones);

  // payment proofs: which files are referenced but not stored
  const wanted = new Set();
  data.payments.forEach((p) => p.screenshot && wanted.add(p.screenshot));
  data.enrollments.forEach((e) => e.agreement_file && wanted.add(e.agreement_file));
  const stored = new Set((await M.FileDoc.collection.find({ name: { $in: [...wanted] } }, { projection: { name: 1 } }).toArray()).map((f) => f.name));
  const missing = [...wanted].filter((n) => !stored.has(n));
  if (missing.length) add('warn', 'missing_proofs', 'Payment proofs / agreements that were uploaded but are no longer stored (re-upload them from the payment)', missing);

  const errors = issues.filter((i) => i.level === 'error').length;
  return { ok: !errors, errors, warnings: issues.length - errors, counts: { ...countsOf(data), proofs_referenced: wanted.size, proofs_stored: stored.size }, issues, checked_at: new Date().toISOString() };
}

module.exports = {
  COLLECTIONS, NAMES, FORMAT, DEFAULT_BACKUP, SCRIPT_URL,
  readConfig, cleanConfig, publicConfig, readAll, countsOf, buildBundle, parseBundle, restoreBundle,
  readableTables, rawTables, scriptCall, pushToSheet, pullFromSheet, runBackup, decide, markDirty, startScheduler, status, audit, tick,
};

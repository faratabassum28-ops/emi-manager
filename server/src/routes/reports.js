const express = require('express');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { Batch, Payment, Enrollment, ReminderLog } = require('../models');
const { HttpError, h, auth, role, batchScope, assertBatchAccess, canVerify } = require('../middleware');
const { getSettings } = require('../services/settings');
const S = require('../services/snapshot');
const cache = require('../services/cache');
const { todayIST } = require('../lib/dates');
const E = require('../lib/emi');
const { resolveWindow, previousWindow } = require('../lib/windows');
const { addDays } = require('../lib/dates');

const router = express.Router();
const sid = (x) => String(x);
const mgr = role('Admin', 'Manager');

// Everything below is computed from the same three collections, so the heavy work is done once per change
// and shared (see services/cache.js). The cache is thrown away by any successful write.
const settingsCached = () => cache.memo('settings', 5 * 60 * 1000, () => getSettings());
const reminderMaps = () => cache.memo('reminders', 5 * 60 * 1000, () => S.loadReminderMaps());
const liveBatchIds = () => cache.memo('batches:live', 5 * 60 * 1000, async () => (await Batch.find({ status: { $ne: 'Archived' } }, '_id').lean()).map((b) => sid(b._id)));

async function visibleBatchIds(user, batchId) {
  if (batchId) {
    assertBatchAccess(user, batchId);
    return [sid(batchId)];
  }
  const scope = batchScope(user);
  const all = await liveBatchIds();
  return scope ? all.filter((id) => scope.includes(id)) : all;
}

const keyOf = (ids) => crypto.createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 16);

// One snapshot per (day, set of visible batches). A single-batch request reuses the all-batches snapshot when it can.
async function snapshotFor(user, batchId) {
  const today = todayIST();
  const build = (ids) => cache.memo(`snap:${today}:${keyOf(ids)}`, 5 * 60 * 1000, async () => {
    const [settings, data] = await Promise.all([settingsCached(), S.loadData(ids)]);
    return { rows: S.computeSnapshot({ ...data, rules: settings.reminder, today }), data, settings, today, ids };
  });
  if (!batchId) return build(await visibleBatchIds(user));
  assertBatchAccess(user, batchId);
  const live = await visibleBatchIds(user);
  if (live.includes(sid(batchId))) {
    const all = await build(live);
    const rows = all.rows.filter((r) => sid(r.batch._id) === sid(batchId));
    return { ...all, rows, ids: [sid(batchId)] };
  }
  return build([sid(batchId)]); // an archived batch is opened on its own
}

const searchRows = (list, q, nameOf) => {
  q = String(q || '').toLowerCase().trim();
  if (!q) return list;
  const digits = q.replace(/\D/g, '');
  return list.filter((r) => nameOf(r).name.toLowerCase().includes(q) || (digits && nameOf(r).phone.includes(digits)));
};

/* ---------------- Home: cross-program leadership view (5.1) ---------------- */
router.get('/home', auth, h(async (req, res) => {
  const { rows, today, ids } = await snapshotFor(req.user);
  const all = S.kpis(rows, today);
  const batches = await cache.memo('batches:home', 5 * 60 * 1000, () => Batch.find({}).populate('program', 'name').lean());
  const idSet = new Set(ids);
  const programId = (b) => (b.program ? b.program._id : null);
  const byBatch = new Map();
  for (const r of rows) { const k = sid(r.batch._id); (byBatch.get(k) || byBatch.set(k, []).get(k)).push(r); }
  const perBatch = batches.filter((b) => idSet.has(sid(b._id))).map((b) => {
    const k = S.kpis(byBatch.get(sid(b._id)) || [], today);
    return { batch_id: b._id, program_id: programId(b), code: b.code, batch_name: b.batch_name, program: b.program ? b.program.name : '', status: b.status, students: k.total_students, outstanding: k.outstanding, overdue_amount: k.overdue_amount, overdue_count: k.overdue_count, collection_pct: k.collection_pct };
  }).sort((a, b) => b.overdue_amount - a.overdue_amount);

  const maps = await reminderMaps();
  const todayList = S.trackerRows(rows, { filter: 'today', today, ...maps });
  const focus = S.trackerRows(rows, { filter: 'queue', today, ...maps }).sort((a, b) => b.priority - a.priority).slice(0, 8);
  const broken = S.trackerRows(rows, { filter: 'broken', today, ...maps }).length;

  res.json({
    today,
    totals: {
      collected_this_month: all.collected_this_month,
      due_this_month: all.due_this_month,
      overdue_amount: all.overdue_amount,
      overdue_count: all.overdue_count,
      collection_rate: all.due_this_month ? Math.round((all.emi_collected_this_month / all.due_this_month) * 1000) / 10 : null,
      students: all.total_students,
      contract_value: all.contract_value,
      collected: all.collected,
      outstanding: all.outstanding,
      collection_pct: all.collection_pct,
      defaulters: all.defaulters,
      broken_promises: broken,
    },
    status_split: all.status_split,
    ageing: all.ageing,
    forecast: S.forecast(rows, today),
    batches: perBatch,
    today_list: todayList.slice(0, 100),
    focus,
  });
}));

/* ---------------- Batch dashboard (5.2 / 5.3) ---------------- */
router.get('/batches/:id/dashboard', auth, h(async (req, res) => {
  const { rows, today } = await snapshotFor(req.user, req.params.id);
  const batch = await Batch.findById(req.params.id).populate('program', 'name code').populate('owner', 'name').lean();
  if (!batch) throw new HttpError(404, 'Batch not found');
  res.json({ batch, today, kpis: S.kpis(rows, today), forecast: S.forecast(rows, today) });
}));

/* ---------------- Students tab (5.4) ---------------- */
router.get('/batches/:id/students', auth, h(async (req, res) => {
  const { rows } = await snapshotFor(req.user, req.params.id);
  const f = S.FILTERS[req.query.filter];
  let list = rows;
  if (f) list = list.filter(f);
  else list = list.filter((r) => r.bucket !== 'dropped' || req.query.include_dropped === '1');
  list = searchRows(list, req.query.q, (r) => ({ name: r.student.full_name, phone: r.student.phone }));
  res.json(list.map(S.studentRow).sort((a, b) => a.name.localeCompare(b.name)));
}));

/* ---------------- EMI tracker (section 7) ---------------- */
router.get('/tracker', auth, h(async (req, res) => {
  const { rows, today } = await snapshotFor(req.user, req.query.batch || null);
  const maps = await reminderMaps();
  const filter = req.query.filter || 'queue';
  let list = S.trackerRows(rows, { filter, today, ...maps });
  list = searchRows(list, req.query.q, (r) => ({ name: r.student_name, phone: r.phone }));
  if (req.query.sort === 'priority') list.sort((a, b) => b.priority - a.priority || (a.due_date < b.due_date ? -1 : 1));
  res.json({ today, rows: list.slice(0, 1000), total: list.length, total_balance: E.sum(list, (r) => r.balance), counts: S.trackerCounts(rows, { today, ...maps }) });
}));

/* ---------------- Pulse: small live counts for the sidebar badges ---------------- */
router.get('/pulse', auth, h(async (req, res) => {
  const { rows, today, ids } = await snapshotFor(req.user);
  const maps = await reminderMaps();
  const overdue = S.trackerRows(rows, { filter: 'overdue', today, ...maps }).length;
  const due_today = S.trackerRows(rows, { filter: 'today', today, ...maps }).length;
  const broken = S.trackerRows(rows, { filter: 'broken', today, ...maps }).length;
  const promised_today = [...maps.promised.values()].filter((d) => d === today).length;
  const unverified = canVerify(req.user)
    ? await cache.memo(`unverified:${keyOf(ids)}`, 5 * 60 * 1000, () => Payment.countDocuments({ batch: { $in: ids }, verified: false, amount: { $gt: 0 }, reversal_of: { $exists: false } }))
    : null;
  res.json({ today, overdue, due_today, broken, promised_today, unverified });
}));

/* ---------------- Team performance: who collected, who followed up, whose promises held ---------------- */
router.get('/performance', auth, mgr, h(async (req, res) => {
  const today = todayIST();
  const w = resolveWindow(String(req.query.window || 'this_month'), today, { from: req.query.from, to: req.query.to });
  if (!w) throw new HttpError(400, 'Choose a valid time window');
  const { rows, ids } = await snapshotFor(req.user);
  const inst = new Map();
  for (const r of rows) for (const i of r.instalments) inst.set(sid(i._id), i);
  const payQ = { batch: { $in: ids } };
  if (w.start) payQ.payment_date = { $gte: w.start, $lte: w.end };
  const enrIds = rows.map((r) => r.enrollment._id);
  const remQ = { enrollment: { $in: enrIds } };
  if (w.start) remQ.sent_at = { $gte: new Date(`${w.start}T00:00:00+05:30`), $lte: new Date(`${w.end}T23:59:59.999+05:30`) };
  const [payments, reminders] = await Promise.all([
    Payment.find(payQ, 'amount recorded_by_name reversal_of verified').lean(),
    ReminderLog.find(remQ, 'sent_by_name channel outcome promised_date instalment').lean(),
  ]);
  const people = new Map();
  const who = (n) => { const k = n || '(unknown)'; if (!people.has(k)) people.set(k, { name: k, collected: 0, payments: 0, verified: 0, followups: 0, calls: 0, whatsapps: 0, promises: 0, kept: 0, broken: 0, pending: 0 }); return people.get(k); };
  for (const p of payments) {
    const x = who(p.recorded_by_name);
    x.collected += p.amount;
    if (p.amount > 0 && !p.reversal_of) { x.payments += 1; if (p.verified) x.verified += 1; }
  }
  for (const r of reminders) {
    const x = who(r.sent_by_name);
    x.followups += 1;
    if (r.channel === 'Call') x.calls += 1;
    if (r.channel === 'WhatsApp') x.whatsapps += 1;
    if (r.promised_date && ['Will pay on date', 'Asked for extension'].includes(r.outcome)) {
      x.promises += 1;
      const i = inst.get(sid(r.instalment));
      if (i && i.balance === 0 && i.paid_on && i.paid_on <= addDays(r.promised_date, 1)) x.kept += 1;
      else if (r.promised_date < today) x.broken += 1;
      else x.pending += 1;
    }
  }
  const list = [...people.values()].map((x) => ({ ...x, kept_pct: x.kept + x.broken ? Math.round((x.kept / (x.kept + x.broken)) * 100) : null })).sort((a, b) => b.collected - a.collected || b.followups - a.followups);
  res.json({ window: w, today, people: list, totals: { collected: E.sum(list, (p) => p.collected), followups: E.sum(list, (p) => p.followups), promises: E.sum(list, (p) => p.promises), kept: E.sum(list, (p) => p.kept), broken: E.sum(list, (p) => p.broken) } });
}));

/* ---------------- Insights: a time window against the equal-length window before it ---------------- */
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);

function windowMetrics(w, payments, enrollments, reminders) {
  const inW = (d) => !w.start || (d >= w.start && d <= w.end);
  const pays = payments.filter((p) => inW(p.payment_date));
  const positive = pays.filter((p) => p.amount > 0 && !p.reversal_of);
  const enr = enrollments.filter((e) => inW(e.enrollment_date));
  const rem = reminders.filter((r) => inW(istDay(r.sent_at)));
  const collected = pays.reduce((a, p) => a + p.amount, 0);
  const modes = new Map();
  for (const p of pays) modes.set(p.mode, (modes.get(p.mode) || 0) + p.amount);
  return {
    collected,
    payments: positive.length,
    avg_payment: positive.length ? Math.round(positive.reduce((a, p) => a + p.amount, 0) / positive.length) : 0,
    reversed: pays.filter((p) => p.amount < 0).reduce((a, p) => a + -p.amount, 0),
    new_enrollments: enr.length,
    enrolled_value: enr.reduce((a, e) => a + (e.net_payable || 0), 0),
    followups: rem.length,
    calls: rem.filter((r) => r.channel === 'Call').length,
    promises: rem.filter((r) => r.outcome === 'Will pay on date').length,
    by_mode: [...modes.entries()].map(([mode, amount]) => ({ mode, amount })).filter((m) => m.amount !== 0).sort((a, b) => b.amount - a.amount),
  };
}

router.get('/insights', auth, h(async (req, res) => {
  const today = todayIST();
  const w = resolveWindow(String(req.query.window || 'this_month'), today, { from: req.query.from, to: req.query.to });
  if (!w) throw new HttpError(400, 'Choose a valid time window (a custom range needs both dates, from before to)');
  const prev = previousWindow(w);
  const ids = await visibleBatchIds(req.user);
  const earliest = prev ? prev.start : w.start;
  const payQ = { batch: { $in: ids } };
  const enrQ = { batch: { $in: ids } };
  if (earliest) { payQ.payment_date = { $gte: earliest, $lte: w.end }; enrQ.enrollment_date = { $gte: earliest, $lte: w.end }; }
  const [payments, enrollments, enrIds] = await Promise.all([
    Payment.find(payQ, 'amount payment_date mode reversal_of').lean(),
    Enrollment.find(enrQ, 'enrollment_date net_payable').lean(),
    Enrollment.find({ batch: { $in: ids } }, '_id').lean(),
  ]);
  const rq = { enrollment: { $in: enrIds.map((e) => e._id) } };
  if (earliest) rq.sent_at = { $gte: new Date(`${earliest}T00:00:00+05:30`), $lte: new Date(`${w.end}T23:59:59.999+05:30`) };
  const reminders = await ReminderLog.find(rq, 'sent_at channel outcome').lean();

  // chart series for the selected window: daily up to ~3 months, monthly beyond that
  const cur = payments.filter((p) => !w.start || (p.payment_date >= w.start && p.payment_date <= w.end));
  let series = []; let unit = 'day';
  const daily = !w.start ? false : w.days <= 93;
  if (daily) {
    const m = new Map();
    for (const p of cur) m.set(p.payment_date, (m.get(p.payment_date) || 0) + p.amount);
    for (let i = 0; i < w.days; i++) { const d = addDays(w.start, i); series.push({ key: d, collected: m.get(d) || 0 }); }
  } else {
    unit = 'month';
    const m = new Map();
    for (const p of cur) m.set(p.payment_date.slice(0, 7), (m.get(p.payment_date.slice(0, 7)) || 0) + p.amount);
    series = [...m.entries()].sort().map(([key, collected]) => ({ key, collected }));
  }

  res.json({
    window: w, previous: prev, today,
    current: windowMetrics(w, payments, enrollments, reminders),
    prior: prev ? windowMetrics(prev, payments, enrollments, reminders) : null,
    series, unit,
  });
}));

/* ---------------- Excel export (Admin / Manager / Viewer) ---------------- */
router.get('/batches/:id/export', auth, role('Admin', 'Manager', 'Viewer'), h(async (req, res) => {
  const { rows } = await snapshotFor(req.user, req.params.id);
  const batch = await Batch.findById(req.params.id).lean();
  if (!batch) throw new HttpError(404, 'Batch not found');
  const wb = new ExcelJS.Workbook();
  const money = '#,##0';

  const ws = wb.addWorksheet('Students');
  ws.columns = [
    { header: 'Name', key: 'name', width: 26 }, { header: 'Phone', key: 'phone', width: 16 }, { header: 'Email', key: 'email', width: 28 },
    { header: 'Net payable', key: 'net', width: 14, style: { numFmt: money } }, { header: 'Paid', key: 'paid', width: 14, style: { numFmt: money } },
    { header: 'Balance', key: 'bal', width: 14, style: { numFmt: money } }, { header: 'EMIs paid', key: 'emis', width: 10 },
    { header: 'Next due', key: 'next', width: 13 }, { header: 'Next amount', key: 'nextAmt', width: 13, style: { numFmt: money } }, { header: 'Status', key: 'status', width: 12 },
  ];
  rows.forEach((r) => ws.addRow({ name: r.student.full_name, phone: r.student.phone, email: r.student.email, net: r.enrollment.net_payable, paid: r.paid, bal: r.balance, emis: `${r.emis_paid}/${r.emi_total}`, next: r.next ? E.fmtDate(r.next.due_date) : '', nextAmt: r.next ? r.next.balance : '', status: r.status }));

  const wi = wb.addWorksheet('Instalments');
  wi.columns = [
    { header: 'Student', key: 's', width: 26 }, { header: 'Type', key: 't', width: 16 }, { header: 'EMI no.', key: 'n', width: 8 }, { header: 'Due date', key: 'd', width: 13 },
    { header: 'Amount due', key: 'a', width: 14, style: { numFmt: money } }, { header: 'Paid', key: 'p', width: 14, style: { numFmt: money } }, { header: 'Balance', key: 'b', width: 14, style: { numFmt: money } },
    { header: 'Status', key: 'st', width: 14 }, { header: 'Days overdue', key: 'o', width: 12 }, { header: 'Paid on', key: 'po', width: 13 },
  ];
  rows.forEach((r) => r.instalments.forEach((i) => wi.addRow({ s: r.student.full_name, t: i.type, n: i.emi_number || '', d: E.fmtDate(i.due_date), a: i.amount_due, p: i.amount_paid, b: i.balance, st: i.status, o: i.days_overdue || '', po: E.fmtDate(i.paid_on) })));

  const wp = wb.addWorksheet('Payments');
  wp.columns = [
    { header: 'Date', key: 'd', width: 13 }, { header: 'Student', key: 's', width: 26 }, { header: 'Amount', key: 'a', width: 14, style: { numFmt: money } }, { header: 'Mode', key: 'm', width: 22 },
    { header: 'Applied to', key: 'ap', width: 22 }, { header: 'Recorded by', key: 'by', width: 16 }, { header: 'Verified', key: 'v', width: 10 },
  ];
  rows.forEach((r) => {
    const label = new Map(r.instalments.map((i) => [sid(i._id), i.type === 'EMI' ? `EMI ${i.emi_number}` : i.type]));
    [...r.payments].sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1)).forEach((p) => wp.addRow({ d: E.fmtDate(p.payment_date), s: r.student.full_name, a: p.amount, m: p.mode, ap: (p.allocations || []).map((a) => label.get(sid(a.instalment))).join(', '), by: p.recorded_by_name || '', v: p.verified ? 'Yes' : 'No' }));
  });

  [ws, wi, wp].forEach((s) => { s.getRow(1).font = { bold: true }; s.views = [{ state: 'frozen', ySplit: 1 }]; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${batch.code}-${todayIST()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;

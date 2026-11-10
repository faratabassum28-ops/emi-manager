const express = require('express');
const ExcelJS = require('exceljs');
const { Batch } = require('../models');
const { HttpError, h, auth, role, batchScope, assertBatchAccess } = require('../middleware');
const { getSettings } = require('../services/settings');
const S = require('../services/snapshot');
const { todayIST } = require('../lib/dates');
const E = require('../lib/emi');

const router = express.Router();
const sid = (x) => String(x);

async function visibleBatchIds(user, batchId) {
  if (batchId) {
    assertBatchAccess(user, batchId);
    return [batchId];
  }
  const scope = batchScope(user);
  const q = { status: { $ne: 'Archived' } };
  if (scope) q._id = { $in: scope };
  return (await Batch.find(q, '_id').lean()).map((b) => b._id);
}

async function snapshotFor(user, batchId) {
  const ids = await visibleBatchIds(user, batchId);
  const [settings, data] = await Promise.all([getSettings(), S.loadData(ids)]);
  const today = todayIST();
  const rows = S.computeSnapshot({ ...data, rules: settings.reminder, today });
  return { rows, data, settings, today, ids };
}

/* ---------------- Home: cross-program leadership view (5.1) ---------------- */
router.get('/home', auth, h(async (req, res) => {
  const { rows, data, today, ids } = await snapshotFor(req.user);
  const all = S.kpis(rows, today);
  const batches = await Batch.find({ _id: { $in: ids } }).populate('program', 'name').lean();
  const programId = (b) => (b.program ? b.program._id : null);
  const perBatch = batches.map((b) => {
    const k = S.kpis(rows.filter((r) => sid(r.batch._id) === sid(b._id)), today);
    return { batch_id: b._id, program_id: programId(b), code: b.code, batch_name: b.batch_name, program: b.program ? b.program.name : '', status: b.status, students: k.total_students, outstanding: k.outstanding, overdue_amount: k.overdue_amount, overdue_count: k.overdue_count, collection_pct: k.collection_pct };
  }).sort((a, b) => b.overdue_amount - a.overdue_amount);

  const dueTodayIds = data.instalments.filter((i) => i.type === 'EMI' && i.due_date === today).map((i) => i._id);
  const maps = await S.loadReminderMaps(dueTodayIds);
  const todayList = S.trackerRows(rows, { filter: 'today', today, ...maps });

  res.json({
    today,
    totals: {
      collected_this_month: all.collected_this_month,
      due_this_month: all.due_this_month,
      overdue_amount: all.overdue_amount,
      overdue_count: all.overdue_count,
      collection_rate: all.due_this_month ? Math.round((all.emi_collected_this_month / all.due_this_month) * 1000) / 10 : null,
      students: all.total_students,
    },
    batches: perBatch,
    today_list: todayList.slice(0, 100),
  });
}));

/* ---------------- Batch dashboard (5.2 / 5.3) ---------------- */
router.get('/batches/:id/dashboard', auth, h(async (req, res) => {
  const { rows, today } = await snapshotFor(req.user, req.params.id);
  const batch = await Batch.findById(req.params.id).populate('program', 'name code').populate('owner', 'name').lean();
  if (!batch) throw new HttpError(404, 'Batch not found');
  res.json({ batch, today, kpis: S.kpis(rows, today) });
}));

/* ---------------- Students tab (5.4) ---------------- */
router.get('/batches/:id/students', auth, h(async (req, res) => {
  const { rows } = await snapshotFor(req.user, req.params.id);
  const f = S.FILTERS[req.query.filter];
  const q = String(req.query.q || '').toLowerCase().trim();
  let list = rows;
  if (f) list = list.filter(f);
  else list = list.filter((r) => r.bucket !== 'dropped' || req.query.include_dropped === '1');
  if (q) list = list.filter((r) => r.student.full_name.toLowerCase().includes(q) || r.student.phone.includes(q.replace(/\D/g, '') || '§'));
  res.json(list.map(S.studentRow).sort((a, b) => a.name.localeCompare(b.name)));
}));

/* ---------------- EMI tracker (section 7) ---------------- */
router.get('/tracker', auth, h(async (req, res) => {
  const { rows, data, today } = await snapshotFor(req.user, req.query.batch || null);
  const unpaidIds = data.instalments.filter((i) => i.type === 'EMI').map((i) => i._id);
  const maps = await S.loadReminderMaps(unpaidIds);
  let list = S.trackerRows(rows, { filter: req.query.filter || 'queue', today, ...maps });
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q) list = list.filter((r) => r.student_name.toLowerCase().includes(q) || r.phone.includes(q.replace(/\D/g, '') || '§'));
  res.json({ today, rows: list.slice(0, 1000), total: list.length, total_balance: E.sum(list, (r) => r.balance) });
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
    { header: 'Reference', key: 'r', width: 24 }, { header: 'Applied to', key: 'ap', width: 22 }, { header: 'Recorded by', key: 'by', width: 16 }, { header: 'Verified', key: 'v', width: 10 },
  ];
  rows.forEach((r) => {
    const label = new Map(r.instalments.map((i) => [sid(i._id), i.type === 'EMI' ? `EMI ${i.emi_number}` : i.type]));
    [...r.payments].sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1)).forEach((p) => wp.addRow({ d: E.fmtDate(p.payment_date), s: r.student.full_name, a: p.amount, m: p.mode, r: p.transaction_ref || '', ap: (p.allocations || []).map((a) => label.get(sid(a.instalment))).join(', '), by: p.recorded_by_name || '', v: p.verified ? 'Yes' : 'No' }));
  });

  [ws, wi, wp].forEach((s) => { s.getRow(1).font = { bold: true }; s.views = [{ state: 'frozen', ySplit: 1 }]; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${batch.code}-${todayIST()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;

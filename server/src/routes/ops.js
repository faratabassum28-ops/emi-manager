const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Student, Enrollment, Instalment, Payment, ReminderLog } = require('../models');
const { HttpError, h, auth, role, canVerify, batchScope, assertBatchAccess, logActivity } = require('../middleware');
const { getSettings } = require('../services/settings');
const { computeSnapshot } = require('../services/snapshot');
const money = require('../services/money');
const E = require('../lib/emi');
const { todayIST, isValidDate } = require('../lib/dates');

const router = express.Router();
const writer = role('Admin', 'Manager', 'CRM'); // Viewer is read-only (rule 11)
const mgr = role('Admin', 'Manager');
const bad = (m) => new HttpError(400, m);

/* ---------------- uploads (screenshots, agreements) ---------------- */
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only JPG, PNG, WebP or PDF files are allowed'))),
});

router.post('/uploads', auth, writer, upload.single('file'), h(async (req, res) => {
  if (!req.file) throw bad('No file received');
  res.status(201).json({ file: req.file.filename });
}));

// Screenshots are sensitive money records, so they are only served to signed-in users.
router.get('/files/:name', auth, h(async (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+$/.test(name)) throw new HttpError(404, 'File not found');
  const full = path.join(UPLOAD_DIR, name);
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) throw new HttpError(404, 'File not found');
  res.sendFile(full);
}));

/* ---------------- helpers ---------------- */
const waLink = (phone, text) => `https://wa.me/${String(phone).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

async function messageFor(key, { name, phone, state, inst, emiTotal, extra = {} }, settings) {
  const vars = {
    name,
    amount: E.fmtINR(state ? state.balance : 0),
    due_date: inst ? E.fmtDate(inst.due_date) : '',
    emi_number: inst ? `${inst.emi_number} of ${emiTotal}` : '',
    payment_link: settings.payment_link_base || '',
    ...extra,
  };
  const text = E.renderTemplate(settings.templates[key] || '', vars).trim();
  return { text, wa: waLink(phone, text), template_key: key };
}

async function loadRow(id, user) {
  const enr = await Enrollment.findById(id)
    .populate('student')
    .populate({ path: 'batch', populate: [{ path: 'program' }, { path: 'owner', select: 'name' }] })
    .lean();
  if (!enr) throw new HttpError(404, 'Enrollment not found');
  assertBatchAccess(user, enr.batch._id);
  const [instalments, payments, settings] = await Promise.all([
    Instalment.find({ enrollment: id }).lean(),
    Payment.find({ enrollment: id }).sort({ payment_date: -1, createdAt: -1 }).lean(),
    getSettings(),
  ]);
  const [row] = computeSnapshot({ enrollments: [enr], instalments, payments, rules: settings.reminder, today: todayIST() });
  return { row, settings };
}

/* ---------------- students ---------------- */
router.get('/students/search', auth, h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  const digits = q.replace(/\D/g, '');
  const or = [{ full_name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
  if (digits.length >= 3) or.push({ phone: new RegExp(digits) });
  res.json(await Student.find({ $or: or }).limit(10).lean());
}));

router.get('/students/:id/enrollments', auth, h(async (req, res) => {
  const scope = batchScope(req.user);
  const list = (await Enrollment.find({ student: req.params.id }).populate({ path: 'batch', populate: 'program' }).lean())
    .filter((e) => e.batch && e.batch.program && (!scope || scope.includes(String(e.batch._id))));
  res.json(list.map((e) => ({ enrollment_id: e._id, program: e.batch.program.name, batch: e.batch.batch_name, net_payable: e.net_payable, status: e.manual_status || 'Active' })));
}));

router.put('/students/:id', auth, mgr, h(async (req, res) => {
  const s = await Student.findById(req.params.id);
  if (!s) throw new HttpError(404, 'Student not found');
  const b = req.body || {};
  const before = { full_name: s.full_name, phone: s.phone, email: s.email };
  if (b.full_name) s.full_name = b.full_name.trim();
  if (b.phone) {
    const p = E.normalizePhone(b.phone);
    if (!E.isValidPhone(p)) throw bad('Phone must include the country code');
    s.phone = p;
  }
  if (b.email) s.email = b.email;
  for (const k of ['city', 'country', 'notes']) if (b[k] !== undefined) s[k] = b[k];
  await s.save();
  await logActivity(req.user, 'Student', s._id, 'update', { before, after: { full_name: s.full_name, phone: s.phone, email: s.email } });
  res.json(s);
}));

/* ---------------- enrollments ---------------- */
router.post('/enrollments', auth, writer, h(async (req, res) => {
  const enr = await money.createEnrollment(req.user, req.body || {});
  res.status(201).json({ id: enr._id });
}));

router.get('/enrollments/search', auth, h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const digits = q.replace(/\D/g, '');
  const or = [{ full_name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
  if (digits.length >= 3) or.push({ phone: new RegExp(digits) });
  const students = await Student.find({ $or: or }).limit(20).lean();
  const scope = batchScope(req.user);
  const filter = { student: { $in: students.map((s) => s._id) } };
  if (req.query.batch) filter.batch = req.query.batch;
  if (scope) filter.batch = req.query.batch ? (scope.includes(req.query.batch) ? req.query.batch : null) : { $in: scope };
  const list = await Enrollment.find(filter).populate('student').populate({ path: 'batch', populate: 'program' }).limit(30).lean();
  res.json(list.map((e) => ({ enrollment_id: e._id, name: e.student.full_name, phone: e.student.phone, program: e.batch.program.name, batch: e.batch.batch_name, status: e.manual_status || 'Active' })));
}));

router.get('/enrollments/:id', auth, h(async (req, res) => {
  const { row, settings } = await loadRow(req.params.id, req.user);
  const [reminders, others] = await Promise.all([
    ReminderLog.find({ enrollment: row.id }).sort({ sent_at: -1 }).limit(100).lean(),
    Enrollment.find({ student: row.student._id, _id: { $ne: row.id } }).populate({ path: 'batch', populate: 'program' }).lean(),
  ]);
  const reversed = new Set(row.payments.filter((p) => p.reversal_of).map((p) => String(p.reversal_of)));
  const e = row.enrollment;
  res.json({
    student: row.student,
    batch: { id: row.batch._id, code: row.batch.code, name: row.batch.batch_name, status: row.batch.status, owner: row.batch.owner && row.batch.owner.name },
    program: { id: row.batch.program._id, name: row.batch.program.name, max_emis: row.batch.program.max_emis },
    enrollment: {
      id: row.id, enrollment_date: e.enrollment_date, closed_by: e.closed_by, total_fee: e.total_fee, fee_change_reason: e.fee_change_reason,
      adjustments: e.adjustments, discount: e.discount, discount_reason: e.discount_reason, application_fee_paid: e.application_fee_paid,
      commitment_fee_paid: e.commitment_fee_paid, net_payable: e.net_payable, balance_due: e.balance_due, emi_count: e.emi_count,
      agreement_file: e.agreement_file, status_reason: e.status_reason, plan_history: e.plan_history, original_currency: e.original_currency, original_amount: e.original_amount,
    },
    status: row.status,
    bucket: row.bucket,
    paid: row.paid,
    balance: row.balance,
    emis_paid: row.emis_paid,
    emi_total: row.emi_total,
    instalments: row.instalments.map((s) => ({ id: s._id, type: s.type, emi_number: s.emi_number, amount_due: s.amount_due, amount_paid: s.amount_paid, balance: s.balance, due_date: s.due_date, paid_on: s.paid_on, status: s.status, days_overdue: s.days_overdue, days_late: s.days_late, waive_reason: s.waive_reason })),
    payments: row.payments.map((p) => ({ id: p._id, amount: p.amount, payment_date: p.payment_date, mode: p.mode, transaction_ref: p.transaction_ref, screenshot: p.screenshot, note: p.note, recorded_by: p.recorded_by_name, verified: p.verified, reversal_of: p.reversal_of, reversal_reason: p.reversal_reason, reversed: reversed.has(String(p._id)), imported: p.imported })),
    reminders,
    others: others.map((o) => ({ enrollment_id: o._id, program: o.batch.program.name, batch: o.batch.batch_name, status: o.manual_status || 'Active' })),
    discount_limit: settings.discount_limit,
  });
}));

router.put('/enrollments/:id/plan', auth, writer, h(async (req, res) => {
  const b = req.body || {};
  await money.restructurePlan(req.user, req.params.id, b.emis, b.reason);
  res.json({ ok: true });
}));

router.put('/enrollments/:id/status', auth, mgr, h(async (req, res) => {
  const b = req.body || {};
  await money.setEnrollmentStatus(req.user, req.params.id, b.status, b.reason);
  res.json({ ok: true });
}));

router.put('/enrollments/:id/agreement', auth, writer, h(async (req, res) => {
  const enr = await Enrollment.findById(req.params.id);
  if (!enr) throw new HttpError(404, 'Enrollment not found');
  assertBatchAccess(req.user, enr.batch);
  if (!req.body || !req.body.file) throw bad('No file received');
  enr.agreement_file = req.body.file;
  await enr.save();
  await logActivity(req.user, 'Enrollment', enr._id, 'agreement', { file: req.body.file });
  res.json({ ok: true });
}));

router.get('/enrollments/:id/welcome', auth, h(async (req, res) => {
  const { row, settings } = await loadRow(req.params.id, req.user);
  const lines = row.instalments.filter((s) => s.status !== 'Waived').map((s) => (s.type === 'EMI' ? `EMI ${s.emi_number}: ${E.fmtINR(s.amount_due)} due ${E.fmtDate(s.due_date)}` : `${s.type}: ${E.fmtINR(s.amount_due)} (paid)`));
  res.json(await messageFor('welcome', { name: row.student.full_name, phone: row.student.phone, state: null, inst: null, extra: { schedule: lines.join('\n') } }, settings));
}));

router.post('/instalments/:id/waive', auth, role('Admin'), h(async (req, res) => {
  await money.waiveInstalment(req.user, req.params.id, (req.body || {}).reason);
  res.json({ ok: true });
}));

/* ---------------- reminders (spec section 7) ---------------- */
async function remindContext(instalmentId, user) {
  const inst = await Instalment.findById(instalmentId).lean();
  if (!inst) throw new HttpError(404, 'Instalment not found');
  const { row, settings } = await loadRow(String(inst.enrollment), user);
  const state = row.instalments.find((s) => String(s._id) === String(inst._id));
  return { inst, row, settings, state };
}

router.post('/instalments/:id/whatsapp', auth, writer, h(async (req, res) => {
  const { inst, row, settings, state } = await remindContext(req.params.id, req.user);
  const key = (req.body || {}).template || E.pickTemplateKey(state);
  const msg = await messageFor(key, { name: row.student.full_name, phone: row.student.phone, state, inst, emiTotal: row.emi_total }, settings);
  await ReminderLog.create({ instalment: inst._id, enrollment: inst.enrollment, channel: 'WhatsApp', outcome: 'Sent', sent_by: req.user._id, sent_by_name: req.user.name, notes: `Template: ${key}` });
  res.json(msg);
}));

router.post('/reminders', auth, writer, h(async (req, res) => {
  const b = req.body || {};
  const inst = await Instalment.findById(b.instalment).lean();
  if (!inst) throw new HttpError(404, 'Instalment not found');
  assertBatchAccess(req.user, inst.batch);
  if (!['WhatsApp', 'Call', 'Email'].includes(b.channel)) throw bad('Choose a channel');
  const outcome = b.outcome || 'Sent';
  if (outcome === 'Will pay on date' || outcome === 'Asked for extension') {
    if (!isValidDate(b.promised_date)) throw bad('Enter the date the student promised to pay');
    if (b.promised_date < todayIST()) throw bad('Promised date cannot be in the past');
  }
  const log = await ReminderLog.create({ instalment: inst._id, enrollment: inst.enrollment, channel: b.channel, outcome, promised_date: b.promised_date || undefined, notes: b.notes, sent_by: req.user._id, sent_by_name: req.user.name });
  res.status(201).json(log);
}));

router.post('/reminders/bulk', auth, writer, h(async (req, res) => {
  const ids = ((req.body || {}).instalments || []).slice(0, 100);
  if (!ids.length) throw bad('Select at least one row');
  const items = [];
  for (const id of ids) {
    const { inst, row, settings, state } = await remindContext(id, req.user);
    if (state.balance <= 0) continue;
    const key = E.pickTemplateKey(state);
    const msg = await messageFor(key, { name: row.student.full_name, phone: row.student.phone, state, inst, emiTotal: row.emi_total }, settings);
    await ReminderLog.create({ instalment: inst._id, enrollment: inst.enrollment, channel: 'WhatsApp', outcome: 'Sent', sent_by: req.user._id, sent_by_name: req.user.name, notes: `Bulk, template: ${key}` });
    items.push({ instalment_id: id, name: row.student.full_name, phone: row.student.phone, ...msg });
  }
  res.json({ items });
}));

/* ---------------- payments (spec section 8) ---------------- */
router.post('/payments/preview', auth, writer, h(async (req, res) => {
  const b = req.body || {};
  res.json({ preview: await money.previewPayment({ enrollment: b.enrollment, instalments: b.instalments, amount: b.amount, date: b.payment_date }) });
}));

router.post('/payments', auth, writer, h(async (req, res) => {
  const out = await money.recordPayment(req.user, req.body || {});
  res.status(201).json({ id: out.payment._id, preview: out.preview, next: out.next });
}));

router.get('/payments', auth, h(async (req, res) => {
  const q = {};
  const scope = batchScope(req.user);
  if (req.query.batch) q.batch = req.query.batch;
  if (scope) q.batch = req.query.batch ? (scope.includes(req.query.batch) ? req.query.batch : null) : { $in: scope };
  if (req.query.enrollment) q.enrollment = req.query.enrollment;
  if (req.query.mode) q.mode = req.query.mode;
  if (req.query.verified === '0') { q.verified = false; q.reversal_of = { $exists: false }; }
  if (req.query.verified === '1') q.verified = true;
  if (req.query.from || req.query.to) q.payment_date = { ...(req.query.from ? { $gte: req.query.from } : {}), ...(req.query.to ? { $lte: req.query.to } : {}) };
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const list = await Payment.find(q)
    .sort({ payment_date: -1, createdAt: -1 })
    .limit(limit)
    .populate({ path: 'enrollment', select: 'student', populate: { path: 'student', select: 'full_name phone' } })
    .populate('batch', 'batch_name code')
    .populate('allocations.instalment', 'type emi_number')
    .lean();
  const reversed = new Set((await Payment.find({ reversal_of: { $in: list.map((p) => p._id) } }, 'reversal_of').lean()).map((p) => String(p.reversal_of)));
  res.json(list.map((p) => ({
    id: p._id, student: p.enrollment && p.enrollment.student ? p.enrollment.student.full_name : '', phone: p.enrollment && p.enrollment.student ? p.enrollment.student.phone : '',
    enrollment_id: p.enrollment && p.enrollment._id, batch: p.batch && p.batch.batch_name, amount: p.amount, payment_date: p.payment_date, mode: p.mode, transaction_ref: p.transaction_ref,
    screenshot: p.screenshot, recorded_by: p.recorded_by_name, verified: p.verified, verified_by: p.verified_by, reversal_of: p.reversal_of, reversed: reversed.has(String(p._id)),
    applied_to: (p.allocations || []).map((a) => (a.instalment ? (a.instalment.type === 'EMI' ? `EMI ${a.instalment.emi_number}` : a.instalment.type) : '')).join(', '), note: p.note, imported: p.imported,
  })));
}));

router.post('/payments/:id/verify', auth, h(async (req, res) => {
  if (!canVerify(req.user)) throw new HttpError(403, 'Only Accounts, Managers and Admins can verify payments');
  const p = await Payment.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Payment not found');
  assertBatchAccess(req.user, p.batch);
  const v = (req.body || {}).verified !== false;
  p.verified = v;
  p.verified_by = v ? req.user.name : undefined;
  p.verified_at = v ? new Date() : undefined;
  await p.save();
  await logActivity(req.user, 'Payment', p._id, v ? 'verify' : 'unverify', { amount: p.amount });
  res.json({ ok: true });
}));

router.post('/payments/:id/reverse', auth, role('Admin'), h(async (req, res) => {
  await money.reversePayment(req.user, req.params.id, (req.body || {}).reason);
  res.json({ ok: true });
}));

router.get('/payments/:id/thanks', auth, h(async (req, res) => {
  const p = await Payment.findById(req.params.id).lean();
  if (!p) throw new HttpError(404, 'Payment not found');
  const { row, settings } = await loadRow(String(p.enrollment), req.user);
  const next = row.next;
  const msg = await messageFor('thanks', {
    name: row.student.full_name, phone: row.student.phone, state: null, inst: null,
    extra: { amount: E.fmtINR(p.amount), paid_date: E.fmtDate(p.payment_date), ref: p.transaction_ref, next_amount: next ? E.fmtINR(next.balance) : 'nil', next_due_date: next ? E.fmtDate(next.due_date) : 'none - all paid' },
  }, settings);
  res.json(msg);
}));

module.exports = router;

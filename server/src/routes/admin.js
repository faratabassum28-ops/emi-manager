const express = require('express');
const bcrypt = require('bcryptjs');
const { User, Program, Batch, AdjustmentType, Setting, ActivityLog } = require('../models');
const { HttpError, h, auth, role, signToken, canVerify, batchScope, logActivity } = require('../middleware');
const { getSettings } = require('../services/settings');
const { isValidDate } = require('../lib/dates');

const router = express.Router();
const mgr = role('Admin', 'Manager');
const adminOnly = role('Admin');
const bad = (m) => new HttpError(400, m);

const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, can_verify: canVerify(u), batches: u.batches, active: u.active });

/* ---------------- auth ---------------- */
router.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: String(email || '').toLowerCase().trim() });
  if (!user || !user.active || !(await bcrypt.compare(String(password || ''), user.password_hash))) throw new HttpError(401, 'Wrong email or password');
  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/auth/me', auth, h(async (req, res) => res.json({ user: publicUser(req.user) })));

router.post('/auth/password', auth, h(async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await bcrypt.compare(String(current || ''), req.user.password_hash))) throw bad('Current password is wrong');
  if (String(next || '').length < 8) throw bad('New password must be at least 8 characters');
  req.user.password_hash = await bcrypt.hash(next, 10);
  await req.user.save();
  res.json({ ok: true });
}));

/* ---------------- navigation: programs with their live batches ---------------- */
router.get('/nav', auth, h(async (req, res) => {
  const scope = batchScope(req.user);
  const [programs, batches] = await Promise.all([
    Program.find({ active: true }).sort({ name: 1 }).lean(),
    Batch.find({ status: { $ne: 'Archived' }, ...(scope ? { _id: { $in: scope } } : {}) }).sort({ createdAt: 1 }).lean(),
  ]);
  res.json(programs.map((p) => ({ ...p, batches: batches.filter((b) => String(b.program) === String(p._id)) })).filter((p) => !scope || p.batches.length));
}));

/* ---------------- programs ---------------- */
router.get('/programs', auth, h(async (req, res) => {
  const q = req.user.role === 'Admin' || req.user.role === 'Manager' ? {} : { active: true };
  res.json(await Program.find(q).sort({ name: 1 }).lean());
}));

function programFields(b) {
  const num = (v, label, min = 0) => {
    const n = Number(v || 0);
    if (!Number.isInteger(n) || n < min) throw bad(`${label} must be a whole number`);
    return n;
  };
  if (!b.name || !String(b.name).trim()) throw bad('Program name is required');
  return {
    name: String(b.name).trim(),
    default_fee: num(b.default_fee, 'Default fee'),
    default_application_fee: num(b.default_application_fee, 'Default application fee'),
    default_commitment_fee: num(b.default_commitment_fee, 'Default commitment fee'),
    max_emis: num(b.max_emis || 12, 'Max EMIs', 1),
    active: b.active !== false,
  };
}

router.post('/programs', auth, mgr, h(async (req, res) => {
  const f = programFields(req.body);
  const code = String(req.body.code || f.name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const p = await Program.create({ ...f, code });
  await logActivity(req.user, 'Program', p._id, 'create', f);
  res.status(201).json(p);
}));

router.put('/programs/:id', auth, mgr, h(async (req, res) => {
  const p = await Program.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Program not found');
  const f = programFields({ ...p.toObject(), ...req.body });
  const before = p.toObject();
  Object.assign(p, f);
  await p.save();
  await logActivity(req.user, 'Program', p._id, 'update', { before: { name: before.name, default_fee: before.default_fee, active: before.active }, after: f });
  res.json(p);
}));

/* ---------------- batches (never deleted; archive instead) ---------------- */
router.get('/batches', auth, h(async (req, res) => {
  const scope = batchScope(req.user);
  const q = {};
  if (req.query.program) q.program = req.query.program;
  if (req.query.include_archived !== '1') q.status = { $ne: 'Archived' };
  if (scope) q._id = { $in: scope };
  res.json(await Batch.find(q).populate('program', 'name code').populate('owner', 'name').sort({ createdAt: 1 }).lean());
}));

router.post('/batches', auth, mgr, h(async (req, res) => {
  const b = req.body || {};
  const program = await Program.findById(b.program);
  if (!program) throw bad('Choose a program');
  if (!b.batch_name || !b.batch_name.trim()) throw bad('Batch name is required');
  for (const k of ['start_date', 'end_date']) if (b[k] && !isValidDate(b[k])) throw bad(`${k.replace('_', ' ')} is invalid`);
  if (b.start_date && b.end_date && b.end_date < b.start_date) throw bad('End date is before the start date');
  const fee = b.fee_override === '' || b.fee_override === null || b.fee_override === undefined ? null : Number(b.fee_override);
  if (fee !== null && (!Number.isInteger(fee) || fee < 0)) throw bad('Fee override must be a whole number');
  let n = (await Batch.countDocuments({ program: program._id })) + 1;
  let code;
  do { code = `${program.code}-B${String(n++).padStart(2, '0')}`; } while (await Batch.exists({ code }));
  const batch = await Batch.create({ code, program: program._id, batch_name: b.batch_name.trim(), start_date: b.start_date, end_date: b.end_date, fee_override: fee, status: b.status || 'Upcoming', owner: b.owner || undefined });
  await logActivity(req.user, 'Batch', batch._id, 'create', { code, batch_name: batch.batch_name });
  res.status(201).json(batch);
}));

router.put('/batches/:id', auth, mgr, h(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw new HttpError(404, 'Batch not found');
  const b = req.body || {};
  const before = { batch_name: batch.batch_name, status: batch.status, fee_override: batch.fee_override, owner: batch.owner };
  if (b.batch_name !== undefined) batch.batch_name = String(b.batch_name).trim();
  for (const k of ['start_date', 'end_date']) if (b[k] !== undefined) { if (b[k] && !isValidDate(b[k])) throw bad(`${k} is invalid`); batch[k] = b[k]; }
  if (b.fee_override !== undefined) batch.fee_override = b.fee_override === '' || b.fee_override === null ? null : Number(b.fee_override);
  if (b.status !== undefined) batch.status = b.status;
  if (b.owner !== undefined) batch.owner = b.owner || undefined;
  await batch.save();
  await logActivity(req.user, 'Batch', batch._id, 'update', { before, after: { batch_name: batch.batch_name, status: batch.status, fee_override: batch.fee_override, owner: batch.owner } });
  res.json(batch);
}));

/* ---------------- previous-program adjustments ---------------- */
router.get('/adjustment-types', auth, h(async (req, res) => res.json(await AdjustmentType.find({}).sort({ name: 1 }).lean())));

router.post('/adjustment-types', auth, mgr, h(async (req, res) => {
  const { name, default_amount, active, target_programs } = req.body || {};
  if (!name || !name.trim()) throw bad('Name is required');
  const t = await AdjustmentType.create({ name: name.trim(), default_amount: Number(default_amount || 0), active: active !== false, target_programs: target_programs || [] });
  await logActivity(req.user, 'AdjustmentType', t._id, 'create', { name: t.name, default_amount: t.default_amount });
  res.status(201).json(t);
}));

router.put('/adjustment-types/:id', auth, mgr, h(async (req, res) => {
  const t = await AdjustmentType.findById(req.params.id);
  if (!t) throw new HttpError(404, 'Not found');
  const { name, default_amount, active, target_programs } = req.body || {};
  if (name !== undefined) t.name = name.trim();
  if (default_amount !== undefined) t.default_amount = Number(default_amount);
  if (active !== undefined) t.active = !!active;
  if (target_programs !== undefined) t.target_programs = target_programs;
  await t.save();
  await logActivity(req.user, 'AdjustmentType', t._id, 'update', { name: t.name, default_amount: t.default_amount, active: t.active });
  res.json(t);
}));

/* ---------------- settings (payment modes, reminder rules, templates) ---------------- */
router.get('/settings', auth, h(async (req, res) => res.json(await getSettings())));

router.put('/settings', auth, mgr, h(async (req, res) => {
  const b = req.body || {};
  const set = {};
  if (b.payment_modes) {
    const modes = [...new Set(b.payment_modes.map((m) => String(m).trim()).filter(Boolean))];
    if (!modes.length) throw bad('Keep at least one payment mode');
    set.payment_modes = modes;
  }
  if (b.reminder) {
    const r = {};
    for (const k of ['days_before', 'grace_days', 'defaulter_days']) {
      const n = Number(b.reminder[k]);
      if (!Number.isInteger(n) || n < 0) throw bad(`${k.replace('_', ' ')} must be a whole number`);
      r[k] = n;
    }
    set.reminder = r;
  }
  if (b.discount_limit !== undefined) set.discount_limit = Math.max(0, Number(b.discount_limit) || 0);
  if (b.payment_link_base !== undefined) set.payment_link_base = String(b.payment_link_base).trim();
  if (b.templates) set.templates = b.templates;
  const s = await Setting.findOneAndUpdate({ key: 'main' }, { $set: set }, { upsert: true, new: true });
  await logActivity(req.user, 'Settings', s._id, 'update', Object.keys(set));
  res.json(await getSettings());
}));

/* ---------------- users & roles ---------------- */
router.get('/users', auth, role('Admin', 'Manager'), h(async (req, res) => {
  const users = await User.find({}).sort({ name: 1 }).lean();
  res.json(users.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, batches: u.batches, can_verify: u.can_verify, active: u.active })));
}));

router.post('/users', auth, adminOnly, h(async (req, res) => {
  const { name, email, password, role: r, batches, can_verify } = req.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '')) throw bad('Name and a valid email are required');
  if (String(password || '').length < 8) throw bad('Temporary password must be at least 8 characters');
  const u = await User.create({ name: name.trim(), email, password_hash: await bcrypt.hash(password, 10), role: r || 'CRM', batches: batches || [], can_verify: !!can_verify });
  await logActivity(req.user, 'User', u._id, 'create', { email: u.email, role: u.role });
  res.status(201).json(publicUser(u));
}));

router.put('/users/:id', auth, adminOnly, h(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  const { name, role: r, batches, can_verify, active, password } = req.body || {};
  if (String(u._id) === String(req.user._id) && (active === false || (r && r !== 'Admin'))) throw bad('You cannot remove your own admin access');
  if (name !== undefined) u.name = name;
  if (r !== undefined) u.role = r;
  if (batches !== undefined) u.batches = batches;
  if (can_verify !== undefined) u.can_verify = !!can_verify;
  if (active !== undefined) u.active = !!active;
  if (password) {
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    u.password_hash = await bcrypt.hash(password, 10);
  }
  await u.save();
  await logActivity(req.user, 'User', u._id, 'update', { role: u.role, active: u.active, batches: (u.batches || []).length });
  res.json(publicUser(u));
}));

module.exports = router;

// History & audit: per-enrollment timeline and the global activity feed (filter, page, export).
const express = require('express');
const mongoose = require('mongoose');
const { ActivityLog, ReminderLog, Payment, Instalment, Enrollment } = require('../models');
const { HttpError, h, auth, role, assertBatchAccess } = require('../middleware');
const H = require('../lib/history');

const router = express.Router();
const sid = (x) => String(x);
const ENTITIES = ['Enrollment', 'Payment', 'Instalment', 'Student', 'Reminder', 'Program', 'Batch', 'AdjustmentType', 'Settings', 'User'];

/* ---------------- one student's full trail ---------------- */
router.get('/enrollments/:id/history', auth, h(async (req, res) => {
  const enr = await Enrollment.findById(req.params.id, 'student batch').lean();
  if (!enr) throw new HttpError(404, 'Enrollment not found');
  assertBatchAccess(req.user, enr.batch);
  const [pays, insts] = await Promise.all([
    Payment.find({ enrollment: enr._id }, '_id').lean(),
    Instalment.find({ enrollment: enr._id }, '_id').lean(),
  ]);
  const ids = [enr._id, enr.student, ...pays.map((p) => p._id), ...insts.map((i) => i._id)].map(sid);
  const [acts, rems] = await Promise.all([
    ActivityLog.find({ entity_id: { $in: ids } }).sort({ createdAt: -1 }).limit(500).lean(),
    ReminderLog.find({ enrollment: enr._id }).sort({ sent_at: -1 }).limit(500).lean(),
  ]);
  const events = [...acts.map(H.fromActivity), ...rems.map(H.fromReminder)].sort(H.byNewest);
  res.json({ events });
}));

/* ---------------- global feed ---------------- */
// IST calendar day -> UTC instant
const istStart = (d) => new Date(`${d}T00:00:00+05:30`);
const istEnd = (d) => new Date(`${d}T23:59:59.999+05:30`);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

async function buildFeed(query, cap) {
  const range = {};
  if (isDay(query.from)) range.$gte = istStart(query.from);
  if (isDay(query.to)) range.$lte = istEnd(query.to);
  const aq = {};
  if (query.entity && query.entity !== 'Reminder') aq.entity = query.entity;
  if (query.action) aq.action = String(query.action);
  if (query.user) aq.user_name = String(query.user);
  if (Object.keys(range).length) aq.createdAt = range;
  const wantReminders = !query.entity || query.entity === 'Reminder';
  const wantActivity = query.entity !== 'Reminder';
  const rq = {};
  if (query.user) rq.sent_by_name = String(query.user);
  if (Object.keys(range).length) rq.sent_at = range;
  if (query.action && wantReminders) rq.channel = new RegExp(`^${String(query.action).replace(/[^a-z]/gi, '')}$`, 'i');

  const [acts, rems] = await Promise.all([
    wantActivity ? ActivityLog.find(aq).sort({ createdAt: -1 }).limit(cap).lean() : [],
    wantReminders && (!query.action || ['whatsapp', 'call', 'email'].includes(String(query.action).toLowerCase())) ? ReminderLog.find(rq).sort({ sent_at: -1 }).limit(cap).lean() : [],
  ]);
  let events = [...acts.map(H.fromActivity), ...rems.map(H.fromReminder)];

  // Resolve which student / batch each event belongs to
  const want = (e) => mongoose.isValidObjectId(e.entity_id);
  const payIds = events.filter((e) => e.entity === 'Payment' && want(e)).map((e) => e.entity_id);
  const instIds = events.filter((e) => ['Instalment', 'Reminder'].includes(e.entity) && want(e)).map((e) => e.entity_id);
  const [pmap, imap] = await Promise.all([
    payIds.length ? Payment.find({ _id: { $in: payIds } }, 'enrollment').lean() : [],
    instIds.length ? Instalment.find({ _id: { $in: instIds } }, 'enrollment').lean() : [],
  ]);
  const enrOfPay = new Map(pmap.map((p) => [sid(p._id), sid(p.enrollment)]));
  const enrOfInst = new Map(imap.map((i) => [sid(i._id), sid(i.enrollment)]));
  for (const e of events) {
    if (e.entity === 'Enrollment') e.enrollment_id = e.entity_id;
    else if (e.entity === 'Payment') e.enrollment_id = enrOfPay.get(e.entity_id) || null;
    else if (e.entity === 'Instalment') e.enrollment_id = enrOfInst.get(e.entity_id) || null;
    else if (e.entity === 'Reminder' && !e.enrollment_id) e.enrollment_id = enrOfInst.get(e.entity_id) || null;
  }
  const enrIds = [...new Set(events.map((e) => e.enrollment_id).filter((x) => x && mongoose.isValidObjectId(x)))];
  const enrs = enrIds.length ? await Enrollment.find({ _id: { $in: enrIds } }, 'student batch').populate('student', 'full_name').populate('batch', 'code batch_name').lean() : [];
  const info = new Map(enrs.map((e) => [sid(e._id), { student: e.student ? e.student.full_name : '', batch: e.batch ? e.batch.code : '' }]));
  for (const e of events) {
    const i = e.enrollment_id && info.get(e.enrollment_id);
    e.student = i ? i.student : '';
    e.batch = i ? i.batch : '';
  }

  const q = String(query.q || '').toLowerCase().trim();
  if (q) events = events.filter((e) => [e.label, e.detail, e.by, e.reason, e.student, e.batch].join(' ').toLowerCase().includes(q));
  events.sort(H.byNewest);
  return events;
}

router.get('/activity', auth, role('Admin', 'Manager'), h(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const events = await buildFeed(req.query, 2000);
  const users = (await ActivityLog.distinct('user_name')).filter(Boolean).sort();
  res.json({ total: events.length, page, limit, items: events.slice((page - 1) * limit, page * limit), users, entities: ENTITIES });
}));

const csvCell = (v) => {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get('/activity/export', auth, role('Admin', 'Manager'), h(async (req, res) => {
  const events = await buildFeed(req.query, 5000);
  const head = ['When (IST)', 'Who', 'Student', 'Batch', 'Type', 'What happened', 'Details', 'Reason'];
  const ist = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16);
  const lines = [head.join(',')].concat(events.map((e) => [ist(e.at), e.by, e.student, e.batch, e.entity, e.label, e.detail, e.reason].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}`);
}));

module.exports = router;

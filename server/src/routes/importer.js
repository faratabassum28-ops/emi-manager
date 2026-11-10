// Bulk import of existing students from CSV (spec section 11.1). Preview first, save only after review.
const express = require('express');
const { parse } = require('csv-parse/sync');
const { Program, Batch, AdjustmentType } = require('../models');
const { HttpError, h, auth, role } = require('../middleware');
const money = require('../services/money');
const E = require('../lib/emi');
const { todayIST, isValidDate } = require('../lib/dates');

const router = express.Router();
const mgr = role('Admin', 'Manager');
const norm = (s) => String(s || '').toLowerCase().replace(/[–—-]/g, ' ').replace(/\s+/g, ' ').trim();

const TEMPLATE = [
  'program,batch,full_name,phone,email,total_fee,adjustment_1_name,adjustment_1_amount,adjustment_2_name,adjustment_2_amount,application_fee,commitment_fee,emi_count,emi1_amount,emi1_due,emi1_paid,emi2_amount,emi2_due,emi2_paid',
  'SUPER,Batch 7 - Oct 2026,Sample Student,+919800000000,sample@email.com,250000,Tarot L1,10000,Reiki L1+L2,6999,10000,40000,6,30500,2026-11-05,30500,30500,2026-12-05,0',
].join('\n');

router.get('/import/template', auth, mgr, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="emi-import-template.csv"');
  res.send(TEMPLATE + '\n');
});

function parseRow(raw, ctx) {
  const errors = [];
  const get = (k) => String(raw[k] === undefined || raw[k] === null ? '' : raw[k]).trim();
  const int = (k, label, { required = false, def = 0 } = {}) => {
    const v = get(k);
    if (v === '') {
      if (required) errors.push(`${label} is missing`);
      return def;
    }
    const n = Number(v.replace(/,/g, ''));
    if (!Number.isInteger(n) || n < 0) {
      errors.push(`${label} must be a whole number`);
      return def;
    }
    return n;
  };

  const program = ctx.programs.find((p) => norm(p.name) === norm(get('program')) || norm(p.code) === norm(get('program')));
  if (!program) errors.push(`Program "${get('program')}" not found`);
  const batch = program && ctx.batches.find((b) => String(b.program) === String(program._id) && (norm(b.batch_name) === norm(get('batch')) || norm(b.code) === norm(get('batch'))));
  if (program && !batch) errors.push(`Batch "${get('batch')}" not found under ${program.name}. Create it in Settings first`);

  const name = get('full_name');
  if (!name) errors.push('Name is missing');
  const phone = E.normalizePhone(get('phone'));
  if (!E.isValidPhone(phone)) errors.push('Phone needs a country code, e.g. +919800000000');
  const email = get('email');
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('Email is invalid');

  const listFee = batch ? (batch.fee_override ?? program.default_fee) : 0;
  const total_fee = int('total_fee', 'Total fee', { def: listFee });
  const enrollment_date = get('enrollment_date') || todayIST();
  if (!isValidDate(enrollment_date)) errors.push('enrollment_date must be YYYY-MM-DD');

  const adjustments = [];
  for (let k = 1; k <= 5; k++) {
    const n = get(`adjustment_${k}_name`);
    if (!n) continue;
    const amount = int(`adjustment_${k}_amount`, `Adjustment ${k} amount`, { required: true });
    const type = ctx.types.find((t) => norm(t.name) === norm(n));
    adjustments.push({ adjustment: type ? type._id : undefined, name: n, amount });
  }
  const application_fee = int('application_fee', 'Application fee');
  const commitment_fee = int('commitment_fee', 'Commitment fee');
  const emi_count = int('emi_count', 'EMI count', { required: true });
  const fees = E.computeFees({ total_fee, adjustments, discount: 0, application_fee, commitment_fee });

  const emis = [];
  const emi_paid = [];
  for (let k = 1; k <= emi_count; k++) {
    const amount_due = int(`emi${k}_amount`, `EMI ${k} amount`, { required: true });
    const due_date = get(`emi${k}_due`);
    if (!isValidDate(due_date)) errors.push(`EMI ${k} due date must be YYYY-MM-DD`);
    const paid = int(`emi${k}_paid`, `EMI ${k} paid`);
    if (paid > amount_due) errors.push(`EMI ${k}: paid (${paid}) is more than the amount (${amount_due})`);
    emis.push({ amount_due, due_date });
    emi_paid.push(paid);
  }
  if (!errors.length) errors.push(...E.validatePlan(fees.balance_due, emis));
  if (fees.balance_due < 0) errors.push('Fees and credits exceed the total');

  const payload = errors.length ? null : {
    batch: batch._id,
    student: { full_name: name, phone, email },
    total_fee,
    fee_change_reason: total_fee !== listFee ? 'Imported from sheet' : undefined,
    adjustments,
    application: { amount: application_fee, date: enrollment_date },
    commitment: { amount: commitment_fee, date: enrollment_date },
    enrollment_date,
    emis,
    emi_paid,
  };
  return {
    ok: !errors.length,
    errors,
    display: { program: program && program.name, batch: batch && batch.batch_name, name, phone, net_payable: fees.net_payable, balance_due: fees.balance_due, emis: emis.length, paid: E.sum(emi_paid) + application_fee + commitment_fee },
    payload,
  };
}

router.post('/import/preview', auth, mgr, h(async (req, res) => {
  let records;
  try {
    records = parse(String(req.body.csv || ''), { columns: (hd) => hd.map((x) => String(x).trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (e) {
    throw new HttpError(400, `Could not read the CSV: ${e.message}`);
  }
  if (!records.length) throw new HttpError(400, 'The file has no data rows');
  if (records.length > 500) throw new HttpError(400, 'Import at most 500 rows at a time');
  const [programs, batches, types] = await Promise.all([Program.find({}).lean(), Batch.find({}).lean(), AdjustmentType.find({}).lean()]);
  const ctx = { programs, batches, types };
  const rows = records.map((r, i) => ({ line: i + 2, ...parseRow(r, ctx) }));
  res.json({ rows, valid: rows.filter((r) => r.ok).length, invalid: rows.filter((r) => !r.ok).length });
}));

router.post('/import/commit', auth, mgr, h(async (req, res) => {
  const rows = req.body.rows || [];
  const results = [];
  for (const r of rows) {
    try {
      const enr = await money.createEnrollment(req.user, { ...r.payload }, { imported: true });
      results.push({ line: r.line, ok: true, id: enr._id });
    } catch (e) {
      results.push({ line: r.line, ok: false, error: e.message });
    }
  }
  res.json({ results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
}));

router.parseRow = parseRow; // exposed for tests
module.exports = router;

// Enrollment + payment workflows. Business rules from spec section 9 are enforced here.
const { Student, Enrollment, Instalment, Payment, Batch } = require('../models');
const E = require('../lib/emi');
const { HttpError, logActivity, assertBatchAccess } = require('../middleware');
const { getSettings } = require('./settings');
const { recalcEnrollment } = require('./snapshot');
const { todayIST, isValidDate } = require('../lib/dates');

const isInt = Number.isInteger;
const bad = (msg) => new HttpError(400, msg);

function parseUpfront(label, o, settings, imported) {
  const amount = Number(o && o.amount ? o.amount : 0);
  if (!amount) return null;
  if (!isInt(amount) || amount < 0) throw bad(`${label}: amount must be a whole number of rupees`);
  if (!isValidDate(o.date)) throw bad(`${label}: payment date is required`);
  if (imported) return { amount, date: o.date, mode: 'Imported' };
  if (!settings.payment_modes.includes(o.mode)) throw bad(`${label}: choose a payment mode`);
  if (!o.screenshot) throw bad(`${label}: payment screenshot is mandatory`);
  return { amount, date: o.date, mode: o.mode, screenshot: o.screenshot };
}

/* ======================= New enrollment (spec section 6) ======================= */
async function createEnrollment(user, p, { imported = false } = {}) {
  const settings = await getSettings();
  const batch = await Batch.findById(p.batch).populate('program');
  if (!batch) throw new HttpError(404, 'Batch not found');
  assertBatchAccess(user, batch._id);
  if (batch.status === 'Archived') throw bad('This batch is archived');
  const program = batch.program;

  // ---- validate everything BEFORE writing anything ----
  let studentData = null;
  let student = null;
  if (p.student_id) {
    student = await Student.findById(p.student_id);
    if (!student) throw new HttpError(404, 'Student not found');
  } else {
    const s = p.student || {};
    const phone = E.normalizePhone(s.phone);
    if (!s.full_name || !s.full_name.trim()) throw bad('Student name is required');
    if (!E.isValidPhone(phone)) throw bad('Phone must include the country code, e.g. +919800000000');
    if (!/^\S+@\S+\.\S+$/.test(s.email || '')) throw bad('A valid email is required');
    student = await Student.findOne({ phone });
    if (!student) studentData = { full_name: s.full_name.trim(), phone, email: s.email, city: s.city, country: s.country, notes: s.notes };
  }
  if (student && (await Enrollment.exists({ student: student._id, batch: batch._id }))) {
    throw new HttpError(409, `${student.full_name} (${student.phone}) is already enrolled in this batch`);
  }

  const listFee = batch.fee_override ?? program.default_fee;
  const total_fee = p.total_fee === undefined || p.total_fee === null || p.total_fee === '' ? listFee : Number(p.total_fee);
  if (!isInt(total_fee) || total_fee < 0) throw bad('Total fee must be a whole number of rupees');
  if (total_fee !== listFee && !(p.fee_change_reason || '').trim()) throw bad('Please give a reason for changing the total fee');

  const adjustments = (p.adjustments || []).map((a) => {
    const amount = Number(a.amount);
    if (!isInt(amount) || amount < 0) throw bad('Adjustment amounts must be whole rupees');
    if (!a.name) throw bad('Each adjustment needs a name');
    return { adjustment: a.adjustment || undefined, name: a.name, amount, notes: a.notes };
  });
  const adjTotal = E.sum(adjustments, (a) => a.amount);
  if (adjTotal > total_fee) throw bad('Adjustments cannot exceed the total fee');

  const discount = Number(p.discount || 0);
  if (!isInt(discount) || discount < 0) throw bad('Discount must be a whole number of rupees');
  if (discount > 0 && !(p.discount_reason || '').trim()) throw bad('Please give a reason for the discount');
  if (discount > settings.discount_limit && user.role === 'CRM') {
    throw new HttpError(403, `Discounts above ₹${settings.discount_limit.toLocaleString('en-IN')} need Manager approval. Ask a Manager to save this enrollment.`);
  }

  const app = parseUpfront('Application fee', p.application, settings, imported);
  const com = parseUpfront('Commitment fee', p.commitment, settings, imported);

  const fees = E.computeFees({ total_fee, adjustments, discount, application_fee: app ? app.amount : 0, commitment_fee: com ? com.amount : 0 });
  if (fees.net_payable < 0) throw bad('Adjustments and discount exceed the total fee');
  if (fees.balance_due < 0) throw bad('Application + commitment fee exceed the net payable');

  const emis = (p.emis || []).map((e) => ({ amount_due: Number(e.amount_due), due_date: e.due_date }));
  const planErrors = E.validatePlan(fees.balance_due, emis);
  if (planErrors.length) throw bad(planErrors.join('; '));
  if (emis.length > program.max_emis) throw bad(`${program.name} allows at most ${program.max_emis} EMIs`);

  // ---- write ----
  const created = { student: null, enrollment: null };
  try {
    if (!student) {
      student = await Student.create(studentData);
      created.student = student._id;
    }
    const enr = await Enrollment.create({
      student: student._id,
      batch: batch._id,
      enrollment_date: isValidDate(p.enrollment_date) ? p.enrollment_date : todayIST(),
      closed_by: p.closed_by || user.name,
      total_fee,
      fee_change_reason: p.fee_change_reason,
      adjustments,
      discount,
      discount_reason: p.discount_reason,
      application_fee_paid: app ? app.amount : 0,
      commitment_fee_paid: com ? com.amount : 0,
      net_payable: fees.net_payable,
      balance_due: fees.balance_due,
      emi_count: emis.length,
      agreement_file: p.agreement_file,
      original_currency: p.original_currency,
      original_amount: p.original_amount,
    });
    created.enrollment = enr._id;

    const mk = (type, extra) => ({ enrollment: enr._id, batch: batch._id, type, ...extra });
    const rows = [];
    if (app) rows.push(mk('Application fee', { amount_due: app.amount, due_date: app.date }));
    if (com) rows.push(mk('Commitment fee', { amount_due: com.amount, due_date: com.date }));
    emis.forEach((e, i) => rows.push(mk('EMI', { emi_number: i + 1, amount_due: e.amount_due, due_date: e.due_date })));
    const insts = await Instalment.insertMany(rows);

    const pay = [];
    const addPay = (inst, amount, date, mode, screenshot, note) =>
      pay.push({ enrollment: enr._id, batch: batch._id, allocations: [{ instalment: inst._id, amount }], amount, payment_date: date, mode, screenshot, note, recorded_by: user._id, recorded_by_name: user.name, imported });
    let n = 0;
    if (app) addPay(insts[n++], app.amount, app.date, app.mode, app.screenshot, 'Application fee');
    if (com) addPay(insts[n++], com.amount, com.date, com.mode, com.screenshot, 'Commitment fee');
    if (imported) {
      (p.emi_paid || []).forEach((paid, i) => {
        paid = Number(paid || 0);
        if (paid > 0) {
          const inst = insts[n + i];
          const when = inst.due_date < todayIST() ? inst.due_date : todayIST();
          addPay(inst, paid, when, 'Imported', undefined, 'Imported history');
        }
      });
    }
    if (pay.length) await Payment.insertMany(pay);
    await recalcEnrollment(enr._id);
    await logActivity(user, 'Enrollment', enr._id, imported ? 'import' : 'create', { student: student.full_name, batch: batch.code, net_payable: fees.net_payable, balance_due: fees.balance_due, emis: emis.length });
    return enr;
  } catch (err) {
    // best-effort rollback (Mongo standalone has no transactions)
    if (created.enrollment) {
      await Promise.all([Instalment.deleteMany({ enrollment: created.enrollment }), Payment.deleteMany({ enrollment: created.enrollment }), Enrollment.deleteOne({ _id: created.enrollment })]);
    }
    if (created.student) await Student.deleteOne({ _id: created.student });
    throw err;
  }
}

/* ======================= Record payment (spec section 8) ======================= */
async function buildAllocation(enrollmentId, instalmentIds, amount, date, rules) {
  const enr = await Enrollment.findById(enrollmentId);
  if (!enr) throw new HttpError(404, 'Enrollment not found');
  if (['Refunded', 'Dropped'].includes(enr.manual_status)) throw bad(`This enrollment is ${enr.manual_status}; payments cannot be recorded`);
  if (!isInt(amount) || amount <= 0) throw bad('Amount must be a positive whole number of rupees');
  const insts = await Instalment.find({ enrollment: enr._id }).lean();
  const { allocations, unapplied } = E.allocatePayment(
    amount,
    insts.map((i) => ({ ...i, id: i._id })),
    instalmentIds || []
  );
  if (unapplied > 0) {
    const open = E.sum(insts.filter((i) => !i.waived), (i) => Math.max(i.amount_due - i.amount_paid, 0));
    throw bad(`Amount is ₹${unapplied.toLocaleString('en-IN')} more than the remaining balance of ₹${open.toLocaleString('en-IN')}`);
  }
  const byId = new Map(insts.map((i) => [String(i._id), i]));
  const preview = allocations.map((a) => {
    const i = byId.get(String(a.instalment));
    const after = { ...i, amount_paid: i.amount_paid + a.amount, paid_on: i.amount_paid + a.amount >= i.amount_due ? date : null };
    const st = E.instalmentState(after, date || todayIST(), rules);
    return {
      instalment_id: String(i._id),
      label: i.type === 'EMI' ? `EMI ${i.emi_number}` : i.type,
      due_date: i.due_date,
      amount_due: i.amount_due,
      already_paid: i.amount_paid,
      paying: a.amount,
      remaining_after: st.balance,
      status_after: st.status,
    };
  });
  return { enr, allocations, preview };
}

async function previewPayment({ enrollment, instalments, amount, date }) {
  const settings = await getSettings();
  const { preview } = await buildAllocation(enrollment, instalments, Number(amount), isValidDate(date) ? date : todayIST(), settings.reminder);
  return preview;
}

async function recordPayment(user, b) {
  const settings = await getSettings();
  const amount = Number(b.amount);
  if (!isValidDate(b.payment_date)) throw bad('Payment date is required');
  if (b.payment_date > todayIST()) throw bad('Payment date cannot be in the future');
  if (!settings.payment_modes.includes(b.mode)) throw bad('Choose a payment mode');
  if (!b.screenshot) throw bad('Payment screenshot is mandatory');

  const { enr, allocations, preview } = await buildAllocation(b.enrollment, b.instalments, amount, b.payment_date, settings.reminder);
  assertBatchAccess(user, enr.batch);

  const payment = await Payment.create({
    enrollment: enr._id,
    batch: enr.batch,
    allocations,
    amount,
    payment_date: b.payment_date,
    mode: b.mode,
    screenshot: b.screenshot,
    note: b.note,
    original_currency: b.original_currency,
    original_amount: b.original_amount,
    recorded_by: user._id,
    recorded_by_name: user.name,
  });
  await recalcEnrollment(enr._id);
  await logActivity(user, 'Payment', payment._id, 'create', { amount, mode: b.mode, ref, allocations: preview.map((p) => `${p.label}: ${p.paying}`) });

  // optional agreed change to the next EMI date (reason required, logged)
  let next = await nextOpenEmi(enr._id);
  if (b.next_due_date && next) {
    if (!isValidDate(b.next_due_date)) throw bad('Next due date is invalid');
    if (!(b.next_reason || '').trim()) throw bad('Please give a reason for changing the next due date');
    const old = next.due_date;
    await Instalment.updateOne({ _id: next._id }, { due_date: b.next_due_date });
    await Enrollment.updateOne({ _id: enr._id }, { $push: { plan_history: { at: new Date(), by: user.name, reason: b.next_reason, old: [{ emi_number: next.emi_number, due_date: old, amount_due: next.amount_due }] } } });
    await logActivity(user, 'Instalment', next._id, 'reschedule', { due_date: [old, b.next_due_date] }, b.next_reason);
    next = await nextOpenEmi(enr._id);
  }
  return { payment, preview, next: next ? { emi_number: next.emi_number, due_date: next.due_date, amount: next.amount_due - next.amount_paid } : null };
}

async function nextOpenEmi(enrollmentId) {
  const list = await Instalment.find({ enrollment: enrollmentId, type: 'EMI', waived: false }).sort({ due_date: 1, emi_number: 1 }).lean();
  return list.find((i) => i.amount_due - i.amount_paid > 0) || null;
}

// Payments are never deleted - a negative entry undoes them (Admin only).
async function reversePayment(user, paymentId, reason) {
  if (!(reason || '').trim()) throw bad('A reason is required to reverse a payment');
  const p = await Payment.findById(paymentId);
  if (!p) throw new HttpError(404, 'Payment not found');
  if (p.reversal_of) throw bad('A reversal entry cannot be reversed');
  if (await Payment.exists({ reversal_of: p._id })) throw bad('This payment has already been reversed');
  const rev = await Payment.create({
    enrollment: p.enrollment,
    batch: p.batch,
    allocations: p.allocations.map((a) => ({ instalment: a.instalment, amount: -a.amount })),
    amount: -p.amount,
    payment_date: todayIST(),
    mode: p.mode,
    note: `Reversal of payment dated ${p.payment_date}`,
    reversal_of: p._id,
    reversal_reason: reason,
    recorded_by: user._id,
    recorded_by_name: user.name,
    verified: true,
    verified_by: user.name,
    verified_at: new Date(),
  });
  await recalcEnrollment(p.enrollment);
  await logActivity(user, 'Payment', p._id, 'reverse', { amount: p.amount, ref: p.transaction_ref }, reason);
  return rev;
}

/* ======================= Restructure EMI plan (spec section 6, "Editing later") ======================= */
async function restructurePlan(user, enrollmentId, emis, reason) {
  if (!(reason || '').trim()) throw bad('A reason is required to restructure the plan');
  const enr = await Enrollment.findById(enrollmentId).populate({ path: 'batch', populate: 'program' });
  if (!enr) throw new HttpError(404, 'Enrollment not found');
  assertBatchAccess(user, enr.batch._id);
  const all = await Instalment.find({ enrollment: enr._id, type: 'EMI' });
  const touched = new Set((await Payment.distinct('allocations.instalment', { enrollment: enr._id })).map(String));
  const editable = all.filter((i) => !i.waived && i.amount_paid === 0 && !touched.has(String(i._id)));
  if (!editable.length) throw bad('Every EMI is already paid or part-paid, so nothing can be changed');
  const pool = E.sum(editable, (i) => i.amount_due);
  const clean = (emis || []).map((e) => ({ amount_due: Number(e.amount_due), due_date: e.due_date }));
  const errs = E.validatePlan(pool, clean);
  if (errs.length) throw bad(errs.join('; '));
  const lockedCount = all.filter((i) => !editable.includes(i) && !i.waived).length;
  if (lockedCount + clean.length > enr.batch.program.max_emis) throw bad(`${enr.batch.program.name} allows at most ${enr.batch.program.max_emis} EMIs`);

  const old = editable.map((i) => ({ emi_number: i.emi_number, amount_due: i.amount_due, due_date: i.due_date }));
  // insert the new plan first, then remove the old rows, so a failure can never leave the student with no schedule
  await Instalment.insertMany(clean.map((e) => ({ enrollment: enr._id, batch: enr.batch._id, type: 'EMI', amount_due: e.amount_due, due_date: e.due_date })));
  await Instalment.deleteMany({ _id: { $in: editable.map((i) => i._id) } });

  const live = (await Instalment.find({ enrollment: enr._id, type: 'EMI', waived: false }).lean()).sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : (a.emi_number || 99) - (b.emi_number || 99)));
  await Instalment.bulkWrite(live.map((i, k) => ({ updateOne: { filter: { _id: i._id }, update: { $set: { emi_number: k + 1 } } } })));
  await Enrollment.updateOne({ _id: enr._id }, { emi_count: live.length, $push: { plan_history: { at: new Date(), by: user.name, reason, old } } });
  await logActivity(user, 'Enrollment', enr._id, 'restructure', { old, new: clean }, reason);
  await recalcEnrollment(enr._id);
}

/* ======================= Status changes ======================= */
async function setEnrollmentStatus(user, enrollmentId, status, reason) {
  if (!['Active', 'Paused', 'Dropped', 'Refunded'].includes(status)) throw bad('Unknown status');
  const closing = ['Dropped', 'Refunded'].includes(status);
  if (closing && !(reason || '').trim()) throw bad('A reason is required');
  const enr = await Enrollment.findById(enrollmentId);
  if (!enr) throw new HttpError(404, 'Enrollment not found');
  assertBatchAccess(user, enr.batch);
  const before = enr.manual_status;
  enr.manual_status = status === 'Active' ? null : status;
  enr.status_reason = reason;
  await enr.save();
  if (closing) {
    // rule 13: unpaid instalments are cancelled (Waived) and leave the "due" totals; payments stay in revenue
    const insts = await Instalment.find({ enrollment: enr._id, waived: false });
    const ops = insts.filter((i) => i.amount_due - i.amount_paid > 0).map((i) => ({ updateOne: { filter: { _id: i._id }, update: { $set: { waived: true, waived_by_status: true, waive_reason: `${status}: ${reason}` } } } }));
    if (ops.length) await Instalment.bulkWrite(ops);
  } else {
    await Instalment.updateMany({ enrollment: enr._id, waived_by_status: true }, { $set: { waived: false, waived_by_status: false }, $unset: { waive_reason: 1 } });
  }
  await logActivity(user, 'Enrollment', enr._id, 'status', { status: [before || 'Active', status] }, reason);
}

async function waiveInstalment(user, instalmentId, reason) {
  if (!(reason || '').trim()) throw bad('A reason is required');
  const i = await Instalment.findById(instalmentId);
  if (!i) throw new HttpError(404, 'Instalment not found');
  i.waived = true;
  i.waive_reason = reason;
  await i.save();
  await logActivity(user, 'Instalment', i._id, 'waive', { amount_due: i.amount_due, amount_paid: i.amount_paid }, reason);
}

module.exports = { createEnrollment, previewPayment, recordPayment, reversePayment, restructurePlan, setEnrollmentStatus, waiveInstalment, nextOpenEmi };

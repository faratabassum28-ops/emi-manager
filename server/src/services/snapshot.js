// Turns raw documents into computed rows, KPIs and tracker lists.
// computeSnapshot / kpis / trackerRows are pure (no DB) so they are unit-testable.
const { Enrollment, Instalment, Payment, ReminderLog } = require('../models');
const E = require('../lib/emi');
const { diffDays, monthKey, nextMonthKey, addMonths } = require('../lib/dates');

const sid = (x) => String(x);
const sum = E.sum;

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

async function loadData(batchIds) {
  const q = batchIds ? { batch: { $in: batchIds } } : {};
  const [enrollments, instalments, payments] = await Promise.all([
    Enrollment.find(q)
      .populate('student')
      .populate({ path: 'batch', populate: [{ path: 'program' }, { path: 'owner', select: 'name' }] })
      .lean(),
    Instalment.find(q).lean(),
    Payment.find(q).lean(),
  ]);
  return { enrollments, instalments, payments };
}

async function loadReminderMaps(instalmentIds) {
  const logs = await ReminderLog.find({ instalment: { $in: instalmentIds } }).sort({ sent_at: 1 }).lean();
  const last = new Map();
  const promised = new Map();
  for (const l of logs) {
    last.set(sid(l.instalment), l);
    if (l.promised_date) promised.set(sid(l.instalment), l.promised_date);
  }
  return { last, promised };
}

const byDue = (a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : (a.emi_number || 0) - (b.emi_number || 0));
const TYPE_ORDER = { 'Application fee': 0, 'Commitment fee': 1, EMI: 2 };

function computeSnapshot({ enrollments, instalments, payments, rules, today }) {
  const instBy = groupBy(instalments, (i) => sid(i.enrollment));
  const payBy = groupBy(payments, (p) => sid(p.enrollment));
  return enrollments.map((e) => {
    const insts = [...(instBy.get(sid(e._id)) || [])].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || byDue(a, b));
    const states = insts.map((i) => ({ ...i, ...E.instalmentState(i, today, rules) }));
    const pays = payBy.get(sid(e._id)) || [];
    const status = E.enrollmentStatus(e, states, rules);
    const bucket = E.studentBucket(status, states);
    const emis = states.filter((s) => s.type === 'EMI' && s.status !== 'Waived');
    const open = emis.filter((s) => s.balance > 0).sort(byDue);
    return {
      id: sid(e._id),
      enrollment: e,
      student: e.student,
      batch: e.batch,
      instalments: states,
      payments: pays,
      paid: sum(pays, (p) => p.amount),
      balance: sum(states, (s) => s.balance),
      status,
      bucket,
      emi_total: emis.length,
      emis_paid: emis.filter((s) => s.balance === 0).length,
      next: open[0] || null,
      max_days_overdue: Math.max(0, ...states.map((s) => s.days_overdue)),
    };
  });
}

function studentRow(r) {
  return {
    enrollment_id: r.id,
    student_id: sid(r.student._id),
    name: r.student.full_name,
    phone: r.student.phone,
    net_payable: r.enrollment.net_payable,
    paid: r.paid,
    balance: r.balance,
    emis_paid: r.emis_paid,
    emi_total: r.emi_total,
    next_due_date: r.next ? r.next.due_date : null,
    next_amount: r.next ? r.next.balance : null,
    status: r.status,
    bucket: r.bucket,
    max_days_overdue: r.max_days_overdue,
  };
}

const FILTERS = {
  on_time: (r) => r.bucket === 'on_time',
  late: (r) => r.bucket === 'late',
  overdue: (r) => r.bucket === 'overdue',
  overdue_all: (r) => r.bucket === 'overdue' || r.bucket === 'defaulter',
  defaulter: (r) => r.bucket === 'defaulter',
  completed: (r) => r.bucket === 'completed',
  dropped: (r) => r.bucket === 'dropped',
};

function kpis(rows, today) {
  const month = monthKey(today);
  const counted = rows.filter((r) => r.bucket !== 'dropped');
  const emiStates = counted.flatMap((r) => r.instalments.filter((s) => s.type === 'EMI' && s.status !== 'Waived'));
  const typeById = new Map(rows.flatMap((r) => r.instalments).map((s) => [sid(s._id), s.type]));
  const allPayments = rows.flatMap((r) => r.payments);

  const contract_value = sum(counted, (r) => r.enrollment.net_payable);
  const collected = sum(counted, (r) => r.paid);
  const outstanding = sum(counted, (r) => r.balance);
  const overdueStates = emiStates.filter((s) => s.is_overdue);
  const lateStates = emiStates.filter((s) => s.status === 'Paid late');
  const count = (b) => counted.filter((r) => r.bucket === b).length;

  // EMI money collected this month (fees excluded) -> a fair collection rate vs EMIs due this month
  let emi_collected_this_month = 0;
  for (const p of allPayments) {
    if (monthKey(p.payment_date) !== month) continue;
    for (const a of p.allocations || []) if (typeById.get(sid(a.instalment)) === 'EMI') emi_collected_this_month += a.amount;
  }

  const ageDefs = [
    { label: '1–7 days', test: (d) => d >= 1 && d <= 7 },
    { label: '8–15 days', test: (d) => d >= 8 && d <= 15 },
    { label: '16–29 days', test: (d) => d >= 16 && d <= 29 },
    { label: '30+ days', test: (d) => d >= 30 },
  ];
  const ageing = ageDefs.map((a) => {
    const hit = overdueStates.filter((s) => a.test(s.days_overdue));
    return { label: a.label, amount: sum(hit, (s) => s.balance), count: hit.length };
  });

  // month-wise expected vs collected
  const exp = new Map();
  const col = new Map();
  for (const s of emiStates) exp.set(monthKey(s.due_date), (exp.get(monthKey(s.due_date)) || 0) + s.amount_due);
  for (const p of allPayments) {
    for (const a of p.allocations || []) {
      if (typeById.get(sid(a.instalment)) !== 'EMI') continue;
      const k = monthKey(p.payment_date);
      col.set(k, (col.get(k) || 0) + a.amount);
    }
  }
  const keys = [...new Set([...exp.keys(), ...col.keys()])].sort();
  const monthly = [];
  if (keys.length) {
    let m = keys[0];
    let guard = 0;
    while (m <= keys[keys.length - 1] && guard++ < 60) {
      monthly.push({ month: m, expected: exp.get(m) || 0, collected: col.get(m) || 0 });
      m = monthKey(addMonths(`${m}-01`, 1));
    }
  }

  const modeMap = new Map();
  for (const p of allPayments) modeMap.set(p.mode, (modeMap.get(p.mode) || 0) + p.amount);

  const due_this_month = sum(emiStates.filter((s) => monthKey(s.due_date) === month), (s) => s.amount_due);

  return {
    total_students: counted.length,
    dropped: rows.length - counted.length,
    contract_value,
    collected,
    outstanding,
    collection_pct: contract_value ? Math.round((collected / contract_value) * 1000) / 10 : 0,
    due_this_month,
    collected_this_month: sum(allPayments.filter((p) => monthKey(p.payment_date) === month), (p) => p.amount),
    emi_collected_this_month,
    overdue_amount: sum(overdueStates, (s) => s.balance),
    overdue_count: overdueStates.length,
    paying_on_time: count('on_time'),
    paying_late: count('late'),
    currently_overdue: count('overdue') + count('defaulter'),
    defaulters: count('defaulter'),
    avg_delay: lateStates.length ? Math.round((sum(lateStates, (s) => s.days_late) / lateStates.length) * 10) / 10 : 0,
    completed: count('completed'),
    status_split: [
      { key: 'on_time', label: 'On time', value: count('on_time') },
      { key: 'late', label: 'Late', value: count('late') },
      { key: 'overdue', label: 'Overdue', value: count('overdue') },
      { key: 'defaulter', label: 'Defaulter', value: count('defaulter') },
      { key: 'completed', label: 'Completed', value: count('completed') },
    ],
    ageing,
    monthly,
    by_mode: [...modeMap.entries()].map(([mode, amount]) => ({ mode, amount })).sort((a, b) => b.amount - a.amount),
  };
}

function trackerRows(rows, { filter = 'queue', today, last = new Map(), promised = new Map() }) {
  const thisM = monthKey(today);
  const nextM = nextMonthKey(today);
  const hideIfPromised = ['queue', 'overdue', 'today'].includes(filter);
  const out = [];
  for (const r of rows) {
    if (r.bucket === 'dropped') continue;
    for (const s of r.instalments) {
      if (s.type !== 'EMI' || s.status === 'Waived' || s.balance <= 0) continue;
      const diff = diffDays(s.due_date, today);
      let match;
      switch (filter) {
        case 'overdue': match = s.days_overdue > 0; break;
        case 'today': match = diff === 0; break;
        case 'next7': match = diff >= 1 && diff <= 7; break;
        case 'this_month': match = monthKey(s.due_date) === thisM; break;
        case 'next_month': match = monthKey(s.due_date) === nextM; break;
        case 'partial': match = s.amount_paid > 0; break;
        case 'all': match = true; break;
        default: match = s.days_overdue > 0 || diff === 0;
      }
      if (!match) continue;
      const promised_date = promised.get(sid(s._id)) || null;
      if (hideIfPromised && promised_date && promised_date > today) continue; // back in the queue after that date
      const lr = last.get(sid(s._id));
      out.push({
        instalment_id: sid(s._id),
        enrollment_id: r.id,
        batch_id: sid(r.batch._id),
        batch_name: r.batch.batch_name,
        program: r.batch.program ? r.batch.program.name : '',
        student_name: r.student.full_name,
        phone: r.student.phone,
        emi_number: s.emi_number,
        emi_total: r.emi_total,
        amount_due: s.amount_due,
        amount_paid: s.amount_paid,
        balance: s.balance,
        due_date: s.due_date,
        days_overdue: s.days_overdue,
        status: s.status,
        template_key: E.pickTemplateKey(s),
        last_reminder: lr ? { at: lr.sent_at, outcome: lr.outcome, channel: lr.channel, by: lr.sent_by_name } : null,
        promised_date,
        assigned: r.batch.owner ? r.batch.owner.name : '',
      });
    }
  }
  out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.student_name.localeCompare(b.student_name)));
  return out;
}

// Rebuild amount_paid / paid_on on the instalments of one enrollment from its payment ledger.
async function recalcEnrollment(enrollmentId) {
  const [insts, pays] = await Promise.all([
    Instalment.find({ enrollment: enrollmentId }).lean(),
    Payment.find({ enrollment: enrollmentId }).lean(),
  ]);
  const map = E.recalcFromPayments(insts.map((i) => ({ id: i._id, amount_due: i.amount_due })), pays);
  const ops = insts.map((i) => {
    const s = map.get(sid(i._id));
    return { updateOne: { filter: { _id: i._id }, update: { $set: { amount_paid: s.amount_paid, paid_on: s.paid_on } } } };
  });
  if (ops.length) await Instalment.bulkWrite(ops);
}

module.exports = { loadData, loadReminderMaps, computeSnapshot, studentRow, kpis, trackerRows, recalcEnrollment, FILTERS };

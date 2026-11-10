const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/snapshot');
const importer = require('../src/routes/importer');

const today = '2026-11-09';
const rules = { grace_days: 2, defaulter_days: 30 };
const batch = { _id: 'b1', batch_name: 'Batch 7', program: { name: 'SUPER' }, owner: { name: 'Ops Person' } };
const stu = (id, name) => ({ _id: id, full_name: name, phone: `+9198000000${id.slice(-1)}` });
const inst = (id, enr, o) => ({ _id: id, enrollment: enr, batch: 'b1', type: 'EMI', amount_due: 1000, amount_paid: 0, paid_on: null, waived: false, ...o });
const pay = (id, enr, instId, amount, date, mode = 'UPI') => ({ _id: id, enrollment: enr, batch: 'b1', allocations: [{ instalment: instId, amount }], amount, payment_date: date, mode });

// A: fee paid, EMI1 paid on time, EMI2 overdue 5 days, EMI3 upcoming
// B: dropped, its unpaid EMI is waived
// C: completed (all paid)
// D: defaulter (EMI 40 days overdue)
const data = {
  enrollments: [
    { _id: 'eA', student: stu('sA', 'Asha'), batch, net_payable: 3500, manual_status: null },
    { _id: 'eB', student: stu('sB', 'Bala'), batch, net_payable: 2000, manual_status: 'Dropped' },
    { _id: 'eC', student: stu('sC', 'Chitra'), batch, net_payable: 1000, manual_status: null },
    { _id: 'eD', student: stu('sD', 'Dev'), batch, net_payable: 1000, manual_status: null },
  ],
  instalments: [
    inst('a0', 'eA', { type: 'Application fee', amount_due: 500, amount_paid: 500, paid_on: '2026-09-01', due_date: '2026-09-01' }),
    inst('a1', 'eA', { emi_number: 1, amount_paid: 1000, paid_on: '2026-10-05', due_date: '2026-10-05' }),
    inst('a2', 'eA', { emi_number: 2, due_date: '2026-11-04' }),
    inst('a3', 'eA', { emi_number: 3, due_date: '2026-12-04' }),
    inst('b1', 'eB', { emi_number: 1, amount_paid: 1000, paid_on: '2026-10-01', due_date: '2026-10-01' }),
    inst('b2', 'eB', { emi_number: 2, due_date: '2026-11-01', waived: true }),
    inst('c1', 'eC', { emi_number: 1, amount_paid: 1000, paid_on: '2026-11-08', due_date: '2026-11-01' }), // 7 days late
    inst('d1', 'eD', { emi_number: 1, due_date: '2026-09-30' }),
  ],
  payments: [
    pay('p0', 'eA', 'a0', 500, '2026-09-01'),
    pay('p1', 'eA', 'a1', 1000, '2026-10-05'),
    pay('p2', 'eB', 'b1', 1000, '2026-10-01'),
    pay('p3', 'eC', 'c1', 1000, '2026-11-08', 'Bank transfer'),
  ],
  rules,
  today,
};

const rows = S.computeSnapshot(data);
const byName = (n) => rows.find((r) => r.student.full_name === n);

test('buckets are mutually exclusive and computed', () => {
  assert.equal(byName('Asha').bucket, 'overdue');
  assert.equal(byName('Bala').bucket, 'dropped');
  assert.equal(byName('Chitra').bucket, 'completed');
  assert.equal(byName('Dev').bucket, 'defaulter');
  assert.equal(byName('Asha').emis_paid, 1);
  assert.equal(byName('Asha').emi_total, 3);
  assert.equal(byName('Asha').next.emi_number, 2);
  assert.equal(byName('Asha').balance, 2000);
});

test('KPIs: dropped excluded from contract, payments stay in revenue', () => {
  const k = S.kpis(rows, today);
  assert.equal(k.total_students, 3);
  assert.equal(k.dropped, 1);
  assert.equal(k.contract_value, 3500 + 1000 + 1000);
  assert.equal(k.overdue_count, 2); // Asha EMI2 + Dev EMI1
  assert.equal(k.overdue_amount, 2000);
  assert.equal(k.defaulters, 1);
  assert.equal(k.currently_overdue, 2);
  assert.equal(k.completed, 1);
  assert.equal(k.collected_this_month, 1000); // only Chitra's Nov payment
  assert.equal(k.avg_delay, 7);
});

test('ageing buckets split overdue by days', () => {
  const k = S.kpis(rows, today);
  const age = Object.fromEntries(k.ageing.map((a) => [a.label, a.amount]));
  assert.equal(age['1–7 days'], 1000); // Asha: 5 days
  assert.equal(age['30+ days'], 1000); // Dev: 40 days
});

test('month-wise expected vs collected covers every month in range', () => {
  const k = S.kpis(rows, today);
  const months = k.monthly.map((m) => m.month);
  assert.deepEqual(months, ['2026-09', '2026-10', '2026-11', '2026-12']);
  const oct = k.monthly.find((m) => m.month === '2026-10');
  assert.equal(oct.expected, 1000); // Asha EMI1 (Bala is dropped, so not "expected")
  assert.equal(oct.collected, 2000); // but Bala's payment stays in revenue (rule 13)
});

test('tracker: default queue = overdue + due today, oldest first', () => {
  const list = S.trackerRows(rows, { today });
  assert.deepEqual(list.map((r) => r.student_name), ['Dev', 'Asha']);
  assert.equal(list[0].days_overdue, 40);
  assert.equal(list[1].assigned, 'Ops Person');
});

test('tracker: a promised date hides the row until that date passes', () => {
  const promised = new Map([['a2', '2026-11-12']]);
  assert.deepEqual(S.trackerRows(rows, { today, promised }).map((r) => r.student_name), ['Dev']);
  // "All" view still shows it
  assert.ok(S.trackerRows(rows, { today, promised, filter: 'all' }).some((r) => r.student_name === 'Asha'));
  // once the promised date has passed it returns to the queue
  assert.ok(S.trackerRows(rows, { today: '2026-11-13', promised }).some((r) => r.student_name === 'Asha'));
});

test('tracker filters: this month / next month / partial', () => {
  assert.deepEqual(S.trackerRows(rows, { today, filter: 'this_month' }).map((r) => r.student_name), ['Asha']);
  assert.deepEqual(S.trackerRows(rows, { today, filter: 'next_month' }).map((r) => r.student_name), ['Asha']);
  assert.equal(S.trackerRows(rows, { today, filter: 'partial' }).length, 0);
  assert.equal(S.trackerRows(rows, { today, filter: 'all' }).length, 3); // Asha EMI2+3, Dev EMI1 (Bala waived/dropped)
});

test('students tab filters match dashboard buckets', () => {
  assert.equal(rows.filter(S.FILTERS.overdue_all).length, 2);
  assert.equal(rows.filter(S.FILTERS.completed).length, 1);
  assert.equal(rows.filter(S.FILTERS.dropped).length, 1);
});

/* ---------------- CSV importer row parser ---------------- */
const program = { _id: 'p1', name: 'SUPER', code: 'SUPER', default_fee: 250000 };
const ctx = { programs: [program], batches: [{ _id: 'b1', program: 'p1', batch_name: 'Batch 7 – Oct 2026', code: 'SUPER-B07' }], types: [{ _id: 't1', name: 'Tarot L1' }] };
const goodRow = {
  program: 'SUPER', batch: 'Batch 7 - Oct 2026', full_name: 'Sample Student', phone: '9800000000', email: 's@x.com', total_fee: '250000',
  adjustment_1_name: 'Tarot L1', adjustment_1_amount: '10000', adjustment_2_name: 'Reiki L1+L2', adjustment_2_amount: '6999',
  application_fee: '10000', commitment_fee: '40000', emi_count: '2', emi1_amount: '91500', emi1_due: '2026-11-05', emi1_paid: '91500', emi2_amount: '91501', emi2_due: '2026-12-05', emi2_paid: '0',
};

test('importer accepts a valid sheet row (dash-insensitive batch match, phone normalised)', () => {
  const r = importer.parseRow(goodRow, ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.display.net_payable, 233001);
  assert.equal(r.display.balance_due, 183001);
  assert.equal(r.payload.student.phone, '+919800000000');
  assert.equal(r.payload.adjustments[0].adjustment, 't1');
});

test('importer flags EMI sum mismatch, bad dates, overpaid EMIs, unknown batch', () => {
  assert.match(importer.parseRow({ ...goodRow, emi2_amount: '91000' }, ctx).errors.join(' '), /difference/);
  assert.match(importer.parseRow({ ...goodRow, emi1_due: '05/11/2026' }, ctx).errors.join(' '), /due date/);
  assert.match(importer.parseRow({ ...goodRow, emi1_paid: '99999' }, ctx).errors.join(' '), /more than/);
  assert.match(importer.parseRow({ ...goodRow, batch: 'Batch 99' }, ctx).errors.join(' '), /not found/);
  assert.match(importer.parseRow({ ...goodRow, phone: '' }, ctx).errors.join(' '), /Phone/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/lib/emi');
const D = require('../src/lib/dates');

test('spec worked example: SUPER 2,50,000 with two credits', () => {
  const f = E.computeFees({
    total_fee: 250000,
    adjustments: [{ amount: 10000 }, { amount: 6999 }],
    discount: 0, application_fee: 10000, commitment_fee: 40000,
  });
  assert.equal(f.net_payable, 233001);
  assert.equal(f.balance_due, 183001);
  const emis = E.autoSplit(f.balance_due, 6, '2026-11-05');
  assert.deepEqual(emis.map((e) => e.amount_due), [30500, 30500, 30500, 30500, 30500, 30501]);
  assert.deepEqual(E.validatePlan(f.balance_due, emis), []);
});

test('month stepping does not drift (31 Jan -> 28 Feb -> 31 Mar)', () => {
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(D.addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(D.addMonths('2026-11-30', 3), '2027-02-28');
});

test('validatePlan blocks wrong sum and descending dates', () => {
  const bad = [{ amount_due: 100, due_date: '2026-12-01' }, { amount_due: 100, due_date: '2026-11-01' }];
  const errs = E.validatePlan(300, bad);
  assert.ok(errs.some((e) => /before/.test(e)));
  assert.ok(errs.some((e) => /difference 100/.test(e)));
});

const rules = { grace_days: 2, defaulter_days: 30 };
const inst = (o) => ({ type: 'EMI', amount_due: 1000, amount_paid: 0, due_date: '2026-11-10', paid_on: null, ...o });

test('status: upcoming / due soon / due today / overdue', () => {
  assert.equal(E.instalmentState(inst({ due_date: '2026-11-20' }), '2026-11-09', rules).status, 'Upcoming');
  assert.equal(E.instalmentState(inst({ due_date: '2026-11-16' }), '2026-11-09', rules).status, 'Due soon');
  assert.equal(E.instalmentState(inst({ due_date: '2026-11-17' }), '2026-11-09', rules).status, 'Upcoming');
  assert.equal(E.instalmentState(inst({ due_date: '2026-11-09' }), '2026-11-09', rules).status, 'Due today');
  const o = E.instalmentState(inst({ due_date: '2026-11-04' }), '2026-11-09', rules);
  assert.equal(o.status, 'Overdue');
  assert.equal(o.days_overdue, 5);
});

test('status: partial payment past due is flagged overdue', () => {
  const s = E.instalmentState(inst({ amount_paid: 400, due_date: '2026-11-01' }), '2026-11-09', rules);
  assert.equal(s.status, 'Partially paid');
  assert.equal(s.is_overdue, true);
  assert.equal(s.balance, 600);
});

test('status: grace period decides on-time vs late', () => {
  const within = E.instalmentState(inst({ amount_paid: 1000, paid_on: '2026-11-12' }), '2026-11-20', rules);
  assert.equal(within.status, 'Paid on time');
  const late = E.instalmentState(inst({ amount_paid: 1000, paid_on: '2026-11-15' }), '2026-11-20', rules);
  assert.equal(late.status, 'Paid late');
  assert.equal(late.days_late, 5);
});

test('waived instalments are excluded and enrollment completes', () => {
  const s = [E.instalmentState(inst({ waived: true }), '2026-11-09', rules), E.instalmentState(inst({ amount_paid: 1000, paid_on: '2026-11-10' }), '2026-11-11', rules)];
  assert.equal(E.enrollmentStatus({}, s, rules), 'Completed');
});

test('defaulter at 30+ days overdue; manual statuses win', () => {
  const s = [E.instalmentState(inst({ due_date: '2026-10-01' }), '2026-11-09', rules)];
  assert.equal(E.enrollmentStatus({}, s, rules), 'Defaulter');
  assert.equal(E.studentBucket('Defaulter', s), 'defaulter');
  assert.equal(E.enrollmentStatus({ manual_status: 'Dropped' }, s, rules), 'Dropped');
});

test('allocation: oldest first, excess rolls forward, chosen instalment first', () => {
  const list = [
    { id: 'a', due_date: '2026-10-05', amount_due: 1000, amount_paid: 0, emi_number: 1 },
    { id: 'b', due_date: '2026-11-05', amount_due: 1000, amount_paid: 0, emi_number: 2 },
    { id: 'c', due_date: '2026-12-05', amount_due: 1000, amount_paid: 0, emi_number: 3 },
  ];
  let r = E.allocatePayment(1500, list);
  assert.deepEqual(r.allocations, [{ instalment: 'a', amount: 1000 }, { instalment: 'b', amount: 500 }]);
  assert.equal(r.unapplied, 0);
  r = E.allocatePayment(1500, list, ['c']);
  assert.deepEqual(r.allocations, [{ instalment: 'c', amount: 1000 }, { instalment: 'a', amount: 500 }]);
  r = E.allocatePayment(5000, list);
  assert.equal(r.unapplied, 2000);
});

test('ledger rebuild handles partial, full and reversal', () => {
  const list = [{ id: 'a', amount_due: 1000 }];
  const pays = [
    { payment_date: '2026-11-01', allocations: [{ instalment: 'a', amount: 400 }] },
    { payment_date: '2026-11-08', allocations: [{ instalment: 'a', amount: 600 }] },
  ];
  let st = E.recalcFromPayments(list, pays).get('a');
  assert.equal(st.amount_paid, 1000);
  assert.equal(st.paid_on, '2026-11-08');
  pays.push({ payment_date: '2026-11-09', allocations: [{ instalment: 'a', amount: -600 }] });
  st = E.recalcFromPayments(list, pays).get('a');
  assert.equal(st.amount_paid, 400);
  assert.equal(st.paid_on, null);
});

test('phone normalisation and templates', () => {
  assert.equal(E.normalizePhone('98000 00000'), '+919800000000');
  assert.equal(E.normalizePhone('+1 (415) 555-0100'), '+14155550100');
  assert.equal(E.isValidPhone('+919800000000'), true);
  assert.equal(E.renderTemplate('Hi {name}, {amount}', { name: 'A', amount: '₹5' }), 'Hi A, ₹5');
  assert.equal(E.fmtDate('2026-11-05'), '05 Nov 2026');
});

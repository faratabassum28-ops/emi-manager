// Record-payment / enrollment workflows (services/money.js) against an in-memory fake of the models.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildModels } = require('./fakeDb');

const models = buildModels();
const modelsPath = require.resolve('../src/models');
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: models };
const settingsPath = require.resolve('../src/services/settings');
require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: { getSettings: async () => ({ reminder: { days_before: 3, grace_days: 2, defaulter_days: 30 }, payment_modes: ['UPI', 'Cash'], discount_limit: 10000, templates: {} }) } };

const money = require('../src/services/money');
const { todayIST, addDays } = require('../src/lib/dates');

// restructurePlan populates enrollment -> batch -> program; resolve that chain in the fake (without mutating stored rows)
const plainFindById = models.Enrollment.findById;
models.Enrollment.findById = (id) => {
  const q = plainFindById(id);
  let nested = false;
  const o = {
    populate(arg) { if (arg && arg.path === 'batch') nested = true; return o; },
    lean() { return o; },
    then(res, rej) {
      return q.then((e) => {
        if (!e || !nested) return e;
        const b = models.Batch.rows.find((x) => String(x._id) === String(e.batch));
        const prog = b && models.Program.rows.find((x) => String(x._id) === String(b.program._id || b.program));
        return Object.assign(Object.create(Object.getPrototypeOf(e)), e, { batch: { ...b, program: prog }, save: e.save });
      }).then(res, rej);
    },
  };
  return o;
};

const admin = { _id: 'u1', name: 'Asha', role: 'Admin' };
const crm = { _id: 'u2', name: 'Ravi', role: 'CRM', batches: [] };
const today = todayIST();

async function seedEnrollment() {
  const program = await models.Program.create({ name: 'SUPER', max_emis: 12, default_fee: 100000 });
  const batch = await models.Batch.create({ code: 'SUPER-B01', program, batch_name: 'B1', status: 'Running' });
  models.Batch.findById = (id) => { const row = models.Batch.rows.find((b) => String(b._id) === String(id)); return { populate: async () => row }; };
  const enr = await money.createEnrollment(admin, {
    batch: batch._id,
    student: { full_name: 'Meera Nair', phone: `+9198${String(Date.now()).slice(-8)}`, email: 'meera@example.com' },
    total_fee: 100000,
    fee_change_reason: 'special price',
    application: { amount: 10000, date: addDays(today, -40), mode: 'UPI', screenshot: 'a.png' },
    emis: [
      { amount_due: 30000, due_date: addDays(today, -10) },
      { amount_due: 30000, due_date: addDays(today, 20) },
      { amount_due: 30000, due_date: addDays(today, 50) },
    ],
  });
  return enr;
}

const pay = (enr, extra = {}) => ({ enrollment: enr._id, amount: 30000, payment_date: today, mode: 'UPI', screenshot: 'proof.png', ...extra });
const inst = (enr) => models.Instalment.rows.filter((i) => String(i.enrollment) === String(enr._id) && i.type === 'EMI').sort((a, b) => a.emi_number - b.emi_number);

test('recordPayment saves, allocates to the oldest EMI and logs (regression: used to throw ReferenceError after saving)', async () => {
  const enr = await seedEnrollment();
  const out = await money.recordPayment(crm, pay(enr));
  assert.ok(out.payment._id);
  assert.equal(out.preview[0].label, 'EMI 1');
  assert.equal(out.preview[0].status_after, 'Paid late');
  assert.equal(inst(enr)[0].amount_paid, 30000);
  assert.equal(out.next.emi_number, 2);
  const log = models.ActivityLog.rows.find((l) => l.entity === 'Payment' && l.action === 'create');
  assert.ok(log, 'activity logged');
  assert.deepEqual(log.changes.allocations, ['EMI 1: 30000']);
});

test('excess over the chosen EMI rolls to the next one, oldest first', async () => {
  const enr = await seedEnrollment();
  const e2 = inst(enr)[1];
  const out = await money.recordPayment(crm, pay(enr, { amount: 40000, instalments: [String(e2._id)] }));
  assert.equal(out.preview.length, 2);
  assert.equal(inst(enr)[1].amount_paid, 30000);
  assert.equal(inst(enr)[0].amount_paid, 10000); // the leftover went to the oldest open EMI
});

test('validation: screenshot, mode, future date, amount, over-payment', async () => {
  const enr = await seedEnrollment();
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { screenshot: '' })), /screenshot/i);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { mode: 'Bitcoin' })), /payment mode/i);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { payment_date: addDays(today, 1) })), /future/i);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { amount: 0 })), /positive whole number/i);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { amount: 10.5 })), /whole number/i);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { amount: 999999 })), /more than the remaining balance/i);
  assert.equal(models.Payment.rows.filter((p) => String(p.enrollment) === String(enr._id) && p.amount !== 10000).length, 0, 'nothing saved by failed attempts');
});

test('a bad "next due date" is rejected BEFORE the payment is saved', async () => {
  const enr = await seedEnrollment();
  const before = models.Payment.rows.length;
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { next_due_date: '2026-13-45', next_reason: 'x' })), /invalid/i);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { next_due_date: addDays(today, 30), next_reason: '  ' })), /reason/i);
  assert.equal(models.Payment.rows.length, before);
  assert.equal(inst(enr)[0].amount_paid, 0);
});

test('agreed new date for the next EMI is applied and logged', async () => {
  const enr = await seedEnrollment();
  const newDate = addDays(today, 35);
  const out = await money.recordPayment(crm, pay(enr, { next_due_date: newDate, next_reason: 'Salary delayed' }));
  assert.equal(out.next.due_date, newDate);
  assert.ok(models.ActivityLog.rows.find((l) => l.action === 'reschedule'));
});

test('paid in full -> "all paid" and no next EMI; further payment is refused', async () => {
  const enr = await seedEnrollment();
  const all = inst(enr);
  const out = await money.recordPayment(crm, pay(enr, { amount: 90000, instalments: [String(all[0]._id)] }));
  assert.equal(out.next, null);
  await assert.rejects(() => money.recordPayment(crm, pay(enr, { amount: 1 })), /more than the remaining balance/i);
});

test('reversal restores the instalment and cannot be repeated', async () => {
  const enr = await seedEnrollment();
  const { payment } = await money.recordPayment(crm, pay(enr));
  await assert.rejects(() => money.reversePayment(admin, payment._id, ''), /reason/i);
  await money.reversePayment(admin, payment._id, 'Wrong UTR');
  assert.equal(inst(enr)[0].amount_paid, 0);
  assert.equal(inst(enr)[0].paid_on, null);
  await assert.rejects(() => money.reversePayment(admin, payment._id, 'again'), /already been reversed/i);
});

test('waive: needs a reason, unpaid balance only, never twice', async () => {
  const enr = await seedEnrollment();
  const e3 = inst(enr)[2];
  await assert.rejects(() => money.waiveInstalment(admin, e3._id, ''), /reason/i);
  await money.waiveInstalment(admin, e3._id, 'Goodwill');
  assert.equal(inst(enr)[2].waived, true);
  await assert.rejects(() => money.waiveInstalment(admin, e3._id, 'again'), /already waived/i);
  const { payment } = await money.recordPayment(crm, pay(enr));
  assert.ok(payment);
  await assert.rejects(() => money.waiveInstalment(admin, inst(enr)[0]._id, 'too late'), /fully paid/i);
});

test('dropped enrollment waives unpaid EMIs, blocks payments, and re-opening restores them', async () => {
  const enr = await seedEnrollment();
  await money.recordPayment(crm, pay(enr));
  await money.setEnrollmentStatus(admin, enr._id, 'Dropped', 'Left the course');
  assert.deepEqual(inst(enr).map((i) => i.waived), [false, true, true]);
  await assert.rejects(() => money.recordPayment(crm, pay(enr)), /payments cannot be recorded/i);
  await money.setEnrollmentStatus(admin, enr._id, 'Active', '');
  assert.deepEqual(inst(enr).map((i) => i.waived), [false, false, false]);
});

test('restructure: locked EMIs stay, new plan must add up', async () => {
  const enr = await seedEnrollment();
  await money.recordPayment(crm, pay(enr)); // EMI 1 paid
  await assert.rejects(() => money.restructurePlan(admin, enr._id, [{ amount_due: 1, due_date: addDays(today, 40) }], 'x'), /add up/i);
  await money.restructurePlan(admin, enr._id, [{ amount_due: 20000, due_date: addDays(today, 40) }, { amount_due: 40000, due_date: addDays(today, 70) }], 'Student asked');
  const list = inst(enr);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((i) => i.emi_number), [1, 2, 3]);
  assert.equal(list[0].amount_paid, 30000);
});

test('enrollment: duplicate student in the same batch is blocked; sums must match', async () => {
  const enr = await seedEnrollment();
  const stu = models.Student.rows.find((s) => String(s._id) === String(enr.student));
  await assert.rejects(() => money.createEnrollment(admin, { batch: enr.batch, student_id: stu._id, total_fee: 100000, fee_change_reason: 'x', emis: [{ amount_due: 100000, due_date: addDays(today, 5) }] }), /already enrolled/i);
  await assert.rejects(() => money.createEnrollment(admin, { batch: enr.batch, student: { full_name: 'New', phone: '+919811112222', email: 'n@x.com' }, total_fee: 100000, fee_change_reason: 'x', emis: [{ amount_due: 5, due_date: addDays(today, 5) }] }), /add up/i);
});

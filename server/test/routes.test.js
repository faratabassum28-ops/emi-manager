// Exercises the history / activity / pulse / insights routes over real HTTP with the Mongoose models replaced by an in-memory fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const id = (n) => String(n).padStart(24, '0');
const U = id(1); const ENR = id(10); const STU = id(11); const BATCH = id(12); const PAY = id(20); const INST = id(30);

const registry = {}; // path -> rows, so populate('student') can resolve ids like Mongoose does
function fake(rows) {
  const match = (d, f = {}) => Object.entries(f).every(([k, v]) => {
    const val = d[k];
    if (v && typeof v === 'object' && !(v instanceof RegExp) && v.$in) return v.$in.map(String).includes(String(val));
    if (v && typeof v === 'object' && !(v instanceof RegExp) && ('$gte' in v || '$lte' in v)) return (v.$gte === undefined || val >= v.$gte) && (v.$lte === undefined || val <= v.$lte);
    if (v && typeof v === 'object' && !(v instanceof RegExp) && ('$gt' in v)) return val > v.$gt;
    if (v && typeof v === 'object' && !(v instanceof RegExp) && ('$ne' in v)) return String(val) !== String(v.$ne);
    if (v && typeof v === 'object' && !(v instanceof RegExp) && ('$exists' in v)) return v.$exists ? val !== undefined : val === undefined;
    if (v instanceof RegExp) return v.test(val);
    return String(val) === String(v);
  });
  const chain = (list, single) => {
    const pops = [];
    const o = {
      sort(spec) { const [k, dir] = Object.entries(spec || {})[0] || []; if (k) list = [...list].sort((a, b) => (a[k] < b[k] ? 1 : -1) * (dir === 1 ? -1 : 1)); return o; },
      limit(n) { list = list.slice(0, n); return o; }, populate(pathName) { pops.push(pathName); return o; }, lean() { return o; },
      then(res, rej) {
        const done = list.map((d) => pops.reduce((acc, pth) => ({ ...acc, [pth]: (registry[pth] || []).find((r) => String(r._id) === String(d[pth])) || d[pth] }), d));
        return Promise.resolve(single ? done[0] || null : done).then(res, rej);
      },
    };
    return o;
  };
  return {
    find: (f) => chain(rows.filter((d) => match(d, f))),
    findById: (x) => chain(rows.filter((d) => String(d._id) === String(x)), true),
    countDocuments: async (f) => rows.filter((d) => match(d, f)).length,
    distinct: async (k) => [...new Set(rows.map((d) => d[k]))],
  };
}

const t = (s) => new Date(s);
const data = {
  User: [{ _id: U, name: 'Nitin', role: 'Admin', active: true, can_verify: true }],
  Enrollment: [{ _id: ENR, student: STU, batch: BATCH, enrollment_date: '2026-11-03', net_payable: 200000 }],
  Student: [{ _id: STU, full_name: 'Meera Nair' }],
  Payment: [
    { _id: PAY, enrollment: ENR, batch: BATCH, amount: 30500, payment_date: '2026-11-05', mode: 'UPI', verified: false },
    { _id: id(21), enrollment: ENR, batch: BATCH, amount: 10000, payment_date: '2026-10-28', mode: 'Bank transfer', verified: true },
    { _id: id(22), enrollment: ENR, batch: BATCH, amount: -500, payment_date: '2026-11-06', mode: 'UPI', reversal_of: PAY, verified: false },
  ],
  Instalment: [{ _id: INST, enrollment: ENR, batch: BATCH, type: 'EMI', emi_number: 1, amount_due: 30500, due_date: '2026-11-01' }],
  ActivityLog: [
    { _id: id(40), entity: 'Payment', entity_id: PAY, action: 'create', user_name: 'Asha', createdAt: t('2026-11-05T04:00:00Z'), changes: { amount: 30500, mode: 'UPI', ref: 'UTR1', allocations: ['EMI 1: 30500'] } },
    { _id: id(41), entity: 'Payment', entity_id: PAY, action: 'reverse', user_name: 'Nitin', createdAt: t('2026-11-06T04:00:00Z'), changes: { amount: 500, ref: 'UTR1' }, reason: 'Entered twice' },
    { _id: id(42), entity: 'Enrollment', entity_id: ENR, action: 'create', user_name: 'Asha', createdAt: t('2026-11-03T04:00:00Z'), changes: { batch: 'SUPER-B07', net_payable: 200000, balance_due: 150000, emis: 5 } },
    { _id: id(43), entity: 'Settings', entity_id: id(99), action: 'update', user_name: 'Nitin', createdAt: t('2026-09-01T04:00:00Z'), changes: ['reminder'] },
  ],
  ReminderLog: [{ _id: id(50), instalment: INST, enrollment: ENR, channel: 'Call', outcome: 'Will pay on date', promised_date: '2026-11-15', sent_by_name: 'Ravi', sent_at: t('2026-11-07T05:30:00Z'), notes: 'Salary on 14th' }],
  Batch: [{ _id: BATCH, code: 'SUPER-B07', batch_name: 'Batch 7', status: 'Running' }],
};
const models = {};
for (const k of Object.keys(data)) models[k] = fake(data[k]);
registry.student = data.Student; registry.batch = data.Batch;
models.Program = fake([]); models.AdjustmentType = fake([]); models.Setting = fake([]);

const modelsPath = require.resolve('../src/models');
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: models };
// settings service reads the Setting model; give it fixed rules instead
const settingsPath = require.resolve('../src/services/settings');
require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: { getSettings: async () => ({ reminder: { days_before: 3, grace_days: 2, defaulter_days: 30 }, payment_modes: ['UPI'], templates: {} }) } };

process.env.NODE_ENV = 'test';
const { createApp } = require('../src/index');
const { signToken } = require('../src/middleware');

let server; let base; let token;
test.before(async () => {
  token = signToken({ _id: U });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());
const get = async (p) => {
  const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
  const json = r.headers.get('content-type').includes('json');
  const bytes = json ? null : Buffer.from(await r.arrayBuffer()); // fetch().text() would hide the BOM, so keep the raw bytes
  return { status: r.status, body: json ? await r.json() : bytes.toString('utf8'), bom: bytes ? bytes.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) : false, headers: r.headers };
};

test('enrollment history merges payments, reversal, enrolment and call, newest first', async () => {
  const r = await get(`/enrollments/${ENR}/history`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events.map((e) => e.label), [
    'Call: Will pay on date', 'Payment of ₹500 reversed', 'Payment of ₹30,500 recorded', 'Enrolled in SUPER-B07',
  ]);
  const rev = r.body.events.find((e) => e.action === 'reverse');
  assert.equal(rev.reason, 'Entered twice'); assert.equal(rev.tone, 'bad');
  assert.ok(!r.body.events.some((e) => e.entity === 'Settings'), 'unrelated settings change must not leak into a student trail');
});

test('activity feed: resolves student, filters, searches, pages', async () => {
  const all = await get('/activity');
  assert.equal(all.body.total, 5);
  const pay = all.body.items.find((e) => e.action === 'create' && e.entity === 'Payment');
  assert.equal(pay.student, 'Meera Nair'); assert.equal(pay.batch, 'SUPER-B07'); assert.equal(pay.enrollment_id, ENR);
  assert.deepEqual(all.body.users.sort(), ['Asha', 'Nitin']);

  assert.equal((await get('/activity?entity=Payment')).body.total, 2);
  assert.equal((await get('/activity?entity=Reminder')).body.total, 1);
  assert.equal((await get('/activity?user=Asha')).body.total, 2);
  assert.equal((await get('/activity?q=entered+twice')).body.total, 1);
  assert.equal((await get('/activity?q=meera')).body.total, 4, 'search by student name');
  assert.equal((await get('/activity?from=2026-11-06&to=2026-11-07')).body.total, 2);
  const p2 = await get('/activity?limit=2&page=2');
  assert.equal(p2.body.items.length, 2); assert.equal(p2.body.total, 5);
});

test('activity CSV: BOM, header, quoted commas, IST time', async () => {
  const r = await get('/activity/export?entity=Payment');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /activity-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(r.bom, 'UTF-8 BOM so Excel shows ₹ correctly');
  assert.ok(r.body.replace(/^\uFEFF/, '').startsWith('When (IST),Who,Student,Batch,Type,What happened,Details,Reason'));
  assert.ok(r.body.includes('2026-11-05 09:30,Asha,Meera Nair,SUPER-B07,Payment,"Payment of ₹30,500 recorded",'), 'IST time, and a comma inside a label is quoted');
  assert.match(r.body, /Entered twice/);
});

test('insights: window totals, previous window, series', async () => {
  const r = await get('/insights?window=custom&from=2026-11-01&to=2026-11-10');
  assert.equal(r.status, 200);
  assert.equal(r.body.current.collected, 30000);            // 30,500 paid minus 500 reversed
  assert.equal(r.body.current.payments, 1);
  assert.equal(r.body.current.reversed, 500);
  assert.equal(r.body.current.new_enrollments, 1);
  assert.equal(r.body.current.followups, 1); assert.equal(r.body.current.promises, 1);
  assert.equal(r.body.prior.collected, 10000);              // 22-31 Oct window
  assert.equal(r.body.series.length, 10);
  assert.equal(r.body.series.find((s) => s.key === '2026-11-05').collected, 30500);
  assert.equal((await get('/insights?window=custom&from=2026-11-10&to=2026-11-01')).status, 400);
  assert.equal((await get('/insights?window=all_time')).body.prior, null);
});

test('pulse: unverified count excludes reversals', async () => {
  const r = await get('/pulse');
  assert.equal(r.status, 200);
  assert.equal(r.body.unverified, 1);
  assert.equal(typeof r.body.overdue, 'number');
});

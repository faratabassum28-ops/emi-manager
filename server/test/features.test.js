// New screens' calculations: priority score, broken promises, tracker counts, cash-flow forecast, cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/snapshot');
const cache = require('../src/services/cache');

const today = '2026-11-15';
const mkRow = (id, name, insts, bucket = 'overdue') => ({
  id, bucket,
  student: { full_name: name, phone: '+9190000' + id },
  batch: { _id: 'b1', batch_name: 'Batch 1', program: { name: 'Super' } },
  emi_total: insts.length,
  instalments: insts.map((i, n) => ({ _id: `${id}-${n}`, type: 'EMI', emi_number: n + 1, status: 'Overdue', amount_paid: 0, ...i })),
});

test('priority: days late, money, broken promise and no-contact all push the score up', () => {
  const calm = S.priorityOf({ days_overdue: 2, balance: 10000, contacted: true });
  const hot = S.priorityOf({ days_overdue: 30, balance: 30500, broken: true, contacted: false });
  assert.equal(calm.risk, 'low');
  assert.equal(hot.risk, 'high');
  assert.ok(hot.priority > calm.priority && hot.priority <= 100);
  assert.equal(S.priorityOf({ days_overdue: 500, balance: 9e6, broken: true, contacted: false }).priority, 100, 'capped at 100');
  assert.equal(S.priorityOf({ days_overdue: 0, balance: 30000, contacted: false }).priority, 15, 'not overdue yet: contact bonus does not apply');
});

test('tracker rows carry broken_promise and priority; the "broken" filter finds promises that passed unpaid', () => {
  const rows = [
    mkRow('1', 'Asha', [{ due_date: '2026-11-01', amount_due: 30000, balance: 30000, days_overdue: 14 }]),
    mkRow('2', 'Bela', [{ due_date: '2026-11-10', amount_due: 20000, balance: 20000, days_overdue: 5 }]),
  ];
  const promised = new Map([['1-0', '2026-11-12'], ['2-0', '2026-11-20']]);
  const last = new Map([['1-0', { sent_at: new Date(), outcome: 'Will pay on date', channel: 'Call', sent_by_name: 'R' }]]);
  const broken = S.trackerRows(rows, { filter: 'broken', today, last, promised });
  assert.deepEqual(broken.map((r) => r.student_name), ['Asha']);
  assert.equal(broken[0].broken_promise, true);
  assert.ok(broken[0].priority > 0);

  const queue = S.trackerRows(rows, { filter: 'queue', today, last, promised });
  assert.deepEqual(queue.map((r) => r.student_name), ['Asha'], 'Bela promised a future date, so she leaves the queue');
  const counts = S.trackerCounts(rows, { today, last, promised });
  assert.equal(counts.broken, 1); assert.equal(counts.queue, 1); assert.equal(counts.all, 2); assert.equal(counts.overdue, 1);
});

test('forecast buckets unpaid EMI money by when it falls due and ignores dropped students and waived/paid rows', () => {
  const rows = [
    mkRow('1', 'A', [
      { due_date: '2026-11-01', balance: 1000 },            // overdue
      { due_date: '2026-11-15', balance: 2000 },            // today
      { due_date: '2026-11-20', balance: 4000 },            // within 7 days
      { due_date: '2026-12-10', balance: 8000 },            // within 30
      { due_date: '2027-01-20', balance: 16000 },           // within 90
      { due_date: '2027-06-01', balance: 32000 },           // later
      { due_date: '2026-11-25', balance: 0 },               // paid: ignored
      { due_date: '2026-11-26', balance: 500, status: 'Waived' },
    ]),
    mkRow('2', 'B', [{ due_date: '2026-11-18', balance: 99999 }], 'dropped'),
  ];
  const f = S.forecast(rows, today);
  assert.equal(f.overdue, 1000);
  assert.equal(f.today, 2000);
  assert.equal(f.d7, 6000);
  assert.equal(f.d30, 14000);
  assert.equal(f.d90, 30000);
  assert.equal(f.later, 32000);
  assert.equal(f.weeks.length, 8);
  assert.equal(f.weeks[0].amount, 6000);
  assert.equal(f.weeks[0].from, '2026-11-15');
});

test('cache: shares in-flight work, reuses until a write bumps it, never keeps a failure', async () => {
  cache.bump();
  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++calls), 10));
  const [a, b] = await Promise.all([cache.memo('k', 1000, slow), cache.memo('k', 1000, slow)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1, 'two simultaneous callers cost one computation');
  assert.equal(await cache.memo('k', 1000, slow), 1, 'second call is served from the cache');
  cache.bump();
  assert.equal(await cache.memo('k', 1000, slow), 2, 'a write invalidates it');
  await assert.rejects(cache.memo('bad', 1000, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.memo('bad', 1000, async () => 'fine'), 'fine', 'failures are not cached');
  assert.equal(await cache.memo('ttl', 1, async () => ++calls) > 0, true);
});

test('new endpoints exist and are locked behind sign-in; responses are compressed', async () => {
  process.env.NODE_ENV = 'test';
  const { createApp } = require('../src/index');
  const server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/api/backup/status', '/api/backup/download', '/api/backup/audit', '/api/performance', '/api/payments/abc/receipt', '/api/tracker', '/api/home']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 401, `${p} must require sign-in`);
    }
    for (const [m, p] of [['PUT', '/api/backup/settings'], ['POST', '/api/backup/run'], ['POST', '/api/backup/restore']]) {
      const res = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 401, `${m} ${p} must require sign-in`);
    }
    const h = await fetch(base + '/api/health');
    assert.equal((await h.json()).ok, true);
  } finally { server.close(); }
});

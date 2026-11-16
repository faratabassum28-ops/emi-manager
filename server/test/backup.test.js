// Backup engine: config rules, schedule decisions, the Google Sheet round trip (against a mock of the Apps Script),
// the JSON bundle, and restore (dry run / add missing / overwrite) over in-memory collections.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
const M = require('../src/models');
const B = require('../src/services/backup');
const { ObjectId } = mongoose.Types;

/* ---------- in-memory stand-ins for the raw MongoDB collections ---------- */
function fakeCollection(initial = []) {
  const docs = new Map(initial.map((d) => [String(d._id), d]));
  const match = (d, f = {}) => Object.entries(f).every(([k, v]) => (v && v.$in ? v.$in.map(String).includes(String(d[k])) : String(d[k]) === String(v)));
  return {
    docs,
    find: (f) => ({ toArray: async () => [...docs.values()].filter((d) => match(d, f)).map((d) => ({ ...d })) }),
    bulkWrite: async (ops) => {
      let insertedCount = 0; let modifiedCount = 0;
      for (const op of ops) {
        if (op.insertOne) { docs.set(String(op.insertOne.document._id), op.insertOne.document); insertedCount++; }
        else if (op.replaceOne) { docs.set(String(op.replaceOne.filter._id), op.replaceOne.replacement); modifiedCount++; }
        else if (op.updateOne) { const k = String(op.updateOne.filter._id); docs.set(k, { ...docs.get(k), ...op.updateOne.update.$set }); modifiedCount++; }
      }
      return { insertedCount, modifiedCount };
    },
  };
}
const realCollections = {};
function useFakes(seed = {}) {
  const fakes = {};
  for (const [name, get] of B.COLLECTIONS) {
    const Model = get();
    if (!(name in realCollections)) realCollections[name] = Model.collection;
    fakes[name] = fakeCollection(seed[name] || []);
    Model.collection = fakes[name];
  }
  realCollections.files ||= M.FileDoc.collection;
  fakes.files = fakeCollection(seed.files || []);
  M.FileDoc.collection = fakes.files;
  return fakes;
}

const pid = new ObjectId(); const sid = new ObjectId(); const bid = new ObjectId(); const eid = new ObjectId(); const iid = new ObjectId(); const payid = new ObjectId(); const uid = new ObjectId();
const seed = () => ({
  programs: [{ _id: pid, code: 'SUPER', name: 'Super', default_fee: 183001, max_emis: 6, active: true }],
  batches: [{ _id: bid, code: 'SUPER-B01', program: pid, batch_name: 'Batch 1', status: 'Running' }],
  students: [{ _id: sid, full_name: 'Meera "Nair" ₹', phone: '+919999900000', email: 'm@x.in', city: 'Hyderabad', createdAt: new Date('2026-10-01T05:00:00Z') }],
  enrollments: [{ _id: eid, student: sid, batch: bid, enrollment_date: '2026-10-01', total_fee: 183001, net_payable: 183001, balance_due: 183001, emi_count: 1 }],
  instalments: [{ _id: iid, enrollment: eid, batch: bid, type: 'EMI', emi_number: 1, amount_due: 183001, due_date: '2026-11-01', amount_paid: 30500, paid_on: null }],
  payments: [{ _id: payid, enrollment: eid, batch: bid, allocations: [{ instalment: iid, amount: 30500 }], amount: 30500, payment_date: '2026-11-02', mode: 'UPI', recorded_by_name: 'Asha', verified: false, createdAt: new Date('2026-11-02T05:00:00Z') }],
  reminderlogs: [{ _id: new ObjectId(), instalment: iid, enrollment: eid, channel: 'Call', outcome: 'Will pay on date', promised_date: '2026-11-20', sent_by_name: 'Ravi', sent_at: new Date('2026-11-05T05:00:00Z') }],
  activitylogs: [{ _id: new ObjectId(), entity: 'Payment', entity_id: String(payid), action: 'create', user_name: 'Asha', changes: { amount: 30500 } }],
  users: [{ _id: uid, name: 'Admin', email: 'a@x.in', password_hash: '$2a$hash', role: 'Admin', active: true }],
  settings: [{ _id: new ObjectId(), key: 'main', payment_modes: ['UPI'], backup: { secret: 'TOPSECRET', url: 'https://script.google.com/x' } }],
  adjustmenttypes: [],
});

test.afterEach(() => {
  for (const [name, get] of B.COLLECTIONS) if (realCollections[name]) get().collection = realCollections[name];
  if (realCollections.files) M.FileDoc.collection = realCollections.files;
});

/* ---------- config ---------- */
test('cleanConfig validates the script link, numbers and the on-switch', () => {
  const cur = { ...B.DEFAULT_BACKUP };
  assert.throws(() => B.cleanConfig({ url: 'https://evil.example/x' }, cur), /script\.google\.com/);
  assert.throws(() => B.cleanConfig({ interval_minutes: 2 }, cur), /interval/i);
  assert.throws(() => B.cleanConfig({ daily_hour: 24 }, cur), /hour/i);
  assert.throws(() => B.cleanConfig({ enabled: true }, cur), /Google Script link/);
  const ok = B.cleanConfig({ url: 'https://script.google.com/macros/s/abc/exec', enabled: true, interval_minutes: 15, keep_copies: 7 }, { ...cur, secret: 's' });
  assert.equal(ok.enabled, true); assert.equal(ok.interval_minutes, 15); assert.equal(ok.keep_copies, 7);
  assert.equal(B.publicConfig(ok).secret, undefined);
  assert.equal(B.publicConfig(ok).has_secret, true);
});

/* ---------- when to run ---------- */
test('decide: daily once after the daily hour, change-driven runs respect the interval, nothing when off', () => {
  const cfg = { enabled: true, url: 'u', secret: 's', interval_minutes: 30, daily_hour: 2, on_change: true };
  const base = { now: new Date('2026-11-15T12:00:00Z'), dirty: false, lastStartedAt: 0, lastDailyOn: '2026-11-14', today: '2026-11-15', hourIST: 9 };
  assert.equal(B.decide(cfg, base), 'daily');
  assert.equal(B.decide(cfg, { ...base, lastDailyOn: '2026-11-15' }), null);
  assert.equal(B.decide(cfg, { ...base, lastDailyOn: '2026-11-15', dirty: true, lastStartedAt: base.now.getTime() - 10 * 60000 }), null, 'too soon after the last run');
  assert.equal(B.decide(cfg, { ...base, lastDailyOn: '2026-11-15', dirty: true, lastStartedAt: base.now.getTime() - 31 * 60000 }), 'auto');
  assert.equal(B.decide(cfg, { ...base, hourIST: 1 , lastDailyOn: '2026-11-14' }), null, 'before the daily hour');
  assert.equal(B.decide({ ...cfg, on_change: false }, { ...base, lastDailyOn: '2026-11-15', dirty: true }), null);
  assert.equal(B.decide({ ...cfg, enabled: false }, base), null);
  assert.equal(B.decide({ ...cfg, secret: '' }, base), null);
  assert.equal(B.decide(cfg, { ...base, lastStartedAt: base.now.getTime() - 60000 }), null, 'a failed daily run waits before retrying');
});

/* ---------- JSON bundle & restore ---------- */
test('bundle never contains the backup secret, and survives a JSON round trip with ObjectIds, dates and unicode intact', async () => {
  useFakes(seed());
  const bundle = await B.buildBundle();
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes('TOPSECRET'), 'backup secret must not be exported');
  assert.equal(bundle.counts.students, 1);
  assert.equal(bundle.counts.payments, 1);

  const back = B.parseBundle(Buffer.from(text));
  const target = useFakes({});
  const out = await B.restoreBundle(back, { mode: 'missing' });
  assert.equal(out.report.students.added, 1);
  assert.equal(out.report.payments.added, 1);
  const stu = [...target.students.docs.values()][0];
  assert.ok(stu._id instanceof ObjectId && String(stu._id) === String(sid));
  assert.equal(stu.full_name, 'Meera "Nair" ₹');
  assert.ok(stu.createdAt instanceof Date && stu.createdAt.toISOString() === '2026-10-01T05:00:00.000Z');
  const pay = [...target.payments.docs.values()][0];
  assert.equal(String(pay.allocations[0].instalment), String(iid));
});

test('restore: dry run writes nothing; "missing" never touches existing rows; "overwrite" replaces them but deletes nothing', async () => {
  const live = useFakes(seed());
  const bundle = JSON.parse(JSON.stringify(await B.buildBundle()));

  // the live database has since changed: student edited, a new student added
  live.students.docs.get(String(sid)).full_name = 'Meera N (edited)';
  const extra = new ObjectId(); live.students.docs.set(String(extra), { _id: extra, full_name: 'New Student', phone: '+911' });
  const back = B.parseBundle(bundle);

  const dry = await B.restoreBundle(back, { mode: 'overwrite', dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.report.students.replaced, 1);
  assert.equal(live.students.docs.get(String(sid)).full_name, 'Meera N (edited)', 'dry run must not write');

  const miss = await B.restoreBundle(back, { mode: 'missing' });
  assert.equal(miss.report.students.added, 0);
  assert.equal(miss.report.students.already_there, 1);
  assert.equal(live.students.docs.get(String(sid)).full_name, 'Meera N (edited)');

  const over = await B.restoreBundle(back, { mode: 'overwrite' });
  assert.equal(over.report.students.replaced, 1);
  assert.equal(live.students.docs.get(String(sid)).full_name, 'Meera "Nair" ₹');
  assert.ok(live.students.docs.has(String(extra)), 'restore never deletes records that are not in the backup');
});

test('restore keeps this site\'s own backup settings when overwriting settings', async () => {
  const live = useFakes(seed());
  const bundle = JSON.parse(JSON.stringify(await B.buildBundle()));
  const row = [...live.settings.docs.values()][0];
  row.backup = { secret: 'NEWSECRET' };
  row.payment_modes = ['Cash'];
  await B.restoreBundle(B.parseBundle(bundle), { mode: 'overwrite' });
  const after = [...live.settings.docs.values()][0];
  assert.deepEqual(after.payment_modes, ['UPI']);
  assert.equal(after.backup.secret, 'NEWSECRET');
});

test('parseBundle rejects files that are not backups', () => {
  assert.throws(() => B.parseBundle(Buffer.from('not json')), /not a valid backup/);
  assert.throws(() => B.parseBundle(Buffer.from('{"hello":1}')), /not an EMI Manager backup/);
  assert.throws(() => B.parseBundle(Buffer.from(JSON.stringify({ app: 'emi-manager', format: 99, collections: {} }))), /newer version/);
});

/* ---------- readable tabs ---------- */
test('readable tabs resolve names and calculate status (nothing typed)', async () => {
  useFakes(seed());
  const data = await B.readAll();
  const tables = await B.readableTables(data, { reminder: { days_before: 3, grace_days: 2, defaulter_days: 30 } });
  const names = tables.map((t) => t.name);
  assert.deepEqual(names, ['Students', 'Instalments', 'Payments', 'Follow-ups']);
  const students = tables[0];
  assert.equal(students.rows.length, 1);
  assert.equal(students.rows[0][students.headers.indexOf('Student')], 'Meera "Nair" ₹');
  assert.equal(students.rows[0][students.headers.indexOf('Paid')], 30500);
  assert.equal(students.rows[0][students.headers.indexOf('Balance')], 152501);
  for (const t of tables) for (const r of t.rows) assert.equal(r.length, t.headers.length, `${t.name}: every row matches the header width`);
  const pays = tables[2];
  assert.equal(pays.rows[0][pays.headers.indexOf('Applied to')], 'EMI 1');
  assert.equal(tables[3].rows[0][tables[3].headers.indexOf('Student')], 'Meera "Nair" ₹');
});

test('raw tabs hold every record and split a giant record over extra columns', async () => {
  const s = seed();
  s.students[0].notes = 'x'.repeat(100000);
  useFakes(s);
  const raw = B.rawTables(await B.readAll());
  const st = raw.find((t) => t.name === '_raw_students');
  assert.ok(st.headers.length >= 3, 'huge record needs more than one json column');
  for (const t of raw) for (const r of t.rows) assert.equal(r.length, t.headers.length);
  for (const c of st.rows[0].slice(1)) assert.ok(c.length <= 45000, 'under the 50,000-character cell limit');
});

/* ---------- Google Sheet round trip against a mock Apps Script ---------- */
function mockScript({ secret = 'S3CRET', failFirst = 0 } = {}) {
  const tabs = new Map(); const log = []; let fails = failFirst;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (fails > 0) { fails--; return send({ ok: false, error: 'Service invoked too many times, try again later' }); }
      const b = JSON.parse(body);
      log.push(b.action);
      if (b.token !== secret) return send({ ok: false, error: 'Wrong secret key' });
      switch (b.action) {
        case 'ping': return send({ ok: true, name: 'EMI backup sheet', url: 'https://docs.google.com/x', has_backup: tabs.size > 0 });
        case 'begin': return send({ ok: true });
        case 'table': {
          if (b.offset === 0) tabs.set(b.name, { headers: b.headers, rows: [] });
          tabs.get(b.name).rows.push(...b.rows.map((r) => r.map((c) => (typeof c === 'number' ? c : String(c)))));
          return send({ ok: true, written: b.rows.length });
        }
        case 'finish': return send({ ok: true, spreadsheet_url: 'https://docs.google.com/sheet', copy_url: b.makeCopy ? 'https://docs.google.com/copy' : '', copy_name: 'EMI Manager backup test', copies_kept: b.keep });
        case 'list': return send({ ok: true, tables: [...tabs.keys()] });
        case 'read': { const t = tabs.get(b.name); const rows = t.rows.slice(b.offset, b.offset + b.limit).map((r) => r.map(String)); return send({ ok: true, rows, more: b.offset + rows.length < t.rows.length }); }
        default: return send({ ok: false, error: 'Unknown action' });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, tabs, log, url: `http://127.0.0.1:${server.address().port}/exec`, secret })));
}

test('sheet round trip: push everything, wipe the database, restore from the sheet alone', async () => {
  const fakes = useFakes(seed());
  const mock = await mockScript();
  try {
    const cfg = { url: mock.url, secret: mock.secret, keep_copies: 14 };
    const data = await B.readAll();
    const tables = [...(await B.readableTables(data, { reminder: { days_before: 3, grace_days: 2, defaulter_days: 30 } })), ...B.rawTables(data)];
    const out = await B.pushToSheet(cfg, tables, { makeCopy: true, counts: B.countsOf(data), trigger: 'manual' });
    assert.equal(out.copy_url, 'https://docs.google.com/copy');
    assert.ok(mock.tabs.has('Students') && mock.tabs.has('_raw_payments'));
    assert.deepEqual(mock.log.slice(0, 1), ['begin']);
    assert.equal(mock.log.at(-1), 'finish');

    // disaster: the database is empty
    const empty = useFakes({});
    const bundle = await B.pullFromSheet(cfg);
    const rep = await B.restoreBundle(bundle, { mode: 'missing' });
    assert.equal(rep.report.students.added, 1);
    assert.equal(rep.report.payments.added, 1);
    assert.equal(rep.report.enrollments.added, 1);
    assert.equal(rep.report.settings.added, 1);
    const stu = [...empty.students.docs.values()][0];
    assert.equal(stu.full_name, 'Meera "Nair" ₹');
    assert.ok(stu._id instanceof ObjectId);
    assert.ok(![...empty.settings.docs.values()][0].backup, 'the secret was never in the sheet');
    void fakes;
  } finally { mock.server.close(); }
});

test('sheet push retries transient Google errors and reports a wrong secret clearly', async () => {
  useFakes(seed());
  const mock = await mockScript({ failFirst: 1 });
  try {
    const out = await B.scriptCall({ url: mock.url, secret: mock.secret }, { action: 'ping' }, { waitMs: 5 });
    assert.equal(out.ok, true);
    await assert.rejects(B.scriptCall({ url: mock.url, secret: 'WRONG' }, { action: 'ping' }, { waitMs: 5 }), /Wrong secret key/);
  } finally { mock.server.close(); }
});

test('big tables are sent in several pieces, in order, with correct offsets', async () => {
  const mock = await mockScript();
  try {
    const rows = Array.from({ length: 9000 }, (_, i) => [String(i), `Student ${i}`]);
    await B.pushToSheet({ url: mock.url, secret: mock.secret, keep_copies: 0 }, [{ name: 'Students', headers: ['a', 'b'], text: [0, 1], rows }], { makeCopy: false, counts: {}, trigger: 'auto' });
    assert.equal(mock.tabs.get('Students').rows.length, 9000);
    assert.equal(mock.tabs.get('Students').rows[8999][0], '8999');
    assert.ok(mock.log.filter((a) => a === 'table').length >= 3);
  } finally { mock.server.close(); }
});

/* ---------- data check ---------- */
test('audit finds orphans and ledger drift', async () => {
  const s = seed();
  s.instalments[0].amount_paid = 1; // the ledger says 30,500
  s.payments.push({ _id: new ObjectId(), enrollment: new ObjectId(), batch: bid, allocations: [], amount: 100, payment_date: '2026-11-03', mode: 'UPI' });
  useFakes(s);
  const a = await B.audit();
  const codes = a.issues.map((i) => i.code);
  assert.ok(codes.includes('ledger_drift'));
  assert.ok(codes.includes('orphan_payments'));
  assert.equal(a.ok, false);
});

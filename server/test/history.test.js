const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/lib/history');
const W = require('../src/lib/windows');

test('payment events read like a sentence and carry allocations', () => {
  const e = H.fromActivity({ _id: 1, entity: 'Payment', action: 'create', createdAt: '2026-11-10T04:00:00Z', user_name: 'Asha', changes: { amount: 30500, mode: 'UPI', ref: 'UTR1', allocations: ['EMI 1: 30500'] } });
  assert.equal(e.label, 'Payment of ₹30,500 recorded');
  assert.equal(e.tone, 'good');
  assert.match(e.detail, /UPI · Ref UTR1 · EMI 1: 30500/);
  assert.equal(e.by, 'Asha');
});

test('reversal, waive and dropped status are flagged red', () => {
  assert.equal(H.describeActivity({ entity: 'Payment', action: 'reverse', changes: { amount: 100 } }).tone, 'bad');
  assert.equal(H.describeActivity({ entity: 'Instalment', action: 'waive', changes: { amount_due: 5000, amount_paid: 2000 } }).label, 'Instalment waived (₹3,000 written off)');
  assert.equal(H.describeActivity({ entity: 'Enrollment', action: 'status', changes: { status: ['Active', 'Dropped'] } }).tone, 'bad');
  assert.equal(H.describeActivity({ entity: 'Enrollment', action: 'status', changes: { status: [null, 'Paused'] } }).label, 'Status changed: Active → Paused');
});

test('reschedule shows old and new date; unknown actions never crash', () => {
  const d = H.describeActivity({ entity: 'Instalment', action: 'reschedule', changes: { due_date: ['2026-11-05', '2026-11-20'] } });
  assert.equal(d.label, 'Next due date moved to 20 Nov 2026');
  assert.equal(d.detail, 'Was 05 Nov 2026');
  assert.equal(H.describeActivity({ entity: 'Thing', action: 'zap' }).label, 'Thing zap');
  assert.equal(H.describeActivity({ entity: 'Payment', action: 'create', changes: 'junk' }).label, 'Payment of ₹0 recorded');
});

test('reminders: promised date and outcome tone', () => {
  const r = H.fromReminder({ _id: 2, channel: 'Call', outcome: 'Will pay on date', promised_date: '2026-11-15', sent_at: '2026-11-10T05:00:00Z', sent_by_name: 'Ravi', instalment: 9 });
  assert.equal(r.label, 'Call: Will pay on date');
  assert.equal(r.tone, 'warn');
  assert.match(r.detail, /promised 15 Nov 2026/);
  assert.equal(H.describeReminder({ channel: 'WhatsApp', outcome: 'Sent' }).label, 'WhatsApp reminder sent');
  assert.equal(H.describeReminder({ channel: 'Call', outcome: 'No answer' }).tone, 'bad');
});

test('events sort newest first', () => {
  const list = [{ at: '2026-11-01T00:00:00Z' }, { at: '2026-11-09T00:00:00Z' }, { at: '2026-11-05T00:00:00Z' }].sort(H.byNewest);
  assert.deepEqual(list.map((x) => x.at.slice(0, 10)), ['2026-11-09', '2026-11-05', '2026-11-01']);
});

test('windows: week starts Monday, previous window is equal length', () => {
  // 10 Nov 2026 is a Tuesday
  const w = W.resolveWindow('this_week', '2026-11-10');
  assert.equal(w.start, '2026-11-09'); assert.equal(w.days, 2);
  const p = W.previousWindow(w);
  assert.deepEqual([p.start, p.end, p.days], ['2026-11-07', '2026-11-08', 2]);
  const lw = W.resolveWindow('last_week', '2026-11-10');
  assert.deepEqual([lw.start, lw.end, lw.days], ['2026-11-02', '2026-11-08', 7]);
  const lm = W.resolveWindow('last_month', '2026-11-10');
  assert.deepEqual([lm.start, lm.end], ['2026-10-01', '2026-10-31']);
  assert.equal(W.resolveWindow('last_3_months', '2026-11-10').start, '2026-09-01');
  assert.equal(W.previousWindow(W.resolveWindow('all_time', '2026-11-10')), null);
});

test('windows: custom range must be valid', () => {
  assert.equal(W.resolveWindow('custom', '2026-11-10', { from: '2026-11-05', to: '2026-11-01' }), null);
  assert.equal(W.resolveWindow('custom', '2026-11-10', { from: '2026-11-01', to: '2026-11-05' }).days, 5);
  assert.equal(W.resolveWindow('nonsense', '2026-11-10'), null);
  assert.ok(W.inWindow('2026-11-03', W.resolveWindow('custom', '2026-11-10', { from: '2026-11-01', to: '2026-11-05' })));
});

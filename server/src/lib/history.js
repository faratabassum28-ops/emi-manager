// Turns raw audit rows (ActivityLog, ReminderLog) into readable events for the history timeline.
// Pure functions (no DB) so they are unit-testable. tone: 'good' | 'bad' | 'warn' | '' drives the dot colour.
const { fmtINR, fmtDate } = require('./emi');

const arr = (x) => (Array.isArray(x) ? x : []);
const pair = (p) => (Array.isArray(p) && p.length === 2 ? p : [null, null]);

function describeActivity(a) {
  const c = a.changes && typeof a.changes === 'object' ? a.changes : {};
  const key = `${a.entity}:${a.action}`;
  switch (key) {
    case 'Enrollment:create':
    case 'Enrollment:import':
      return {
        kind: 'enrollment', tone: 'good',
        label: a.action === 'import' ? `Enrollment imported${c.batch ? ` into ${c.batch}` : ''}` : `Enrolled${c.batch ? ` in ${c.batch}` : ''}`,
        detail: `Net payable ${fmtINR(c.net_payable)} · balance ${fmtINR(c.balance_due)} in ${c.emis || 0} EMIs`,
      };
    case 'Payment:create':
      return { kind: 'payment', tone: 'good', label: `Payment of ${fmtINR(c.amount)} recorded`, detail: [c.mode, c.ref && `Ref ${c.ref}`, arr(c.allocations).join(' · ')].filter(Boolean).join(' · ') };
    case 'Payment:reverse':
      return { kind: 'payment', tone: 'bad', label: `Payment of ${fmtINR(c.amount)} reversed`, detail: c.ref ? `Ref ${c.ref}` : '' };
    case 'Payment:verify':
      return { kind: 'payment', tone: 'good', label: `Payment of ${fmtINR(c.amount)} verified by Accounts`, detail: c.ref ? `Ref ${c.ref}` : '' };
    case 'Payment:unverify':
      return { kind: 'payment', tone: 'warn', label: `Verification removed from payment of ${fmtINR(c.amount)}`, detail: c.ref ? `Ref ${c.ref}` : '' };
    case 'Instalment:reschedule': {
      const [from, to] = pair(c.due_date);
      return { kind: 'schedule', tone: 'warn', label: `Next due date moved to ${fmtDate(to)}`, detail: from ? `Was ${fmtDate(from)}` : '' };
    }
    case 'Instalment:waive':
      return { kind: 'schedule', tone: 'bad', label: `Instalment waived (${fmtINR(Math.max(0, (c.amount_due || 0) - (c.amount_paid || 0)))} written off)`, detail: '' };
    case 'Enrollment:restructure':
      return { kind: 'schedule', tone: 'warn', label: 'EMI plan restructured', detail: `${arr(c.old).length} unpaid EMIs → ${arr(c.new).length}` };
    case 'Enrollment:status': {
      const [from, to] = pair(c.status);
      const tone = ['Dropped', 'Refunded'].includes(to) ? 'bad' : to === 'Paused' ? 'warn' : 'good';
      return { kind: 'status', tone, label: `Status changed: ${from || 'Active'} → ${to || 'Active'}`, detail: '' };
    }
    case 'Enrollment:agreement':
      return { kind: 'document', tone: 'good', label: 'EMI agreement uploaded', detail: '' };
    case 'Student:update':
      return { kind: 'student', tone: '', label: 'Student details edited', detail: diffSummary(c.before, c.after) };
    case 'Program:create': return { kind: 'setup', tone: '', label: `Program created: ${c.name || ''}`, detail: '' };
    case 'Program:update': return { kind: 'setup', tone: '', label: 'Program updated', detail: diffSummary(c.before, c.after) };
    case 'Batch:create': return { kind: 'setup', tone: '', label: `Batch created: ${c.batch_name || c.code || ''}`, detail: c.code || '' };
    case 'Batch:update': return { kind: 'setup', tone: '', label: 'Batch updated', detail: diffSummary(c.before, c.after) };
    case 'AdjustmentType:create': return { kind: 'setup', tone: '', label: `Adjustment added: ${c.name || ''}`, detail: c.default_amount != null ? fmtINR(c.default_amount) : '' };
    case 'AdjustmentType:update': return { kind: 'setup', tone: '', label: `Adjustment updated: ${c.name || ''}`, detail: c.default_amount != null ? fmtINR(c.default_amount) : '' };
    case 'Settings:update': return { kind: 'setup', tone: '', label: 'Settings changed', detail: Array.isArray(c) ? c.join(', ') : '' };
    case 'User:create': return { kind: 'user', tone: '', label: `User created: ${c.email || ''}`, detail: c.role || '' };
    case 'User:update': return { kind: 'user', tone: c.active === false ? 'warn' : '', label: c.active === false ? 'User disabled' : 'User updated', detail: c.role || '' };
    default:
      return { kind: String(a.entity || 'other').toLowerCase(), tone: '', label: `${a.entity || 'Item'} ${a.action || 'changed'}`, detail: '' };
  }
}

// Short "field: old → new" line for before/after objects.
function diffSummary(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return '';
  const out = [];
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(`${k.replace(/_/g, ' ')}: ${show(before[k])} → ${show(after[k])}`);
  }
  return out.slice(0, 4).join(' · ');
}
const show = (v) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function describeReminder(r) {
  const out = r.outcome || 'Sent';
  const promised = r.promised_date ? ` · promised ${fmtDate(r.promised_date)}` : '';
  const tone = out === 'Paid' ? 'good' : ['No answer', 'Dispute'].includes(out) ? 'bad' : out === 'Sent' ? '' : 'warn';
  let label;
  if (r.channel === 'WhatsApp') label = out === 'Sent' ? 'WhatsApp reminder sent' : `WhatsApp: ${out}`;
  else if (r.channel === 'Call') label = `Call: ${out}`;
  else label = `${r.channel || 'Reminder'}: ${out}`;
  return { kind: 'reminder', tone, label, detail: `${promised.replace(/^ · /, '')}${promised && r.notes ? ' · ' : ''}${r.notes || ''}`.trim() };
}

function fromActivity(a) {
  const d = describeActivity(a);
  return {
    id: `a_${a._id}`, at: a.createdAt, by: a.user_name || 'system', source: 'activity',
    entity: a.entity, action: a.action, entity_id: a.entity_id, reason: a.reason || '', ...d,
  };
}
function fromReminder(r) {
  const d = describeReminder(r);
  return {
    id: `r_${r._id}`, at: r.sent_at || r.createdAt, by: r.sent_by_name || 'system', source: 'reminder',
    entity: 'Reminder', action: String(r.channel || '').toLowerCase(), entity_id: String(r.instalment || ''), enrollment_id: r.enrollment ? String(r.enrollment) : null, reason: '', ...d,
  };
}

const byNewest = (a, b) => new Date(b.at) - new Date(a.at);

module.exports = { describeActivity, describeReminder, fromActivity, fromReminder, byNewest, diffSummary };

// Pure business logic. No database access here, so every rule in the spec
// (sections 2, 6, 8, 9) can be unit-tested on its own.
const { diffDays, addMonths, isValidDate } = require('./dates');

const DEFAULT_RULES = { days_before: 3, grace_days: 2, defaulter_days: 30 };
const MANUAL_STATUSES = ['Paused', 'Refunded', 'Dropped'];

const isInt = (n) => Number.isInteger(n);
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);

/* ---------- Fee maths (spec section 6) ---------- */
function computeFees({ total_fee = 0, adjustments = [], discount = 0, application_fee = 0, commitment_fee = 0 }) {
  const total_adjustment = sum(adjustments, (a) => a.amount);
  const net_payable = total_fee - total_adjustment - discount;
  const balance_due = net_payable - application_fee - commitment_fee;
  return { total_adjustment, net_payable, balance_due };
}

/* ---------- Auto-split (step 3): equal split, remainder on the LAST EMI ---------- */
function autoSplit(balance, count, firstDate) {
  if (!isInt(balance) || balance < 0) throw new Error('Balance must be a whole number of rupees');
  if (!isInt(count) || count < 0) throw new Error('EMI count must be a whole number');
  if (count === 0) return [];
  if (!isValidDate(firstDate)) throw new Error('First due date is invalid');
  const base = Math.floor(balance / count);
  const rem = balance - base * count;
  return Array.from({ length: count }, (_, i) => ({
    amount_due: i === count - 1 ? base + rem : base,
    due_date: addMonths(firstDate, i),
  }));
}

/* ---------- Plan validation: sum must equal balance exactly, dates ascending ---------- */
function validatePlan(balance, emis) {
  const errors = [];
  if (!Array.isArray(emis)) return ['EMI plan is missing'];
  emis.forEach((e, i) => {
    if (!isInt(e.amount_due) || e.amount_due <= 0) errors.push(`EMI ${i + 1}: amount must be a positive whole number`);
    if (!isValidDate(e.due_date)) errors.push(`EMI ${i + 1}: due date is invalid`);
  });
  if (errors.length) return errors;
  for (let i = 1; i < emis.length; i++) {
    if (emis[i].due_date < emis[i - 1].due_date) errors.push(`EMI ${i + 1}: due date must not be before EMI ${i}`);
  }
  const total = sum(emis, (e) => e.amount_due);
  if (total !== balance) {
    errors.push(`EMI amounts add up to ${total} but the balance due is ${balance} (difference ${balance - total})`);
  }
  return errors;
}

/* ---------- Instalment status (spec section 2). Never typed by hand. ---------- */
function instalmentState(i, today, rules = DEFAULT_RULES) {
  const grace = rules.grace_days ?? DEFAULT_RULES.grace_days;
  const paid = i.amount_paid || 0;
  const balance = Math.max(i.amount_due - paid, 0);

  if (i.waived) return { status: 'Waived', balance: 0, days_overdue: 0, days_late: 0, is_overdue: false };

  if (balance === 0) {
    const late = i.paid_on ? Math.max(diffDays(i.paid_on, i.due_date), 0) : 0;
    const onTime = late <= grace;
    return { status: onTime ? 'Paid on time' : 'Paid late', balance: 0, days_overdue: 0, days_late: onTime ? 0 : late, is_overdue: false };
  }

  const diff = diffDays(i.due_date, today); // due - today
  const days_overdue = diff < 0 ? -diff : 0;
  let status;
  if (paid > 0) status = 'Partially paid';
  else if (diff < 0) status = 'Overdue';
  else if (diff === 0) status = 'Due today';
  else if (diff <= 7) status = 'Due soon';
  else status = 'Upcoming';
  return { status, balance, days_overdue, days_late: 0, is_overdue: days_overdue > 0 };
}

/* ---------- Enrollment status: Active / Completed / Defaulter computed; the rest are manual ---------- */
function enrollmentStatus(enr, states, rules = DEFAULT_RULES) {
  if (MANUAL_STATUSES.includes(enr.manual_status)) return enr.manual_status;
  const live = states.filter((s) => s.status !== 'Waived');
  if (live.every((s) => s.balance === 0)) return 'Completed';
  const threshold = rules.defaulter_days ?? DEFAULT_RULES.defaulter_days;
  if (live.some((s) => s.days_overdue >= threshold)) return 'Defaulter';
  return 'Active';
}

/* Mutually exclusive dashboard bucket; a student is counted once (rule 6). */
function studentBucket(status, states) {
  if (status === 'Dropped' || status === 'Refunded') return 'dropped';
  if (status === 'Completed') return 'completed';
  if (status === 'Defaulter') return 'defaulter';
  if (states.some((s) => s.is_overdue)) return 'overdue';
  if (states.some((s) => s.status === 'Paid late')) return 'late';
  return 'on_time';
}

/* ---------- Payment allocation (spec section 8) ----------
   Chosen instalments first (in the order given), then everything else oldest first. */
function allocatePayment(amount, instalments, preferredIds = []) {
  const open = instalments
    .filter((i) => !i.waived && i.amount_due - (i.amount_paid || 0) > 0)
    .map((i) => ({ ...i, remaining: i.amount_due - (i.amount_paid || 0) }));
  const pref = preferredIds.map(String);
  const rank = (i) => {
    const p = pref.indexOf(String(i.id));
    return p === -1 ? pref.length : p;
  };
  open.sort((a, b) => rank(a) - rank(b) || (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0) || (a.emi_number || 0) - (b.emi_number || 0));
  let left = amount;
  const allocations = [];
  for (const i of open) {
    if (left <= 0) break;
    const take = Math.min(left, i.remaining);
    allocations.push({ instalment: i.id, amount: take });
    left -= take;
  }
  return { allocations, unapplied: left };
}

/* ---------- Rebuild amount_paid / paid_on from the payment ledger ----------
   Payments (and reversals, which carry negative allocations) are the source of truth. */
function recalcFromPayments(instalments, payments) {
  const ordered = [...payments].sort((a, b) => (a.payment_date < b.payment_date ? -1 : a.payment_date > b.payment_date ? 1 : new Date(a.createdAt || 0) - new Date(b.createdAt || 0)));
  const state = new Map(instalments.map((i) => [String(i.id), { amount_paid: 0, paid_on: null, due: i.amount_due }]));
  for (const p of ordered) {
    for (const a of p.allocations || []) {
      const s = state.get(String(a.instalment));
      if (!s) continue;
      s.amount_paid += a.amount;
      if (s.amount_paid >= s.due && s.due > 0) {
        if (!s.paid_on) s.paid_on = p.payment_date;
      } else {
        s.paid_on = null;
      }
    }
  }
  return state;
}

/* ---------- Templates (spec section 4.6) ---------- */
function renderTemplate(tpl = '', vars = {}) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

function pickTemplateKey(state) {
  if (state.days_overdue >= 7) return 'overdue7';
  if (state.days_overdue >= 1) return 'overdue1';
  if (state.status === 'Due today') return 'due_today';
  return 'before3';
}

const fmtINR = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

const fmtDate = (s) => {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y}`;
};

function normalizePhone(p) {
  let s = String(p || '').replace(/[\s\-().]/g, '');
  if (/^\d{10}$/.test(s)) s = '+91' + s;
  if (/^91\d{10}$/.test(s)) s = '+' + s;
  if (/^00\d+$/.test(s)) s = '+' + s.slice(2);
  return s;
}
const isValidPhone = (p) => /^\+\d{8,15}$/.test(p);

module.exports = {
  DEFAULT_RULES, MANUAL_STATUSES, computeFees, autoSplit, validatePlan, instalmentState,
  enrollmentStatus, studentBucket, allocatePayment, recalcFromPayments, renderTemplate,
  pickTemplateKey, fmtINR, fmtDate, normalizePhone, isValidPhone, sum,
};

const { Setting } = require('../models');
const { DEFAULT_RULES } = require('../lib/emi');

const DEFAULT_TEMPLATES = {
  before3: 'Hi {name}, a gentle reminder that EMI {emi_number} ({amount}) is due on {due_date}. {payment_link}',
  due_today: 'Hi {name}, your EMI {emi_number} ({amount}) is due today, {due_date}. Please pay and share the screenshot once done. {payment_link}',
  overdue1: 'Hi {name}, your EMI {emi_number} ({amount}) was due on {due_date} and is still pending. Please clear it today. {payment_link}',
  overdue7: 'Hi {name}, your EMI {emi_number} ({amount}, due {due_date}) is now 7+ days overdue. Please pay at the earliest or reply to discuss. {payment_link}',
  thanks: 'Thank you {name}! We received {amount} on {paid_date}. Your next instalment: {next_amount} due on {next_due_date}.',
  welcome: 'Welcome to MySoulSchool, {name}! Your EMI schedule:\n{schedule}',
};

const DEFAULTS = {
  payment_modes: ['UPI', 'Bank transfer (NEFT/IMPS)', 'Razorpay link', 'Card', 'Cheque', 'Cash', 'International (PayPal/Wise)', 'Bajaj/NBFC finance'],
  reminder: DEFAULT_RULES,
  discount_limit: 10000,
  payment_link_base: '',
  templates: DEFAULT_TEMPLATES,
};

async function getSettings() {
  const s = await Setting.findOne({ key: 'main' }).lean();
  if (!s) return { ...DEFAULTS };
  return {
    ...s,
    payment_modes: s.payment_modes && s.payment_modes.length ? s.payment_modes : DEFAULTS.payment_modes,
    reminder: { ...DEFAULTS.reminder, ...(s.reminder || {}) },
    templates: { ...DEFAULT_TEMPLATES, ...(s.templates || {}) },
  };
}

module.exports = { getSettings, DEFAULTS, DEFAULT_TEMPLATES };

// The spec's data model (section 3) as Mongoose collections.
// Rule: dashboard numbers and statuses are NEVER stored - they are calculated (see services/snapshot.js).
// Dates are 'YYYY-MM-DD' strings (Asia/Kolkata); money is whole rupees.
const mongoose = require('mongoose');
const { Schema } = mongoose;
// Prefix every collection (emi_programs, emi_users, ...) so this app can share a database
// with other projects without clashing with their "programs" / "users" collections.
mongoose.pluralize((name) => `emi_${name.toLowerCase()}${/(h|s)$/i.test(name) ? 'es' : 's'}`);
const ref =(name) => ({ type: Schema.Types.ObjectId, ref: name });
const opts = { timestamps: true };

const User = mongoose.model('User', new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  role: { type: String, enum: ['Admin', 'Manager', 'CRM', 'Viewer'], default: 'CRM' },
  batches: [ref('Batch')],            // optional restriction for CRM users (rule 11)
  can_verify: { type: Boolean, default: false }, // Accounts: Viewer who may tick "verified"
  active: { type: Boolean, default: true },
}, opts));

const Program = mongoose.model('Program', new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true }, // PRG id e.g. SUPER
  name: { type: String, required: true, trim: true },
  default_fee: { type: Number, required: true, min: 0 },
  default_application_fee: { type: Number, default: 0, min: 0 },
  default_commitment_fee: { type: Number, default: 0, min: 0 },
  max_emis: { type: Number, default: 12, min: 1 },
  active: { type: Boolean, default: true },
}, opts));

const Batch = mongoose.model('Batch', new Schema({
  code: { type: String, required: true, unique: true }, // e.g. SUPER-B07
  program: { ...ref('Program'), required: true },
  batch_name: { type: String, required: true, trim: true },
  start_date: String,
  end_date: String,
  fee_override: { type: Number, default: null },
  status: { type: String, enum: ['Upcoming', 'Running', 'Completed', 'Archived'], default: 'Upcoming' },
  owner: ref('User'),
}, opts));

const Student = mongoose.model('Student', new Schema({
  full_name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  city: String,
  country: String,
  notes: String,
}, opts));

const AdjustmentType = mongoose.model('AdjustmentType', new Schema({
  name: { type: String, required: true, trim: true },
  default_amount: { type: Number, required: true, min: 0 },
  active: { type: Boolean, default: true },
  target_programs: [ref('Program')], // empty = can be credited against any program
}, opts));

const Enrollment = mongoose.model('Enrollment', new Schema({
  student: { ...ref('Student'), required: true },
  batch: { ...ref('Batch'), required: true },
  enrollment_date: { type: String, required: true },
  closed_by: String,
  total_fee: { type: Number, required: true },
  fee_change_reason: String,
  adjustments: [{ adjustment: ref('AdjustmentType'), name: String, amount: Number, notes: String, _id: false }],
  discount: { type: Number, default: 0 },
  discount_reason: String,
  application_fee_paid: { type: Number, default: 0 },
  commitment_fee_paid: { type: Number, default: 0 },
  net_payable: { type: Number, required: true },   // snapshot of the fee maths at enrolment time
  balance_due: { type: Number, required: true },
  emi_count: { type: Number, default: 0 },
  manual_status: { type: String, enum: [null, 'Paused', 'Refunded', 'Dropped'], default: null },
  status_reason: String,
  agreement_file: String,
  original_currency: String,   // international students: INR stored, original kept for reference
  original_amount: Number,
  plan_history: [{ at: Date, by: String, reason: String, old: Array, _id: false }],
}, opts));
Enrollment.schema.index({ student: 1, batch: 1 }, { unique: true }); // same phone in same batch -> blocked

const Instalment = mongoose.model('Instalment', new Schema({
  enrollment: { ...ref('Enrollment'), required: true, index: true },
  batch: { ...ref('Batch'), index: true },
  type: { type: String, enum: ['Application fee', 'Commitment fee', 'EMI'], required: true },
  emi_number: Number,
  amount_due: { type: Number, required: true, min: 0 },
  due_date: { type: String, required: true },
  // amount_paid / paid_on are rebuilt from the payment ledger after every payment (never typed)
  amount_paid: { type: Number, default: 0 },
  paid_on: { type: String, default: null },
  waived: { type: Boolean, default: false },
  waive_reason: String,
  waived_by_status: { type: Boolean, default: false },
}, opts));

const Payment = mongoose.model('Payment', new Schema({
  enrollment: { ...ref('Enrollment'), required: true, index: true },
  batch: { ...ref('Batch'), index: true },
  allocations: [{ instalment: ref('Instalment'), amount: Number, _id: false }],
  amount: { type: Number, required: true }, // negative for reversals
  payment_date: { type: String, required: true },
  mode: { type: String, required: true },
  transaction_ref: String,                  // legacy, no longer collected
  screenshot: String,
  note: String,
  original_currency: String,
  original_amount: Number,
  recorded_by: ref('User'),
  recorded_by_name: String,
  verified: { type: Boolean, default: false },
  verified_by: String,
  verified_at: Date,
  reversal_of: ref('Payment'),
  reversal_reason: String,
  imported: { type: Boolean, default: false },
}, opts));

const ReminderLog = mongoose.model('ReminderLog', new Schema({
  instalment: { ...ref('Instalment'), required: true, index: true },
  enrollment: { ...ref('Enrollment'), index: true },
  channel: { type: String, enum: ['WhatsApp', 'Call', 'Email'], required: true },
  sent_by: ref('User'),
  sent_by_name: String,
  sent_at: { type: Date, default: Date.now },
  outcome: { type: String, enum: ['Sent', 'Paid', 'Will pay on date', 'No answer', 'Asked for extension', 'Dispute'], default: 'Sent' },
  promised_date: String,
  notes: String,
}, opts));

const ActivityLog = mongoose.model('ActivityLog', new Schema({
  user: ref('User'),
  user_name: String,
  entity: String,
  entity_id: String,
  action: String,
  changes: Schema.Types.Mixed,
  reason: String,
}, opts));
ActivityLog.schema.index({ createdAt: -1 });
ActivityLog.schema.index({ entity_id: 1, createdAt: -1 });
ActivityLog.schema.index({ entity: 1, action: 1, createdAt: -1 });
ReminderLog.schema.index({ sent_at: -1 });

const Setting = mongoose.model('Setting', new Schema({
  key: { type: String, unique: true, default: 'main' },
  payment_modes: [String],
  reminder: { days_before: Number, grace_days: Number, defaulter_days: Number },
  discount_limit: { type: Number, default: 10000 },
  payment_link_base: { type: String, default: '' },
  templates: Schema.Types.Mixed,
}, opts));

module.exports = { User, Program, Batch, Student, AdjustmentType, Enrollment, Instalment, Payment, ReminderLog, ActivityLog, Setting };

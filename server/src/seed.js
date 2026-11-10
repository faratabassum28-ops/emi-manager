// Usage:  npm run seed            -> admin user, SUPER + RGM programs, adjustment list, default settings
//         npm run seed -- --demo  -> additionally creates a demo batch with sample students
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Program, Batch, AdjustmentType, Setting } = require('./models');
const { DEFAULTS } = require('./services/settings');
const { todayIST, addDays, addMonths } = require('./lib/dates');
const E = require('./lib/emi');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/emi_manager');
  await mongoose.syncIndexes();

  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  let admin = await User.findOne({ email });
  if (!admin) {
    admin = await User.create({ name: process.env.SEED_ADMIN_NAME || 'Admin', email, password_hash: await bcrypt.hash(password, 10), role: 'Admin', can_verify: true });
    console.log(`Created admin ${email}${process.env.SEED_ADMIN_PASSWORD ? '' : ` with the default password "${password}" - change it after first login`}`);
  }

  // Ticket sizes come from the spec; application/commitment defaults are left at 0 (an open question in the spec).
  for (const p of [{ code: 'SUPER', name: 'SUPER', default_fee: 250000 }, { code: 'RGM', name: 'RGM (Reiki Grand Master L4/L5)', default_fee: 120000 }]) {
    await Program.updateOne({ code: p.code }, { $setOnInsert: { ...p, max_emis: 12 } }, { upsert: true });
  }
  const super_ = await Program.findOne({ code: 'SUPER' });
  // Only Tarot L1 (10,000) and Reiki L1+L2 (6,999) amounts are given in the spec; set the others in Settings.
  const types = [['Tarot L1', 10000], ['Reiki L1+L2', 6999], ['Tarot L2', 0], ['Reiki L3', 0], ['Numerology L1', 0]];
  for (const [name, amt] of types) {
    await AdjustmentType.updateOne({ name }, { $setOnInsert: { name, default_amount: amt, active: true, target_programs: [super_._id] } }, { upsert: true });
  }
  await Setting.updateOne({ key: 'main' }, { $setOnInsert: { key: 'main', ...DEFAULTS } }, { upsert: true });
  console.log('Programs, adjustment list and settings are in place.');

  if (process.argv.includes('--demo')) await demo(admin, super_);
  await mongoose.disconnect();
}

async function demo(admin, program) {
  const money = require('./services/money');
  if (await Batch.exists({ code: 'SUPER-B01' })) return console.log('Demo batch already exists, skipping.');
  const batch = await Batch.create({ code: 'SUPER-B01', program: program._id, batch_name: 'Demo Batch - Oct 2026', status: 'Running', owner: admin._id });
  const today = todayIST();
  // [name, first EMI offset in days from today, EMIs paid, partial amount on next]
  const people = [
    ['Asha Verma', -150, 6, 0], ['Rohan Mehta', -65, 2, 0], ['Priya Nair', -40, 1, 0],
    ['Karan Shah', -75, 2, 0], ['Meera Iyer', -35, 1, 10000], ['Vikram Rao', -5, 0, 0], ['Sana Khan', 12, 0, 0],
  ];
  let n = 0;
  for (const [name, offset, paidCount, partial] of people) {
    const total = 250000, adj = [{ name: 'Tarot L1', amount: 10000 }, { name: 'Reiki L1+L2', amount: 6999 }];
    const fees = E.computeFees({ total_fee: total, adjustments: adj, application_fee: 10000, commitment_fee: 40000 });
    const emis = E.autoSplit(fees.balance_due, 6, addDays(today, offset));
    // dates must be ascending and a paid EMI must be in the past for the demo to make sense
    const emi_paid = emis.map((e, i) => (i < paidCount ? e.amount_due : i === paidCount && partial ? partial : 0));
    await money.createEnrollment(admin, {
      batch: batch._id, student: { full_name: name, phone: `+9198000${String(10000 + n++)}`, email: `${name.split(' ')[0].toLowerCase()}@example.com` },
      adjustments: adj, application: { amount: 10000, date: addDays(today, offset - 20) }, commitment: { amount: 40000, date: addDays(today, offset - 10) },
      enrollment_date: addDays(today, offset - 20), emis, emi_paid, total_fee: total,
    }, { imported: true });
  }
  console.log(`Demo batch created with ${people.length} students.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

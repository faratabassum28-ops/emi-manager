// A tiny in-memory stand-in for the Mongoose models, just enough for services/money.js.
// Lets the payment / enrollment workflows be tested without a MongoDB server.
let seq = 0;
const newId = () => String(++seq).padStart(24, '0');
const same = (a, b) => String(a) === String(b);

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, v]) => {
    const val = k.includes('.') ? doc[k.split('.')[0]] && [].concat(doc[k.split('.')[0]]).map((x) => x[k.split('.')[1]]) : doc[k];
    if (v && typeof v === 'object' && !(v instanceof RegExp) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.map(String).includes(String(val));
      if ('$ne' in v) return !same(val, v.$ne);
      if ('$exists' in v) return v.$exists ? val !== undefined : val === undefined;
      if ('$gt' in v) return val > v.$gt;
    }
    if (Array.isArray(val)) return val.some((x) => same(x, v));
    return same(val, v);
  });
}

function collection(defaults = () => ({})) {
  const rows = [];
  const wrap = (d) => {
    if (!d) return d;
    Object.defineProperty(d, 'save', { value: async () => d, enumerable: false, configurable: true });
    Object.defineProperty(d, 'toObject', { value: () => ({ ...d }), enumerable: false, configurable: true });
    return d;
  };
  const make = (data) => wrap({ _id: newId(), createdAt: new Date(), ...defaults(), ...data });
  const chain = (list, single) => {
    const o = {
      sort(spec) { const [k, dir] = Object.entries(spec || {})[0] || []; if (k) list = [...list].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === -1 ? -1 : 1)); return o; },
      limit(n) { list = list.slice(0, n); return o; },
      populate() { return o; }, lean() { return o; }, select() { return o; },
      then(res, rej) { return Promise.resolve(single ? list[0] || null : list).then(res, rej); },
    };
    return o;
  };
  const applyUpdate = (d, upd) => {
    const { $set, $unset, $push, ...plain } = upd;
    Object.assign(d, plain, $set || {});
    for (const k of Object.keys($unset || {})) delete d[k];
    for (const [k, v] of Object.entries($push || {})) d[k] = [...(d[k] || []), v];
  };
  return {
    rows,
    create: async (data) => { const d = make(data); rows.push(d); return d; },
    insertMany: async (list) => list.map((data) => { const d = make(data); rows.push(d); return d; }),
    find: (f) => chain(rows.filter((d) => matches(d, f))),
    findOne: (f) => chain(rows.filter((d) => matches(d, f)), true),
    findById: (id) => chain(rows.filter((d) => same(d._id, id)), true),
    exists: async (f) => (rows.find((d) => matches(d, f)) ? { _id: 1 } : null),
    distinct: async (path, f) => [...new Set(rows.filter((d) => matches(d, f)).flatMap((d) => [].concat(d[path.split('.')[0]] || []).map((x) => (path.includes('.') ? x[path.split('.')[1]] : x))))],
    updateOne: async (f, upd) => { const d = rows.find((x) => matches(x, f)); if (d) applyUpdate(d, upd); },
    updateMany: async (f, upd) => { rows.filter((x) => matches(x, f)).forEach((d) => applyUpdate(d, upd)); },
    deleteOne: async (f) => { const i = rows.findIndex((x) => matches(x, f)); if (i >= 0) rows.splice(i, 1); },
    deleteMany: async (f) => { for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], f)) rows.splice(i, 1); },
    bulkWrite: async (ops) => { for (const { updateOne } of ops) { const d = rows.find((x) => matches(x, updateOne.filter)); if (d) applyUpdate(d, updateOne.update); } },
    countDocuments: async (f) => rows.filter((d) => matches(d, f)).length,
  };
}

function buildModels() {
  return {
    Student: collection(),
    Batch: collection(),
    Enrollment: collection(() => ({ adjustments: [], plan_history: [], manual_status: null, discount: 0 })),
    Instalment: collection(() => ({ amount_paid: 0, paid_on: null, waived: false, waived_by_status: false })),
    Payment: collection(() => ({ verified: false, allocations: [] })),
    ActivityLog: collection(),
    ReminderLog: collection(),
    User: collection(), Program: collection(), AdjustmentType: collection(), Setting: collection(),
  };
}

module.exports = { buildModels };

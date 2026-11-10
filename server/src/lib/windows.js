// Time windows for dashboards (dates are 'YYYY-MM-DD' strings in Asia/Kolkata, same as the rest of the app).
const { addDays, addMonths, diffDays } = require('./dates');

const WINDOWS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7_days', 'Last 7 days'], ['this_week', 'This week'], ['last_week', 'Last week'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months'], ['this_year', 'This year'], ['all_time', 'All time'], ['custom', 'Custom range'],
];

const dow = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = Sunday
const mondayOf = (s) => addDays(s, -((dow(s) + 6) % 7));
const firstOfMonth = (s) => `${s.slice(0, 7)}-01`;

// Returns { key, start, end, days, partial } or null for an unknown key / bad custom range. start=null means "all time".
function resolveWindow(key, today, custom = {}) {
  let start; let end;
  switch (key) {
    case 'today': start = end = today; break;
    case 'yesterday': start = end = addDays(today, -1); break;
    case 'last_7_days': start = addDays(today, -6); end = today; break;
    case 'this_week': start = mondayOf(today); end = today; break;
    case 'last_week': start = addDays(mondayOf(today), -7); end = addDays(mondayOf(today), -1); break;
    case 'this_month': start = firstOfMonth(today); end = today; break;
    case 'last_month': { const f = addMonths(firstOfMonth(today), -1); start = f; end = addDays(firstOfMonth(today), -1); break; }
    case 'last_3_months': start = addMonths(firstOfMonth(today), -2); end = today; break;
    case 'this_year': start = `${today.slice(0, 4)}-01-01`; end = today; break;
    case 'all_time': return { key, start: null, end: null, days: null, partial: false };
    case 'custom':
      if (!custom.from || !custom.to || custom.from > custom.to) return null;
      start = custom.from; end = custom.to; break;
    default: return null;
  }
  return { key, start, end, days: diffDays(end, start) + 1, partial: end >= today };
}

// The equal-length window straight before this one (null for all time).
function previousWindow(w) {
  if (!w || !w.start) return null;
  return { key: 'previous', start: addDays(w.start, -w.days), end: addDays(w.start, -1), days: w.days, partial: false };
}

const inWindow = (date, w) => !w || !w.start || (date >= w.start && date <= w.end);

module.exports = { WINDOWS, resolveWindow, previousWindow, inWindow, mondayOf };

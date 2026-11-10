// All dates in this app are plain 'YYYY-MM-DD' strings in Asia/Kolkata.
// Strings avoid every timezone/DST bug and compare correctly with < and >.

const pad = (n) => String(n).padStart(2, '0');

function todayIST(now = Date.now()) {
  return new Date(now + 330 * 60000).toISOString().slice(0, 10);
}

function toMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(toMs(s)).toISOString().slice(0, 10) === s;
}

// a - b in whole days
function diffDays(a, b) {
  return Math.round((toMs(a) - toMs(b)) / 86400000);
}

function addDays(s, n) {
  return new Date(toMs(s) + n * 86400000).toISOString().slice(0, 10);
}

// Always counted from the first date (not chained) so 31 Jan -> 28 Feb -> 31 Mar, no drift.
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = m - 1 + n;
  const yy = y + Math.floor(t / 12);
  const mm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${pad(mm + 1)}-${pad(Math.min(d, last))}`;
}

const monthKey = (s) => s.slice(0, 7);

function nextMonthKey(s) {
  return monthKey(addMonths(`${monthKey(s)}-01`, 1));
}

module.exports = { todayIST, isValidDate, diffDays, addDays, addMonths, monthKey, nextMonthKey };

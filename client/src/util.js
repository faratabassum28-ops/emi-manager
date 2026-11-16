import { useEffect, useState, useCallback } from 'react';

export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dates are 'YYYY-MM-DD' strings in Asia/Kolkata, shown as DD MMM YYYY
export const fmtDate = (s) => {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
};
export const fmtMonth = (k) => {
  const [y, m] = k.split('-');
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
};
export const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 330 * 60000).toISOString();
  return `${fmtDate(ist.slice(0, 10))}, ${ist.slice(11, 16)}`;
};
export const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = m - 1 + n;
  const yy = y + Math.floor(t / 12);
  const mm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// Same rule as the server: equal split, rupee remainder on the last EMI
export function autoSplit(balance, count, firstDate) {
  if (!count || count < 1 || !firstDate) return [];
  const base = Math.floor(balance / count);
  const rem = balance - base * count;
  return Array.from({ length: count }, (_, i) => ({ amount_due: i === count - 1 ? base + rem : base, due_date: addMonths(firstDate, i) }));
}

export const waChat = (phone) => `https://wa.me/${String(phone).replace(/\D/g, '')}`;

export const STATUS_TONE = {
  'Paid on time': 'green', Completed: 'green', Active: 'green', 'On time': 'green',
  'Due soon': 'amber', 'Partially paid': 'amber', Late: 'amber', 'Paid late': 'amber',
  'Due today': 'blue', Overdue: 'red', Defaulter: 'red',
  Upcoming: 'gray', Waived: 'gray', Paused: 'gray', Dropped: 'gray', Refunded: 'gray',
};

export function useFetch(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch((e) => live && setState({ data: null, loading: false, error: e.message }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/* ---------- helpers ported from Order Analytics ---------- */
export const WINDOWS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7_days', 'Last 7 days'], ['this_week', 'This week'], ['last_week', 'Last week'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months'], ['this_year', 'This year'], ['all_time', 'All time'], ['custom', 'Custom range'],
];

// Search boxes wait for a pause in typing.
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// A piece of state remembered between visits (filters, last-used tab).
export function useStored(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(`emi_${key}`); return s === null ? initial : JSON.parse(s); } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(`emi_${key}`, JSON.stringify(v)); } catch { /* private mode */ } }, [key, v]);
  return [v, setV];
}

// Re-run a loader whenever something in the app changes data (see api.js) and every `every` ms while the tab is visible.
export function useLiveReload(reload, every = 60000) {
  useEffect(() => {
    const on = () => reload();
    window.addEventListener('data-changed', on);
    const t = every ? setInterval(() => { if (!document.hidden) reload(); }, every) : null;
    return () => { window.removeEventListener('data-changed', on); if (t) clearInterval(t); };
  }, [reload, every]);
}

export function relTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days} d ago` : fmtDate(new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10));
}

export const istTime = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(11, 16);
export const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);

// Change vs the previous window: relative % for money/counts.
export function delta(cur, prev) {
  if (prev === null || prev === undefined) return null;
  if (prev === 0) return cur === 0 ? { diff: 0, text: '0%' } : { diff: 1, text: 'new' };
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  return { diff: d, text: `${Math.abs(d).toFixed(0)}%` };
}

// Download rows as a CSV file (opens fine in Excel / Google Sheets).
export function exportCsv(name, head, rows) {
  const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = '\ufeff' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const rupeesInWords = (n) => {
  n = Math.round(Number(n) || 0);
  if (!n) return 'Zero rupees only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x) => (x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : ''));
  const parts = [];
  const cr = Math.floor(n / 1e7); n %= 1e7;
  const lk = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1e3); n %= 1e3;
  const hu = Math.floor(n / 100); const rest = n % 100;
  if (cr) parts.push(two(cr) + ' Crore');
  if (lk) parts.push(two(lk) + ' Lakh');
  if (th) parts.push(two(th) + ' Thousand');
  if (hu) parts.push(ones[hu] + ' Hundred');
  if (rest) parts.push((parts.length ? 'and ' : '') + two(rest));
  return parts.join(' ') + ' rupees only';
};

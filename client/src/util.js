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

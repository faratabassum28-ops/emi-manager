import { useState } from 'react';
import { api } from '../api';
import { useDebounced, useFetch, useLiveReload, useStored } from '../util';
import { ErrorBox, Loading, Empty, Timeline, Seg, Pager } from '../components/ui';
import FilterBar, { useWindow } from '../components/FilterBar';
import { fmtDateTime } from '../util';

const ACTIONS = [['', 'Any action'], ['create', 'Created'], ['reverse', 'Reversed'], ['verify', 'Verified'], ['restructure', 'Plan restructured'], ['reschedule', 'Date moved'], ['status', 'Status changed'], ['waive', 'Waived'], ['update', 'Edited'], ['call', 'Calls'], ['whatsapp', 'WhatsApp']];

export default function ActivityPage() {
  const win = useWindow('activity_window', 'all_time');
  const [view, setView] = useStored('activity_view', 'timeline');
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);

  const qs = (extra = '') => {
    const p = new URLSearchParams();
    if (entity) p.set('entity', entity);
    if (action) p.set('action', action);
    if (user) p.set('user', user);
    if (dq) p.set('q', dq);
    const w = windowDates(win);
    if (w.from) p.set('from', w.from);
    if (w.to) p.set('to', w.to);
    return `${p.toString()}${extra}`;
  };
  const url = `/activity?${qs(`&page=${page}&limit=50`)}`;
  const { data, loading, error, reload } = useFetch(() => api.get(url), [url]);
  useLiveReload(reload, 60000);
  const reset = (fn) => (v) => { fn(v); setPage(1); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <>
      <FilterBar win={{ ...win, set: (patch) => { win.set(patch); setPage(1); } }} range={null}>
        <button onClick={() => api.download(`/activity/export?${qs()}`, 'activity.csv').catch((e) => alert(e.message))}>Download CSV</button>
      </FilterBar>
      <div className="page-head"><div><h1>Activity log</h1><div className="muted">Everything that was created, paid, changed, reversed or followed up: who, when, and why.{data ? ` ${data.total} entries.` : ''}</div></div>
        <div className="actions"><Seg options={[['timeline', 'Timeline'], ['table', 'Table']]} value={view} onChange={setView} /></div></div>

      <div className="filterbar">
        <input style={{ maxWidth: 240 }} placeholder="Search student, person, reason…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select value={entity} onChange={(e) => reset(setEntity)(e.target.value)} aria-label="Type"><option value="">All types</option>{(data ? data.entities : []).map((x) => <option key={x}>{x}</option>)}</select>
        <select value={action} onChange={(e) => reset(setAction)(e.target.value)} aria-label="Action">{ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={user} onChange={(e) => reset(setUser)(e.target.value)} aria-label="Person"><option value="">Everyone</option>{(data ? data.users : []).map((x) => <option key={x}>{x}</option>)}</select>
        {(entity || action || user || q) && <button className="link" onClick={() => { setEntity(''); setAction(''); setUser(''); setQ(''); setPage(1); }}>Clear filters</button>}
      </div>

      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (
        <>
          {view === 'timeline' ? (
            <div className="card">{data.items.length ? <Timeline events={data.items} showStudent /> : <Empty>Nothing matches these filters.</Empty>}</div>
          ) : (
            <div className="table-wrap"><table>
              <thead><tr><th>When</th><th>Who</th><th>Student</th><th>Type</th><th>What happened</th><th>Details</th><th>Reason</th></tr></thead>
              <tbody>{data.items.map((e) => (
                <tr key={e.id}><td>{fmtDateTime(e.at)}</td><td>{e.by}</td><td>{e.student || '—'}{e.batch ? <span className="muted"> · {e.batch}</span> : ''}</td><td>{e.entity}</td><td className="wrap"><b>{e.label}</b></td><td className="wrap">{e.detail}</td><td className="wrap">{e.reason}</td></tr>))}</tbody>
            </table>{!data.items.length && <Empty>Nothing matches these filters.</Empty>}</div>
          )}
          <Pager page={page} pages={pages} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

// The server filters by IST calendar days; turn the chosen window into from/to.
function windowDates(win) {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const add = (s, n) => new Date(Date.parse(s) + n * 864e5).toISOString().slice(0, 10);
  const monday = (s) => add(s, -((new Date(Date.parse(s)).getUTCDay() + 6) % 7));
  const first = (s) => `${s.slice(0, 7)}-01`;
  switch (win.window) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: add(today, -1), to: add(today, -1) };
    case 'last_7_days': return { from: add(today, -6), to: today };
    case 'this_week': return { from: monday(today), to: today };
    case 'last_week': return { from: add(monday(today), -7), to: add(monday(today), -1) };
    case 'this_month': return { from: first(today), to: today };
    case 'last_month': { const f = first(add(first(today), -1)); return { from: f, to: add(first(today), -1) }; }
    case 'last_3_months': { let f = first(today); for (let i = 0; i < 2; i++) f = first(add(f, -1)); return { from: f, to: today }; }
    case 'this_year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom': return win.from && win.to && win.from <= win.to ? { from: win.from, to: win.to } : {};
    default: return {};
  }
}

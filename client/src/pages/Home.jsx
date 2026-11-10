import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, fmtMonth, useFetch, useLiveReload } from '../util';
import { Kpi, Loading, ErrorBox, Empty, DeltaChip, Timeline } from '../components/ui';
import FilterBar, { useWindow } from '../components/FilterBar';
import StudentDrawer from '../components/StudentDrawer';

function Stat({ label, cur, prev, fmt = (v) => v, sub, up = 'good', tone }) {
  return (
    <div className={`kpi delta ${tone || ''}`}>
      <div className="kpi-top"><span className="kpi-label">{label}</span><DeltaChip cur={cur} prev={prev} up={up} /></div>
      <span className="kpi-value">{fmt(cur)}</span>
      <span className="kpi-sub">{sub || ' '}</span>
    </div>
  );
}

export default function Home() {
  const { can } = useAuth();
  const win = useWindow();
  const [open, setOpen] = useState(null);
  const { data, loading, error, reload } = useFetch(() => api.get('/home'));
  const ins = useFetch(() => (win.ready ? api.get(`/insights?${win.params}`) : Promise.resolve(null)), [win.params, win.ready]);
  const feed = useFetch(() => (can.manage ? api.get('/activity?limit=8') : Promise.resolve(null)), [can.manage]);
  useLiveReload(() => { reload(); ins.reload(); feed.reload(); }, 60000);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const t = data.totals;
  const c = ins.data && ins.data.current;
  const p = ins.data && ins.data.prior;
  const chart = ins.data ? ins.data.series.map((s) => ({ ...s, label: ins.data.unit === 'month' ? fmtMonth(s.key) : s.key.slice(8) + '/' + s.key.slice(5, 7) })) : [];

  return (
    <>
      <FilterBar win={win} range={ins.data && ins.data.window} />
      <div className="page-head"><div><h1>Home</h1><div className="muted">All programs · today is {fmtDate(data.today)}</div></div></div>

      <ErrorBox error={ins.error} onRetry={ins.reload} />
      {!win.ready && <div className="banner warn">Pick both dates for the custom range.</div>}
      {c && (
        <>
          <h2>In this period <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>change is against the {ins.data.window.days}-day window before it</span></h2>
          <div className="grid kpis">
            <Stat label="Collected" cur={c.collected} prev={p && p.collected} fmt={inr} tone="green" sub={c.reversed ? `after ${inr(c.reversed)} reversed` : `${c.payments} payments`} />
            <Stat label="Payments received" cur={c.payments} prev={p && p.payments} sub={c.payments ? `avg ${inr(c.avg_payment)}` : ''} />
            <Stat label="New enrollments" cur={c.new_enrollments} prev={p && p.new_enrollments} sub={c.new_enrollments ? `${inr(c.enrolled_value)} contract value` : ''} />
            <Stat label="Follow-ups logged" cur={c.followups} prev={p && p.followups} sub={`${c.calls} calls · ${c.promises} promises`} />
          </div>
          <div className="grid two" style={{ marginTop: 14 }}>
            <div className="card">
              <h2>Collections {ins.data.unit === 'month' ? 'by month' : 'by day'}</h2>
              {chart.some((x) => x.collected) ? (
                <div className="chart-box" style={{ height: 220 }}><ResponsiveContainer><BarChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" minTickGap={18} /><YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v) => inr(v)} labelFormatter={(l) => l} /><Bar dataKey="collected" name="Collected" fill="#5b47d6" radius={[3, 3, 0, 0]} />
                </BarChart></ResponsiveContainer></div>
              ) : <Empty>No payments in this period.</Empty>}
            </div>
            <div className="card">
              <h2>By payment mode</h2>
              {c.by_mode.length ? c.by_mode.map((m) => (
                <div key={m.mode} style={{ marginBottom: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span>{m.mode}</span><b>{inr(m.amount)}</b></div>
                  <div className="bars" style={{ height: 8, alignItems: 'stretch' }}><i style={{ flex: `0 0 ${Math.max(2, (m.amount / c.by_mode[0].amount) * 100)}%`, borderRadius: 4 }} /></div>
                </div>
              )) : <Empty>No payments in this period.</Empty>}
            </div>
          </div>
        </>
      )}

      <h2 style={{ marginTop: 22 }}>Right now</h2>
      <div className="grid kpis">
        <Kpi label="Collected this month" value={inr(t.collected_this_month)} tone="green" />
        <Kpi label="Due this month" value={inr(t.due_this_month)} />
        <Kpi label="Overdue now" value={inr(t.overdue_amount)} sub={`${t.overdue_count} instalments`} tone="red" />
        <Kpi label="Collection rate" value={t.collection_rate === null ? '—' : `${t.collection_rate}%`} sub="EMI collected ÷ EMI due this month" />
        <Kpi label="Active students" value={t.students} />
      </div>

      <div className="grid two" style={{ marginTop: 22, alignItems: 'start' }}>
        <div>
          <h2>Today's list · EMIs due today ({data.today_list.length})</h2>
          {data.today_list.length ? (
            <div className="upnext">{data.today_list.slice(0, 12).map((r) => (
              <div key={r.instalment_id} className="it" onClick={() => setOpen(r.enrollment_id)}>
                <span><b>{r.student_name}</b> <span className="muted">· {r.program} · {r.batch_name} · EMI {r.emi_number} of {r.emi_total}</span></span><b>{inr(r.balance)}</b>
              </div>))}
              {data.today_list.length > 12 && <Link to="/tracker">See all {data.today_list.length} in the EMI Tracker →</Link>}
            </div>
          ) : <div className="card"><Empty>Nothing due today.</Empty></div>}
        </div>
        {can.manage && (
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Latest activity</h2><Link to="/activity">View all →</Link></div>
            {feed.data ? <Timeline events={feed.data.items} showStudent /> : <Loading />}
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 22 }}>Batches · worst overdue first</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Program</th><th>Batch</th><th className="num">Students</th><th className="num">Outstanding</th><th className="num">Overdue</th><th className="num">Overdue #</th><th className="num">Collected %</th></tr></thead>
          <tbody>
            {data.batches.map((b) => (
              <tr key={b.batch_id}>
                <td>{b.program}</td>
                <td><Link to={`/p/${b.program_id}/${b.batch_id}`}>{b.batch_name}</Link></td>
                <td className="num">{b.students}</td>
                <td className="num">{inr(b.outstanding)}</td>
                <td className={`num ${b.overdue_amount ? 'red-text' : ''}`}>{inr(b.overdue_amount)}</td>
                <td className="num">{b.overdue_count}</td>
                <td className="num">{b.collection_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.batches.length && <Empty>No batches yet. An Admin or Manager can create one in Settings.</Empty>}
      </div>
      {open && <StudentDrawer enrollmentId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

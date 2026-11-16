import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Donut, HBars, Ring } from '../components/Charts';
import Icon from '../components/Icon';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, fmtMonth, useFetch, useLiveReload } from '../util';
import { Kpi, Loading, ErrorBox, Empty, DeltaChip, Timeline, Meter, RiskPill } from '../components/ui';
import FilterBar, { useWindow } from '../components/FilterBar';
import StudentDrawer from '../components/StudentDrawer';

const SPLIT_COLORS = { on_time: 'var(--good)', late: 'var(--warn)', overdue: 'var(--bad)', defaulter: '#8e2b8e', completed: 'var(--accent)' };
const greet = () => { const h = new Date(Date.now() + 330 * 60000).getUTCHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const firstName = (n) => String(n || 'there').split(' ')[0];

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
  const { can, user } = useAuth();
  const win = useWindow();
  const [open, setOpen] = useState(null);
  const { data, loading, error, reload } = useFetch(() => api.get('/home'));
  const ins = useFetch(() => (win.ready ? api.get(`/insights?${win.params}`) : Promise.resolve(null)), [win.params, win.ready]);
  const feed = useFetch(() => (can.manage ? api.get('/activity?limit=8') : Promise.resolve(null)), [can.manage]);
  useLiveReload(() => { reload(); ins.reload(); feed.reload(); }, 60000);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const t = data.totals;
  const fc = data.forecast;
  const split = (data.status_split || []).filter((x) => x.value > 0);
  const c = ins.data && ins.data.current;
  const p = ins.data && ins.data.prior;
  const chart = ins.data ? ins.data.series.map((s) => ({ ...s, label: ins.data.unit === 'month' ? fmtMonth(s.key) : s.key.slice(8) + '/' + s.key.slice(5, 7) })) : [];

  return (
    <>
      <FilterBar win={win} range={ins.data && ins.data.window} />
      <div className="hero">
        <div>
          <h1>{greet()}, {firstName(user && user.name)} 👋</h1>
          <div className="muted">All programs · today is {fmtDate(data.today)}</div>
          <div className="pill-row" style={{ marginTop: 10 }}>
            {t.overdue_count > 0 && <Link className="chip bad" to="/tracker?filter=overdue"><Icon name="alert" size={13} /> {t.overdue_count} overdue · {inr(t.overdue_amount)}</Link>}
            {t.broken_promises > 0 && <Link className="chip warn" to="/tracker?filter=broken"><Icon name="flame" size={13} /> {t.broken_promises} broken promises</Link>}
            {!!data.today_list.length && <Link className="chip good" to="/tracker?filter=today"><Icon name="calendar" size={13} /> {data.today_list.length} due today</Link>}
          </div>
        </div>
        {t.collection_pct != null && <Ring pct={t.collection_pct} label={`${t.collection_pct}%`} sub="collected" />}
      </div>

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
                <BarChart height={220} data={chart.map((x) => ({ label: x.label, values: [x.collected] }))} series={[{ name: 'Collected', color: 'var(--accent)' }]} fmt={inr} />
              ) : <Empty>No payments in this period.</Empty>}
            </div>
            <div className="card">
              <h2>By payment mode</h2>
              {c.by_mode.length ? <HBars rows={c.by_mode.map((m) => ({ label: m.mode, value: m.amount }))} color="var(--accent)" /> : <Empty>No payments in this period.</Empty>}
            </div>
          </div>
        </>
      )}

      <h2 style={{ marginTop: 22 }}>Right now</h2>
      <div className="grid kpis">
        <Kpi icon="wallet" label="Collected this month" value={inr(t.collected_this_month)} tone="green" />
        <Kpi icon="calendar" label="Due this month" value={inr(t.due_this_month)} />
        <Kpi icon="alert" label="Overdue now" value={inr(t.overdue_amount)} sub={`${t.overdue_count} instalments`} tone="red" />
        <Kpi icon="target" label="Collection rate" value={t.collection_rate === null || t.collection_rate === undefined ? '—' : `${t.collection_rate}%`} sub="EMI collected ÷ EMI due this month" />
        <Kpi icon="users" label="Active students" value={t.students} />
        {t.broken_promises !== undefined && <Kpi icon="flame" label="Broken promises" value={t.broken_promises} tone={t.broken_promises ? 'red' : ''} sub="promised date passed, unpaid" />}
      </div>

      {(fc || split.length > 0) && (
        <div className="grid two" style={{ marginTop: 22 }}>
          {fc && fc.weeks && (
            <div className="card">
              <h2>Cash-flow forecast · next 8 weeks</h2>
              <div className="pill-row">{[['Overdue', fc.overdue, 'bad'], ['Next 7 days', fc.d7, 'good'], ['30 days', fc.d30, 'good'], ['90 days', fc.d90, 'good']].map(([l, v, tn]) => <span key={l} className={`chip ${tn}`}>{l}: {inr(v)}</span>)}</div>
              <div style={{ marginTop: 10 }}><BarChart height={180} fmt={inr} data={fc.weeks.map((w) => ({ label: fmtDate(w.from).slice(0, 6), values: [w.amount], tip: `${w.count || 0} instalments` }))} series={[{ name: 'Expected', color: 'var(--accent)' }]} /></div>
            </div>
          )}
          {split.length > 0 && (
            <div className="card">
              <h2>Student status</h2>
              <Donut slices={split.map((x) => ({ ...x, color: SPLIT_COLORS[x.key] }))} center={{ value: t.students, label: 'students' }} />
            </div>
          )}
        </div>
      )}

      {data.focus && data.focus.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>Call these first <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>ranked by priority score</span></h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Student</th><th>Program</th><th className="num">Days late</th><th className="num">Balance</th><th>Priority</th><th /></tr></thead>
              <tbody>{data.focus.map((r) => (
                <tr key={r.instalment_id}>
                  <td><button className="link" onClick={() => setOpen(r.enrollment_id)}>{r.student_name}</button>{r.broken_promise && <span className="chip warn" style={{ marginLeft: 6 }}>broke promise</span>}</td>
                  <td className="muted">{r.program} · {r.batch_name}</td>
                  <td className="num">{r.days_overdue}</td>
                  <td className="num">{inr(r.balance)}</td>
                  <td><RiskPill risk={r.risk} score={r.priority} /></td>
                  <td><a className="btn small" href={`tel:${r.phone}`}><Icon name="phone" size={13} /> Call</a></td>
                </tr>))}</tbody>
            </table>
          </div>
        </>
      )}

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
          <thead><tr><th>Program</th><th>Batch</th><th className="num">Students</th><th className="num">Outstanding</th><th className="num">Overdue</th><th className="num">Overdue #</th><th>Collected</th></tr></thead>
          <tbody>
            {data.batches.map((b) => (
              <tr key={b.batch_id}>
                <td>{b.program}</td>
                <td><Link to={`/p/${b.program_id}/${b.batch_id}`}>{b.batch_name}</Link></td>
                <td className="num">{b.students}</td>
                <td className="num">{inr(b.outstanding)}</td>
                <td className={`num ${b.overdue_amount ? 'red-text' : ''}`}>{inr(b.overdue_amount)}</td>
                <td className="num">{b.overdue_count}</td>
                <td style={{ minWidth: 120 }}><Meter pct={b.collection_pct} tone="good" /> <span className="muted">{b.collection_pct}%</span></td>
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

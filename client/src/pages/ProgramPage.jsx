import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BarChart, Donut, HBars, Ring } from '../components/Charts';
import Icon from '../components/Icon';
import { useToast } from '../ui-context';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, fmtMonth, useFetch, useDebounced, useLiveReload } from '../util';
import { Badge, Kpi, Tabs, Loading, ErrorBox, Empty, AuthFile } from '../components/ui';
import TrackerTable from '../components/TrackerTable';
import StudentDrawer from '../components/StudentDrawer';
import { RecordPayment } from '../components/Actions';

const TABS = [{ key: 'dashboard', label: 'Dashboard' }, { key: 'students', label: 'Students' }, { key: 'tracker', label: 'EMI Tracker' }, { key: 'payments', label: 'Payments' }];
const SPLIT_COLORS = { on_time: 'var(--good)', late: 'var(--warn)', overdue: 'var(--bad)', defaulter: '#8e2b8e', completed: 'var(--accent)' };

export default function ProgramPage() {
  const { programId, batchId, tab = 'dashboard' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const nav = useFetch(() => api.get('/nav'));
  const [pay, setPay] = useState(false);
  const [version, setVersion] = useState(0);

  if (nav.loading) return <Loading />;
  const program = (nav.data || []).find((p) => p._id === programId);
  if (!program) return <div className="empty">Program not found, or no batch of it is assigned to you.</div>;
  if (!batchId && program.batches.length) return <Navigate to={`/p/${programId}/${program.batches[program.batches.length - 1]._id}`} replace />;
  const batch = program.batches.find((b) => b._id === batchId);

  return (
    <>
      <div className="page-head">
        <div><h1>{program.name}</h1><div className="muted">{batch ? `${batch.batch_name} · ${batch.status}` : 'No batches yet'}</div></div>
        {batch && can.write && (
          <div className="actions">
            <Link className="btn primary" to={`/p/${programId}/${batchId}/enroll`}>+ New Enrollment</Link>
            <button className="primary" onClick={() => setPay(true)}>+ Record Payment</button>
          </div>
        )}
      </div>
      <div className="batch-tabs">{program.batches.map((b) => <Link key={b._id} to={`/p/${programId}/${b._id}`} className={b._id === batchId ? 'active' : ''}>{b.batch_name}</Link>)}</div>
      {!batch ? <Empty>{can.manage ? 'Create the first batch in Settings → Batches.' : 'No batch has been created for this program yet.'}</Empty> : (
        <>
          <Tabs tabs={TABS} value={tab} onChange={(k) => navigate(`/p/${programId}/${batchId}/${k}`)} />
          {tab === 'dashboard' && <Dashboard key={`${batchId}${version}`} batchId={batchId} base={`/p/${programId}/${batchId}`} />}
          {tab === 'students' && <Students key={batchId + version} batchId={batchId} />}
          {tab === 'tracker' && <TrackerTable key={batchId + version} batchId={batchId} />}
          {tab === 'payments' && <Payments key={batchId + version} batchId={batchId} />}
        </>
      )}
      {pay && <RecordPayment batchId={batchId} onClose={() => setPay(false)} onDone={() => { setPay(false); setVersion((v) => v + 1); }} />}
    </>
  );
}

/* ---------------- Dashboard (5.2 / 5.3) ---------------- */
function Dashboard({ batchId, base }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useFetch(() => api.get(`/batches/${batchId}/dashboard`), [batchId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const k = data.kpis;
  const fc = data.forecast;
  const go = (filter) => navigate(`${base}/students?filter=${filter}`);
  const split = k.status_split.filter((s) => s.value > 0);

  return (
    <>
      <div className="grid split" style={{ marginBottom: 14 }}>
        <div className="card" style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <Ring pct={k.collection_pct} label={`${k.collection_pct}%`} sub="collected" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2>Batch health</h2>
            <div className="hbar"><span className="label">Collected</span><span className="meter good"><i style={{ width: `${k.collection_pct}%` }} /></span><b>{inr(k.collected)}</b></div>
            <div className="hbar"><span className="label">Outstanding</span><span className="meter"><i style={{ width: `${100 - k.collection_pct}%` }} /></span><b>{inr(k.outstanding)}</b></div>
            <div className="hbar"><span className="label">Overdue now</span><span className="meter bad"><i style={{ width: `${k.outstanding ? Math.min(100, (k.overdue_amount / k.outstanding) * 100) : 0}%` }} /></span><b className={k.overdue_amount ? 'red-text' : ''}>{inr(k.overdue_amount)}</b></div>
          </div>
        </div>
        {fc && (
          <div className="card">
            <h2>Money coming in</h2>
            <div className="pill-row">{[['Next 7 days', fc.d7], ['30 days', fc.d30], ['60 days', fc.d60], ['90 days', fc.d90]].map(([l, v]) => <span key={l} className="chip good">{l}: {inr(v)}</span>)}</div>
            <div style={{ marginTop: 10 }}><BarChart height={150} data={fc.weeks.map((w) => ({ label: fmtDate(w.from).slice(0, 6), values: [w.amount], tip: `${w.count} instalments` }))} series={[{ name: 'Expected', color: 'var(--accent)' }]} /></div>
          </div>
        )}
      </div>

      <div className="grid kpis">
        <Kpi icon="users" label="Total students" value={k.total_students} sub={k.dropped ? `${k.dropped} dropped/refunded` : undefined} onClick={() => go('all')} />
        <Kpi icon="file" label="Total contract value" value={inr(k.contract_value)} />
        <Kpi icon="wallet" label="Collected so far" value={inr(k.collected)} tone="green" />
        <Kpi icon="rupee" label="Outstanding" value={inr(k.outstanding)} />
        <Kpi icon="calendar" label="Due this month" value={inr(k.due_this_month)} />
        <Kpi icon="trend" label="Collected this month" value={inr(k.collected_this_month)} tone="green" />
        <Kpi icon="alert" label="Overdue now" value={inr(k.overdue_amount)} sub={`${k.overdue_count} instalments`} tone="red" onClick={() => go('overdue_all')} />
        <Kpi icon="checkc" label="Paying on time" value={k.paying_on_time} onClick={() => go('on_time')} />
        <Kpi icon="clock" label="Paying late" value={k.paying_late} onClick={() => go('late')} />
        <Kpi icon="alert" label="Currently overdue" value={k.currently_overdue} tone={k.currently_overdue ? 'red' : ''} onClick={() => go('overdue_all')} />
        <Kpi icon="flame" label="Defaulters" value={k.defaulters} tone={k.defaulters ? 'red' : ''} onClick={() => go('defaulter')} />
        <Kpi icon="clock" label="Avg delay" value={`${k.avg_delay} d`} sub="across late-paid instalments" />
        <Kpi icon="check" label="Completed" value={k.completed} onClick={() => go('completed')} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Month-wise expected vs collected</h2>
          {k.monthly.length ? <BarChart data={k.monthly.map((m) => ({ label: fmtMonth(m.month), values: [m.expected, m.collected] }))} series={[{ name: 'Expected', color: 'var(--line-strong)' }, { name: 'Collected', color: 'var(--accent)' }]} /> : <Empty>No EMIs scheduled yet.</Empty>}
        </div>
        <div className="card">
          <h2>Student status <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>click a slice</span></h2>
          {split.length ? <Donut slices={split.map((s) => ({ ...s, color: SPLIT_COLORS[s.key] }))} center={{ value: k.total_students, label: 'students' }} onSlice={(s) => go(s.key || 'all')} /> : <Empty>No students yet.</Empty>}
        </div>
        <div className="card">
          <h2>Overdue ageing</h2>
          <BarChart height={200} data={k.ageing.map((a) => ({ label: a.label, values: [a.amount], tip: `${a.count} instalments` }))} series={[{ name: 'Overdue', color: 'var(--bad)' }]} onBar={() => go('overdue_all')} />
        </div>
        <div className="card">
          <h2>Collections by payment mode</h2>
          {k.by_mode.length ? <HBars rows={k.by_mode.map((m) => ({ label: m.mode, value: m.amount }))} color="var(--good)" /> : <Empty>No payments yet.</Empty>}
        </div>
      </div>
      {can.export && <p><button onClick={() => api.download(`/batches/${batchId}/export`, `batch-${batchId}.xlsx`).then(() => toast.push('Excel file downloaded')).catch((e) => toast.push(e.message, 'bad'))}><Icon name="download" size={15} /> Export batch to Excel</button></p>}
    </>
  );
}

/* ---------------- Students tab (5.4) ---------------- */
const FILTER_LABEL = { all: 'All', on_time: 'On time', late: 'Late', overdue: 'Overdue', overdue_all: 'Overdue + defaulters', defaulter: 'Defaulters', completed: 'Completed', dropped: 'Dropped / refunded' };
function Students({ batchId }) {
  const [sp, setSp] = useSearchParams();
  const filter = sp.get('filter') || 'all';
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [open, setOpen] = useState(null);
  const url = `/batches/${batchId}/students?${filter !== 'all' ? `filter=${filter}&` : ''}q=${encodeURIComponent(dq)}`;
  const { data, loading, error, reload } = useFetch(() => api.get(url), [url]);
  useLiveReload(reload, 60000);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="chips">{Object.entries(FILTER_LABEL).map(([k, l]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setSp(k === 'all' ? {} : { filter: k })}>{l}</button>)}</div>
        <input style={{ maxWidth: 240, marginLeft: 'auto' }} placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Phone</th><th className="num">Net payable</th><th className="num">Paid</th><th className="num">Balance</th><th>EMIs paid</th><th>Next due</th><th className="num">Next amount</th><th>Status</th></tr></thead>
          <tbody>{(data || []).map((s) => (
            <tr key={s.enrollment_id} className="click" onClick={() => setOpen(s.enrollment_id)}>
              <td>{s.name}</td><td>{s.phone}</td><td className="num">{inr(s.net_payable)}</td><td className="num">{inr(s.paid)}</td><td className="num">{inr(s.balance)}</td>
              <td>{s.emis_paid}/{s.emi_total}</td><td>{fmtDate(s.next_due_date)}</td><td className="num">{s.next_amount ? inr(s.next_amount) : '—'}</td><td><Badge status={s.status} />{s.max_days_overdue > 0 && <span className="red-text"> {s.max_days_overdue}d</span>}</td>
            </tr>))}</tbody>
        </table>{data && !data.length && <Empty>No students match.</Empty>}</div>
      )}
      {open && <StudentDrawer enrollmentId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ---------------- Payments tab (5.5) ---------------- */
function Payments({ batchId }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [mode, setMode] = useState('');
  const settings = useFetch(() => api.get('/settings'));
  const url = `/payments?batch=${batchId}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${mode ? `&mode=${encodeURIComponent(mode)}` : ''}`;
  const { data, loading, error, reload } = useFetch(() => api.get(url), [url]);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} /></label>
        <label className="row">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} /></label>
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: 200 }}><option value="">All modes</option>{(settings.data ? settings.data.payment_modes : []).map((m) => <option key={m}>{m}</option>)}</select>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Student</th><th className="num">Amount</th><th>Applied to</th><th>Mode</th><th>Note</th><th>Screenshot</th><th>Recorded by</th><th>Verified</th></tr></thead>
          <tbody>{(data || []).map((p) => (
            <tr key={p.id}>
              <td>{fmtDate(p.payment_date)}</td><td><Link to={`/enrollments/${p.enrollment_id}`}>{p.student}</Link></td>
              <td className={`num ${p.amount < 0 ? 'red-text' : ''}`}>{inr(p.amount)}</td><td>{p.applied_to}</td><td>{p.mode}</td>
              <td>{p.reversal_of ? 'Reversal' : p.note}{p.reversed && <span className="badge b-red"> reversed</span>}</td>
              <td><AuthFile file={p.screenshot} paymentId={p.id} /></td><td>{p.recorded_by}</td><td>{p.verified ? <span className="ok">✓ {p.verified_by}</span> : <span className="muted">pending</span>}</td>
            </tr>))}</tbody>
        </table>{data && !data.length && <Empty>No payments recorded.</Empty>}</div>
      )}
    </>
  );
}

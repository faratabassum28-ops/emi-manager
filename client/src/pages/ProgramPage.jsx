import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, fmtMonth, useFetch, useDebounced, useLiveReload } from '../util';
import { Badge, Kpi, Tabs, Loading, ErrorBox, Empty, AuthFile } from '../components/ui';
import TrackerTable from '../components/TrackerTable';
import StudentDrawer from '../components/StudentDrawer';
import { RecordPayment } from '../components/Actions';

const TABS = [{ key: 'dashboard', label: 'Dashboard' }, { key: 'students', label: 'Students' }, { key: 'tracker', label: 'EMI Tracker' }, { key: 'payments', label: 'Payments' }];
const SPLIT_COLORS = { on_time: '#137a4b', late: '#d49a00', overdue: '#d9534f', defaulter: '#7a1612', completed: '#1b56b8' };

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
  const { data, loading, error, reload } = useFetch(() => api.get(`/batches/${batchId}/dashboard`), [batchId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const k = data.kpis;
  const go = (filter) => navigate(`${base}/students?filter=${filter}`);
  const split = k.status_split.filter((s) => s.value > 0);

  return (
    <>
      <div className="grid kpis">
        <Kpi label="Total students" value={k.total_students} sub={k.dropped ? `${k.dropped} dropped/refunded` : undefined} onClick={() => go('all')} />
        <Kpi label="Total contract value" value={inr(k.contract_value)} />
        <Kpi label="Collected so far" value={inr(k.collected)} tone="green" />
        <Kpi label="Outstanding" value={inr(k.outstanding)} />
        <Kpi label="Collection %" value={`${k.collection_pct}%`} />
        <Kpi label="Due this month" value={inr(k.due_this_month)} />
        <Kpi label="Collected this month" value={inr(k.collected_this_month)} tone="green" />
        <Kpi label="Overdue now" value={inr(k.overdue_amount)} sub={`${k.overdue_count} instalments`} tone="red" onClick={() => go('overdue_all')} />
        <Kpi label="Paying on time" value={k.paying_on_time} onClick={() => go('on_time')} />
        <Kpi label="Paying late" value={k.paying_late} onClick={() => go('late')} />
        <Kpi label="Currently overdue" value={k.currently_overdue} tone={k.currently_overdue ? 'red' : ''} onClick={() => go('overdue_all')} />
        <Kpi label="Defaulters" value={k.defaulters} tone={k.defaulters ? 'red' : ''} onClick={() => go('defaulter')} />
        <Kpi label="Avg delay" value={`${k.avg_delay} d`} sub="across late-paid instalments" />
        <Kpi label="Completed" value={k.completed} onClick={() => go('completed')} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Month-wise expected vs collected</h2>
          {k.monthly.length ? (
            <div className="chart-box"><ResponsiveContainer><BarChart data={k.monthly.map((m) => ({ ...m, label: fmtMonth(m.month) }))}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" /><YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} /><Tooltip formatter={(v) => inr(v)} /><Legend />
              <Bar dataKey="expected" name="Expected" fill="#b9b0f2" /><Bar dataKey="collected" name="Collected" fill="#5b47d6" />
            </BarChart></ResponsiveContainer></div>
          ) : <Empty>No EMIs scheduled yet.</Empty>}
        </div>
        <div className="card">
          <h2>Student status <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>click a slice</span></h2>
          {split.length ? (
            <div className="chart-box"><ResponsiveContainer><PieChart>
              <Pie data={split} dataKey="value" nameKey="label" innerRadius={55} outerRadius={95} onClick={(s) => go((s && (s.key || (s.payload && s.payload.key))) || 'all')} cursor="pointer">{split.map((s) => <Cell key={s.key} fill={SPLIT_COLORS[s.key]} />)}</Pie>
              <Tooltip /><Legend />
            </PieChart></ResponsiveContainer></div>
          ) : <Empty>No students yet.</Empty>}
        </div>
        <div className="card">
          <h2>Overdue ageing</h2>
          <div className="chart-box"><ResponsiveContainer><BarChart data={k.ageing}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" /><YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} /><Tooltip formatter={(v, n, p) => [`${inr(v)} (${p.payload.count} instalments)`, 'Overdue']} />
            <Bar dataKey="amount" fill="#d9534f" onClick={() => go('overdue_all')} cursor="pointer" />
          </BarChart></ResponsiveContainer></div>
        </div>
        <div className="card">
          <h2>Collections by payment mode</h2>
          {k.by_mode.length ? (
            <div className="chart-box"><ResponsiveContainer><BarChart data={k.by_mode} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={(v) => `${Math.round(v / 1000)}k`} /><YAxis type="category" dataKey="mode" width={150} /><Tooltip formatter={(v) => inr(v)} />
              <Bar dataKey="amount" fill="#137a4b" />
            </BarChart></ResponsiveContainer></div>
          ) : <Empty>No payments yet.</Empty>}
        </div>
      </div>
      {can.export && <p><button onClick={() => api.download(`/batches/${batchId}/export`, `batch-${batchId}.xlsx`).catch((e) => alert(e.message))}>Export batch to Excel</button></p>}
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
              <td><AuthFile file={p.screenshot} /></td><td>{p.recorded_by}</td><td>{p.verified ? <span className="ok">✓ {p.verified_by}</span> : <span className="muted">pending</span>}</td>
            </tr>))}</tbody>
        </table>{data && !data.length && <Empty>No payments recorded.</Empty>}</div>
      )}
    </>
  );
}

// The CRM team's daily working screen: one row per instalment = one action (spec section 7).
import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, fmtDateTime, useFetch, useDebounced, useStored, useLiveReload } from '../util';
import { Badge, Tabs, Loading, ErrorBox, Empty, Modal, Pager } from './ui';
import StudentDrawer from './StudentDrawer';
import { LogCall, RecordPayment, sendWhatsApp } from './Actions';

const FILTERS = [
  { key: 'queue', label: 'Overdue + Due today' }, { key: 'overdue', label: 'Overdue' }, { key: 'today', label: 'Due today' },
  { key: 'next7', label: 'Next 7 days' }, { key: 'this_month', label: 'This month' }, { key: 'next_month', label: 'Next month' },
  { key: 'partial', label: 'Partially paid' }, { key: 'all', label: 'All' },
];

export default function TrackerTable({ batchId, showBatch }) {
  const { can } = useAuth();
  const [filter, setFilter] = useStored('tracker_filter', 'queue');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [drawer, setDrawer] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [call, setCall] = useState(null);
  const [pay, setPay] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [msg, setMsg] = useState('');
  const url = `/tracker?filter=${filter}${batchId ? `&batch=${batchId}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`;
  const { data, loading, error, reload } = useFetch(() => api.get(url), [url]);
  useLiveReload(reload, 60000);
  const PAGE = 50;

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const all = data ? data.rows : [];
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const rows = all.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE);
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.instalment_id));

  const wa = async (r) => { setMsg(''); const e = await sendWhatsApp(r.instalment_id); if (e) setMsg(e); else reload(); };
  const doBulk = async () => {
    setMsg('');
    try { const r = await api.post('/reminders/bulk', { instalments: [...sel] }); setBulk(r.items); setSel(new Set()); reload(); } catch (e) { setMsg(e.message); }
  };

  return (
    <>
      <Tabs tabs={FILTERS} value={filter} onChange={(k) => { setFilter(k); setSel(new Set()); setPage(1); }} />
      <div className="row" style={{ marginBottom: 10 }}>
        <input style={{ maxWidth: 260 }} placeholder="Search name or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        {data && <span className="muted">{data.total} instalments · {inr(data.total_balance)} open</span>}
        <span className="grow" />
        {can.write && sel.size > 0 && <button className="primary" onClick={doBulk}>Send reminders to {sel.size} selected</button>}
      </div>
      {msg && <div className="alert error">{msg}</div>}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {can.write && <th><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.instalment_id)))} aria-label="Select all" /></th>}
                <th>Student</th><th>Phone</th>{showBatch && <th>Batch</th>}<th>EMI</th><th className="num">Due</th><th className="num">Paid</th><th>Due date</th>
                <th className="num">Overdue</th><th>Status</th><th>Last reminder</th><th>Promised</th><th>CRM</th>{can.write && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.instalment_id}>
                  {can.write && <td><input type="checkbox" checked={sel.has(r.instalment_id)} onChange={() => toggle(r.instalment_id)} aria-label={`Select ${r.student_name}`} /></td>}
                  <td><button className="link" onClick={() => setDrawer(r.enrollment_id)} title="Quick view and history">{r.student_name}</button></td>
                  <td>{r.phone}</td>
                  {showBatch && <td>{r.program} · {r.batch_name}</td>}
                  <td>{r.emi_number} of {r.emi_total}</td>
                  <td className="num">{inr(r.amount_due)}</td><td className="num">{inr(r.amount_paid)}</td>
                  <td>{fmtDate(r.due_date)}</td>
                  <td className={`num ${r.days_overdue ? 'red-text' : ''}`}>{r.days_overdue ? `${r.days_overdue}d` : '—'}</td>
                  <td><Badge status={r.status} /></td>
                  <td title={r.last_reminder ? fmtDateTime(r.last_reminder.at) : ''}>{r.last_reminder ? `${fmtDate(String(r.last_reminder.at).slice(0, 10))} · ${r.last_reminder.outcome}` : '—'}</td>
                  <td>{r.promised_date ? fmtDate(r.promised_date) : '—'}</td>
                  <td>{r.assigned || '—'}</td>
                  {can.write && (
                    <td className="nowrap">
                      <button className="small" onClick={() => wa(r)}>WhatsApp</button>{' '}
                      <button className="small" onClick={() => setCall(r)}>Log call</button>{' '}
                      <button className="small primary" onClick={() => setPay(r)}>Record payment</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>{filter === 'queue' ? 'Nothing overdue or due today. 🎉' : 'No instalments match this filter.'}</Empty>}
        </div>
      )}
      <Pager page={Math.min(page, pages)} pages={pages} total={all.length} onPage={setPage} />
      {drawer && <StudentDrawer enrollmentId={drawer} onClose={() => setDrawer(null)} />}

      {call && <LogCall instalmentId={call.instalment_id} who={call.student_name} onClose={() => setCall(null)} onDone={() => { setCall(null); reload(); }} />}
      {pay && <RecordPayment enrollmentId={pay.enrollment_id} instalmentId={pay.instalment_id} studentLabel={`${pay.student_name} · EMI ${pay.emi_number} of ${pay.emi_total}`} onClose={() => setPay(null)} onDone={() => { setPay(null); reload(); }} />}
      {bulk && (
        <Modal title="Reminders logged" onClose={() => setBulk(null)} wide>
          <p className="muted">Each reminder is already logged. Open WhatsApp for each student below.</p>
          <table><tbody>{bulk.map((b) => <tr key={b.instalment_id}><td>{b.name}</td><td>{b.phone}</td><td><a className="btn" href={b.wa} target="_blank" rel="noreferrer">Open WhatsApp</a></td></tr>)}</tbody></table>
          {!bulk.length && <Empty>Nothing to send (all selected instalments are already paid).</Empty>}
        </Modal>
      )}
    </>
  );
}

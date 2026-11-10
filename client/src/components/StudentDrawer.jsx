// Quick view of one student without leaving the list: money position, schedule, and full history.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, waChat, useFetch, useLiveReload } from '../util';
import { Badge, Drawer, Loading, ErrorBox } from './ui';
import HistoryTimeline from './History';
import { LogCall, RecordPayment, sendWhatsApp } from './Actions';

export default function StudentDrawer({ enrollmentId, onClose }) {
  const { can } = useAuth();
  const { data: d, loading, error, reload } = useFetch(() => api.get(`/enrollments/${enrollmentId}`), [enrollmentId]);
  useLiveReload(reload, 0);
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState('');
  const closed = d && ['Dropped', 'Refunded'].includes(d.status);
  const next = d && d.instalments.find((i) => i.type === 'EMI' && i.balance > 0 && i.status !== 'Waived');
  const pct = d && d.enrollment.net_payable ? Math.min(100, Math.round((d.paid / d.enrollment.net_payable) * 100)) : 0;

  return (
    <Drawer title={d ? <>{d.student.full_name} <Badge status={d.status} /></> : 'Student'} sub={d ? `${d.program.name} · ${d.batch.name} · ${d.student.phone}` : ''} onClose={onClose}>
      {loading && !d && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {msg && <div className="alert error">{msg}</div>}
      {d && (
        <>
          <div className="row" style={{ margin: '6px 0 10px' }}>
            <a className="btn small" href={waChat(d.student.phone)} target="_blank" rel="noreferrer">WhatsApp chat</a>
            <a className="btn small" href={`tel:${d.student.phone}`}>Call</a>
            {can.write && !closed && next && <button className="small" onClick={() => setModal({ t: 'call', i: next })}>Log call</button>}
            {can.write && !closed && <button className="small primary" onClick={() => setModal({ t: 'pay', i: next })}>Record payment</button>}
            <Link className="btn small" to={`/enrollments/${d.enrollment.id}`} onClick={onClose}>Open full profile →</Link>
          </div>

          <div className="stat-strip">
            <div className="kpi"><span className="kpi-label">Paid</span><span className="kpi-value ok">{inr(d.paid)}</span><span className="kpi-sub">{pct}% of {inr(d.enrollment.net_payable)}</span></div>
            <div className="kpi"><span className="kpi-label">Still to pay</span><span className="kpi-value">{inr(d.balance)}</span><span className="kpi-sub">{d.emis_paid} of {d.emi_total} EMIs paid</span></div>
          </div>
          {next && (
            <div className={`banner ${next.days_overdue > 0 ? 'err' : ''}`}>
              <b>Next: EMI {next.emi_number} of {d.emi_total}</b> · {inr(next.balance)} due {fmtDate(next.due_date)}{next.days_overdue > 0 && <b> · {next.days_overdue} days overdue</b>}
              {can.write && !closed && <> · <button className="link" onClick={async () => { setMsg(''); const er = await sendWhatsApp(next.id); if (er) setMsg(er); else reload(); }}>Send WhatsApp reminder</button></>}
            </div>
          )}

          <h2 className="sd-h">Schedule</h2>
          <div className="table-wrap"><table className="mini">
            <thead><tr><th>Item</th><th>Due</th><th className="num">Amount</th><th className="num">Balance</th><th>Status</th></tr></thead>
            <tbody>{d.instalments.map((i) => <tr key={i.id}><td>{i.type === 'EMI' ? `EMI ${i.emi_number}` : i.type}</td><td>{fmtDate(i.due_date)}</td><td className="num">{inr(i.amount_due)}</td><td className="num">{inr(i.balance)}</td><td><Badge status={i.status} /></td></tr>)}</tbody>
          </table></div>

          <h2 className="sd-h">History</h2>
          <HistoryTimeline enrollmentId={d.enrollment.id} live={false} />
        </>
      )}
      {modal && modal.t === 'pay' && <RecordPayment enrollmentId={d.enrollment.id} instalmentId={modal.i && modal.i.id} studentLabel={d.student.full_name} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal && modal.t === 'call' && <LogCall instalmentId={modal.i.id} who={d.student.full_name} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </Drawer>
  );
}

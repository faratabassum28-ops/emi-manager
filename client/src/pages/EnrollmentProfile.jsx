import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, fmtDateTime, waChat, useFetch } from '../util';
import { AuthFile, Badge, ErrorBox, Field, FileInput, Loading, Modal, Empty } from '../components/ui';
import { RecordPayment, LogCall, sendWhatsApp } from '../components/Actions';

export default function EnrollmentProfile() {
  const { id } = useParams_();
  const { can } = useAuth();
  const { data: d, loading, error, reload } = useFetch(() => api.get(`/enrollments/${id}`), [id]);
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState('');

  if (loading && !d) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const e = d.enrollment;
  const done = () => { setModal(null); reload(); };
  const closed = ['Dropped', 'Refunded'].includes(d.status);
  const openInst = d.instalments.filter((i) => i.type === 'EMI' && i.balance > 0 && i.status !== 'Waived');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{d.student.full_name} <Badge status={d.status} /></h1>
          <div className="muted">{d.program.name} · {d.batch.name} · {d.student.phone} · {d.student.email}</div>
        </div>
        <div className="actions">
          <a className="btn" href={waChat(d.student.phone)} target="_blank" rel="noreferrer">WhatsApp chat</a>
          {can.write && !closed && <button className="primary" onClick={() => setModal({ t: 'pay' })}>+ Record payment</button>}
          {can.write && !closed && openInst.length > 0 && <button onClick={() => setModal({ t: 'plan' })}>Restructure plan</button>}
          {can.manage && <button onClick={() => setModal({ t: 'status' })}>Change status</button>}
        </div>
      </div>
      {msg && <div className="alert error">{msg}</div>}

      <div className="grid two">
        <div className="card">
          <h2>Fee breakup</h2>
          <dl className="kv">
            <dt>Total fee</dt><dd>{inr(e.total_fee)}{e.fee_change_reason && <span className="muted"> · changed: {e.fee_change_reason}</span>}</dd>
            {e.adjustments.map((a, i) => <><dt key={`n${i}`}>Less: {a.name}</dt><dd key={`v${i}`}>−{inr(a.amount)}{a.notes && <span className="muted"> · {a.notes}</span>}</dd></>)}
            {e.discount > 0 && <><dt>Less: discount</dt><dd>−{inr(e.discount)} <span className="muted">· {e.discount_reason}</span></dd></>}
            <dt><b>Net payable</b></dt><dd><b>{inr(e.net_payable)}</b></dd>
            <dt>Application fee</dt><dd>{inr(e.application_fee_paid)}</dd>
            <dt>Commitment fee</dt><dd>{inr(e.commitment_fee_paid)}</dd>
            <dt>Balance split into EMIs</dt><dd>{inr(e.balance_due)} ({e.emi_count} EMIs)</dd>
            <dt>Paid so far</dt><dd className="ok">{inr(d.paid)}</dd>
            <dt>Still to pay</dt><dd>{inr(d.balance)}</dd>
            <dt>EMIs paid</dt><dd>{d.emis_paid} of {d.emi_total}</dd>
            <dt>Enrolled</dt><dd>{fmtDate(e.enrollment_date)}{e.closed_by && ` · closed by ${e.closed_by}`}</dd>
            {e.status_reason && <><dt>Status note</dt><dd>{e.status_reason}</dd></>}
            <dt>EMI agreement</dt><dd>{e.agreement_file ? <AuthFile file={e.agreement_file} label="View" /> : can.write ? <AgreementUpload id={d.enrollment.id} onDone={reload} /> : '—'}</dd>
          </dl>
        </div>

        <div className="card">
          <h2>Other programs</h2>
          {d.others.length ? <ul>{d.others.map((o) => <li key={o.enrollment_id}><Link to={`/enrollments/${o.enrollment_id}`}>{o.program} · {o.batch}</Link> <span className="muted">({o.status})</span></li>)}</ul> : <div className="muted">No other enrollments.</div>}
          {d.student.notes && <><h2 style={{ marginTop: 14 }}>Notes</h2><div>{d.student.notes}</div></>}
        </div>
      </div>

      <h2 style={{ marginTop: 22 }}>EMI timeline</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Due date</th><th className="num">Amount</th><th className="num">Paid</th><th className="num">Balance</th><th>Paid on</th><th>Status</th>{can.write && <th>Actions</th>}</tr></thead>
        <tbody>{d.instalments.map((i) => (
          <tr key={i.id}>
            <td>{i.type === 'EMI' ? `EMI ${i.emi_number} of ${d.emi_total}` : i.type}</td><td>{fmtDate(i.due_date)}</td>
            <td className="num">{inr(i.amount_due)}</td><td className="num">{inr(i.amount_paid)}</td><td className="num">{inr(i.balance)}</td><td>{fmtDate(i.paid_on)}</td>
            <td><Badge status={i.status} />{i.days_overdue > 0 && <span className="red-text"> {i.days_overdue}d overdue</span>}{i.days_late > 0 && <span className="muted"> {i.days_late}d late</span>}{i.waive_reason && <div className="muted">{i.waive_reason}</div>}</td>
            {can.write && <td className="nowrap">{i.type === 'EMI' && i.balance > 0 && i.status !== 'Waived' && !closed && (<>
              <button className="small" onClick={async () => { setMsg(''); const er = await sendWhatsApp(i.id); if (er) setMsg(er); else reload(); }}>WhatsApp</button>{' '}
              <button className="small" onClick={() => setModal({ t: 'call', i })}>Log call</button>{' '}
              <button className="small primary" onClick={() => setModal({ t: 'pay', i })}>Pay</button>
              {can.admin && <>{' '}<button className="small danger" onClick={() => setModal({ t: 'waive', i })}>Waive</button></>}</>)}</td>}
          </tr>))}</tbody>
      </table></div>

      {e.plan_history && e.plan_history.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Plan changes</h2>
          {e.plan_history.map((h, i) => <div key={i} className="muted">{fmtDateTime(h.at)} · {h.by} · “{h.reason}” · was: {h.old.map((o) => `${inr(o.amount_due)} on ${fmtDate(o.due_date)}`).join(', ')}</div>)}
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>Payments</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th className="num">Amount</th><th>Mode</th><th>Reference</th><th>Screenshot</th><th>Recorded by</th><th>Verified</th>{can.admin && <th />}</tr></thead>
        <tbody>{d.payments.map((p) => (
          <tr key={p.id}>
            <td>{fmtDate(p.payment_date)}</td><td className={`num ${p.amount < 0 ? 'red-text' : ''}`}>{inr(p.amount)}</td><td>{p.mode}</td>
            <td>{p.reversal_of ? <span>Reversal · {p.reversal_reason}</span> : p.transaction_ref}{p.reversed && <span className="badge b-red"> reversed</span>}{p.imported && <span className="badge b-gray"> imported</span>}</td>
            <td><AuthFile file={p.screenshot} /></td><td>{p.recorded_by}</td><td>{p.verified ? <span className="ok">✓</span> : <span className="muted">pending</span>}</td>
            {can.admin && <td>{!p.reversal_of && !p.reversed && <button className="small danger" onClick={() => setModal({ t: 'reverse', p })}>Reverse</button>}</td>}
          </tr>))}</tbody>
      </table>{!d.payments.length && <Empty>No payments yet.</Empty>}</div>

      <h2 style={{ marginTop: 22 }}>Reminder history</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Channel</th><th>Outcome</th><th>Promised</th><th>By</th><th>Notes</th></tr></thead>
        <tbody>{d.reminders.map((r) => <tr key={r._id}><td>{fmtDateTime(r.sent_at)}</td><td>{r.channel}</td><td>{r.outcome}</td><td>{fmtDate(r.promised_date)}</td><td>{r.sent_by_name}</td><td className="wrap">{r.notes}</td></tr>)}</tbody>
      </table>{!d.reminders.length && <Empty>No reminders logged.</Empty>}</div>

      {modal && modal.t === 'pay' && <RecordPayment enrollmentId={d.enrollment.id} instalmentId={modal.i && modal.i.id} studentLabel={d.student.full_name} onClose={() => setModal(null)} onDone={done} />}
      {modal && modal.t === 'call' && <LogCall instalmentId={modal.i.id} who={d.student.full_name} onClose={() => setModal(null)} onDone={done} />}
      {modal && modal.t === 'plan' && <RestructureModal d={d} onClose={() => setModal(null)} onDone={done} />}
      {modal && modal.t === 'status' && <StatusModal d={d} onClose={() => setModal(null)} onDone={done} />}
      {modal && modal.t === 'waive' && <ReasonModal title={`Waive ${modal.i.type === 'EMI' ? `EMI ${modal.i.emi_number}` : modal.i.type}`} warn={`This closes ${inr(modal.i.balance)} as waived / written off.`} action={(reason) => api.post(`/instalments/${modal.i.id}/waive`, { reason })} onClose={() => setModal(null)} onDone={done} />}
      {modal && modal.t === 'reverse' && <ReasonModal title={`Reverse payment of ${inr(modal.p.amount)}`} warn="A negative entry is added; the original stays in the audit trail." action={(reason) => api.post(`/payments/${modal.p.id}/reverse`, { reason })} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}

import { useParams as useParams_ } from 'react-router-dom';

function AgreementUpload({ id, onDone }) {
  const [busy, setBusy] = useState(false);
  return <FileInput label="Upload agreement" value="" onChange={async (f) => { setBusy(true); try { await api.put(`/enrollments/${id}/agreement`, { file: f }); onDone(); } finally { setBusy(false); } }} />;
}

function ReasonModal({ title, warn, action, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => { try { await action(reason); onDone(); } catch (e) { setErr(e.message); } };
  return (
    <Modal title={title} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!reason.trim()} onClick={go}>Confirm</button></>}>
      <div className="alert warn">{warn}</div>
      <Field label="Reason (required, logged)"><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      {err && <div className="alert error">{err}</div>}
    </Modal>
  );
}

function StatusModal({ d, onClose, onDone }) {
  const [status, setStatus] = useState(['Paused', 'Dropped', 'Refunded'].includes(d.status) ? d.status : 'Paused');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const closing = ['Dropped', 'Refunded'].includes(status);
  const go = async () => { try { await api.put(`/enrollments/${d.enrollment.id}/status`, { status, reason }); onDone(); } catch (e) { setErr(e.message); } };
  return (
    <Modal title="Change enrollment status" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={go}>Save</button></>}>
      <div className="grid">
        <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="Active">Active (re-open)</option><option>Paused</option><option>Dropped</option><option>Refunded</option></select></Field>
        {closing && <div className="alert warn">Unpaid future instalments will be cancelled (waived) and leave the “due” totals. Payments already received stay in revenue.</div>}
        <Field label={closing ? 'Reason (required)' : 'Note'}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <div className="alert error">{err}</div>}
      </div>
    </Modal>
  );
}

function RestructureModal({ d, onClose, onDone }) {
  // paid and part-paid EMIs are locked; only untouched ones can change
  const editable = d.instalments.filter((i) => i.type === 'EMI' && i.amount_paid === 0 && i.status !== 'Waived');
  const pool = editable.reduce((a, i) => a + i.amount_due, 0);
  const [rows, setRows] = useState(editable.map((i) => ({ amount_due: String(i.amount_due), due_date: i.due_date })));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const sum = rows.reduce((a, r) => a + Number(r.amount_due || 0), 0);
  const diff = pool - sum;
  const set = (i, k, v) => setRows((l) => l.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const go = async () => {
    try { await api.put(`/enrollments/${d.enrollment.id}/plan`, { emis: rows.map((r) => ({ amount_due: Number(r.amount_due), due_date: r.due_date })), reason }); onDone(); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title="Restructure EMI plan" wide onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={diff !== 0 || !reason.trim() || !rows.length} onClick={go}>Save new plan</button></>}>
      <div className="alert info">Paid and part-paid EMIs are locked. The unpaid EMIs below must still add up to {inr(pool)}. The old plan is kept in the history.</div>
      <table><thead><tr><th>#</th><th>Amount (₹)</th><th>Due date</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td>{i + 1}</td><td><input type="number" value={r.amount_due} onChange={(e) => set(i, 'amount_due', e.target.value)} /></td><td><input type="date" value={r.due_date} onChange={(e) => set(i, 'due_date', e.target.value)} /></td><td><button className="small danger" onClick={() => setRows((l) => l.filter((_, j) => j !== i))}>Remove</button></td></tr>)}</tbody></table>
      <p><button onClick={() => setRows([...rows, { amount_due: '', due_date: rows.length ? rows[rows.length - 1].due_date : '' }])}>+ Add EMI</button></p>
      <div className={diff === 0 ? 'diff-ok' : 'diff-bad'}>{diff === 0 ? '✓ Adds up' : `Difference: ${inr(diff)}`}</div>
      <Field label="Reason (required, logged)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {err && <div className="alert error">{err}</div>}
    </Modal>
  );
}

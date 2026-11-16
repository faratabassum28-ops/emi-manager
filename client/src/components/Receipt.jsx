import { api } from '../api';
import { inr, fmtDate, useFetch, rupeesInWords } from '../util';
import { Modal, Loading, ErrorBox } from './ui';
import Icon from './Icon';

export default function Receipt({ paymentId, onClose }) {
  const { data: r, loading, error } = useFetch(() => api.get(`/payments/${paymentId}/receipt`), [paymentId]);
  return (
    <Modal title="Payment receipt" onClose={onClose} wide footer={r && <button className="primary" onClick={() => window.print()}><Icon name="print" size={15} /> Print / Save as PDF</button>}>
      {loading && <Loading />}
      <ErrorBox error={error} />
      {r && (
        <div className="receipt">
          <div className="receipt-head">
            <div><h2 style={{ margin: 0 }}>MySoulSchool</h2><div className="muted">Fee receipt</div></div>
            <div style={{ textAlign: 'right' }}><b>{r.receipt_no}</b><div className="muted">{fmtDate(r.payment_date)}</div></div>
          </div>
          <div className="muted">Received from</div>
          <b style={{ fontSize: 16 }}>{r.student && (r.student.full_name || r.student.name || r.student)}</b>
          <div className="muted">{[r.program, r.batch].filter(Boolean).join(' · ')}</div>
          <div className="receipt-amount">{inr(r.amount)}</div>
          <div className="muted" style={{ marginBottom: 14 }}>{rupeesInWords(Math.abs(r.amount))}</div>
          <table>
            <tbody>
              <tr><td>Payment mode</td><td style={{ textAlign: 'right' }}>{r.mode}</td></tr>
              {r.note && <tr><td>Note</td><td style={{ textAlign: 'right' }}>{r.note}</td></tr>}
              {(r.applied || []).map((a, i) => <tr key={i}><td>Applied to {a.label || (a.emi_number ? `EMI ${a.emi_number}` : a.type)}</td><td style={{ textAlign: 'right' }}>{inr(a.amount)}</td></tr>)}
              <tr><td>Total paid so far</td><td style={{ textAlign: 'right' }}>{inr(r.paid_total)}</td></tr>
              <tr><td><b>Balance remaining</b></td><td style={{ textAlign: 'right' }}><b>{inr(r.balance)}</b></td></tr>
              {r.next && <tr><td>Next instalment</td><td style={{ textAlign: 'right' }}>{inr(r.next.balance ?? r.next.amount_due)} on {fmtDate(r.next.due_date)}</td></tr>}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
            <span className="muted">Recorded by {r.recorded_by}</span>
            <span className={`stamp ${r.reversed ? 'void' : ''}`}>{r.reversed ? 'Reversed' : r.verified ? 'Verified' : 'Received'}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}

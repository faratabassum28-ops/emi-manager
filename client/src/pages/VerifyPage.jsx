import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { inr, fmtDate, useFetch, useLiveReload } from '../util';
import { AuthFile, ErrorBox, Loading, Empty } from '../components/ui';

// Accounts ticks a payment once it matches the bank statement (spec section 8).
export default function VerifyPage() {
  const { data, loading, error, reload } = useFetch(() => api.get('/payments?verified=0&limit=500'));
  useLiveReload(reload, 60000);
  const [msg, setMsg] = useState('');
  const verify = async (id) => {
    setMsg('');
    try { await api.post(`/payments/${id}/verify`, {}); reload(); } catch (e) { setMsg(e.message); }
  };
  const rows = (data || []).filter((p) => p.amount > 0);

  return (
    <>
      <div className="page-head"><div><h1>Verify payments</h1><div className="muted">Match each payment with the bank / Tally statement, then tick it. Unverified payments are flagged until you do.</div></div></div>
      {msg && <div className="alert error">{msg}</div>}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Student</th><th>Batch</th><th className="num">Amount</th><th>Applied to</th><th>Mode</th><th>Screenshot</th><th>Recorded by</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td>{fmtDate(p.payment_date)}</td><td><Link to={`/enrollments/${p.enrollment_id}`}>{p.student}</Link></td><td>{p.batch}</td>
              <td className="num">{inr(p.amount)}</td><td>{p.applied_to}</td><td>{p.mode}</td>
              <td><AuthFile file={p.screenshot} paymentId={p.id} /></td><td>{p.recorded_by}</td>
              <td><button className="small primary" onClick={() => verify(p.id)}>Mark verified</button></td>
            </tr>))}</tbody>
        </table>{!rows.length && <Empty>Everything is verified. ✓</Empty>}</div>
      )}
    </>
  );
}

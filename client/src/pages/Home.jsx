import { Link } from 'react-router-dom';
import { api } from '../api';
import { inr, fmtDate, useFetch } from '../util';
import { Kpi, Loading, ErrorBox, Empty } from '../components/ui';

export default function Home() {
  const { data, loading, error, reload } = useFetch(() => api.get('/home'));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const t = data.totals;

  return (
    <>
      <div className="page-head"><div><h1>Home</h1><div className="muted">All programs · today is {fmtDate(data.today)}</div></div></div>
      <div className="grid kpis">
        <Kpi label="Collected this month" value={inr(t.collected_this_month)} tone="green" />
        <Kpi label="Due this month" value={inr(t.due_this_month)} />
        <Kpi label="Overdue now" value={inr(t.overdue_amount)} sub={`${t.overdue_count} instalments`} tone="red" />
        <Kpi label="Collection rate" value={t.collection_rate === null ? '—' : `${t.collection_rate}%`} sub="EMI collected ÷ EMI due this month" />
        <Kpi label="Active students" value={t.students} />
      </div>

      <h2 style={{ marginTop: 22 }}>Batches · worst overdue first</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Program</th><th>Batch</th><th className="num">Students</th><th className="num">Outstanding</th><th className="num">Overdue</th><th className="num">Overdue #</th><th className="num">Collected %</th></tr></thead>
          <tbody>
            {data.batches.map((b) => (
              <tr key={b.batch_id}>
                <td>{b.program}</td>
                <td><BatchLink b={b} /></td>
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

      <h2 style={{ marginTop: 22 }}>Today's list · EMIs due today ({data.today_list.length})</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Student</th><th>Phone</th><th>Batch</th><th>EMI</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {data.today_list.map((r) => (
              <tr key={r.instalment_id}>
                <td><Link to={`/enrollments/${r.enrollment_id}`}>{r.student_name}</Link></td>
                <td>{r.phone}</td><td>{r.program} · {r.batch_name}</td><td>{r.emi_number} of {r.emi_total}</td><td className="num">{inr(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.today_list.length && <Empty>Nothing due today.</Empty>}
      </div>
    </>
  );
}

function BatchLink({ b }) {
  return <Link to={`/p/${b.program_id}/${b.batch_id}`}>{b.batch_name}</Link>;
}

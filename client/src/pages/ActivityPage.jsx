import { api } from '../api';
import { fmtDateTime, useFetch } from '../util';
import { ErrorBox, Loading, Empty } from '../components/ui';

const short = (c) => {
  if (c === undefined || c === null) return '';
  const s = typeof c === 'string' ? c : JSON.stringify(c);
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
};

export default function ActivityPage() {
  const { data, loading, error, reload } = useFetch(() => api.get('/activity?limit=300'));
  return (
    <>
      <div className="page-head"><div><h1>Activity log</h1><div className="muted">Every create, edit and reversal: who, when, what changed. Latest 300 entries.</div></div></div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Details</th><th>Reason</th></tr></thead>
          <tbody>{(data || []).map((a) => (
            <tr key={a._id}><td>{fmtDateTime(a.createdAt)}</td><td>{a.user_name}</td><td>{a.entity}</td><td>{a.action}</td><td className="wrap"><code>{short(a.changes)}</code></td><td className="wrap">{a.reason}</td></tr>))}</tbody>
        </table>{data && !data.length && <Empty>Nothing logged yet.</Empty>}</div>
      )}
    </>
  );
}

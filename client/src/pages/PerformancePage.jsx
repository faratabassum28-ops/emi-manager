import { api } from '../api';
import { inr, useFetch, useLiveReload } from '../util';
import { Kpi, Loading, ErrorBox, Empty, Avatar, Meter } from '../components/ui';
import FilterBar, { useWindow } from '../components/FilterBar';
import { HBars } from '../components/Charts';
import Icon from '../components/Icon';

const MEDALS = ['🥇', '🥈', '🥉'];

export default function PerformancePage() {
  const win = useWindow('perf_window');
  const { data, loading, error, reload } = useFetch(() => (win.ready ? api.get(`/performance?${win.params}`) : Promise.resolve(null)), [win.params, win.ready]);
  useLiveReload(reload, 120000);
  const people = (data && data.people) || [];
  const t = data && data.totals;
  return (
    <>
      <FilterBar win={win} range={data && data.window} />
      <div className="page-head"><div><h1>Team performance</h1><div className="muted">Who collected, who followed up, and whose promises held</div></div></div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (
        <>
          <div className="grid kpis">
            <Kpi icon="wallet" label="Collected" value={inr(t.collected)} tone="green" />
            <Kpi icon="phone" label="Follow-ups" value={t.followups} />
            <Kpi icon="target" label="Promises made" value={t.promises} />
            <Kpi icon="checkc" label="Promises kept" value={t.kept} tone="green" />
            <Kpi icon="flame" label="Promises broken" value={t.broken} tone={t.broken ? 'red' : ''} />
          </div>
          {!people.length ? <Empty icon="trophy">No activity in this period.</Empty> : (
            <>
              <div className="card" style={{ marginTop: 16 }}>
                <h2><Icon name="trophy" size={16} /> Collections leaderboard</h2>
                <HBars rows={people.filter((p) => p.collected > 0).map((p, i) => ({ label: `${MEDALS[i] || ''} ${p.name}`.trim(), value: p.collected }))} color="var(--accent)" fmt={inr} />
              </div>
              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead><tr><th>Team member</th><th className="num">Collected</th><th className="num">Payments</th><th className="num">Verified</th><th className="num">Follow-ups</th><th className="num">Calls</th><th className="num">WhatsApp</th><th className="num">Promises</th><th>Kept rate</th></tr></thead>
                  <tbody>{people.map((p) => (
                    <tr key={p.name}>
                      <td><span className="row" style={{ gap: 8 }}><Avatar name={p.name} /><b>{p.name}</b></span></td>
                      <td className="num">{inr(p.collected)}</td><td className="num">{p.payments}</td><td className="num">{p.verified}</td>
                      <td className="num">{p.followups}</td><td className="num">{p.calls}</td><td className="num">{p.whatsapps}</td>
                      <td className="num" title={`${p.kept} kept · ${p.broken} broken · ${p.pending} still pending`}>{p.promises}</td>
                      <td style={{ minWidth: 130 }}>{p.kept_pct === null ? <span className="muted">—</span> : <><Meter pct={p.kept_pct} tone={p.kept_pct >= 60 ? 'good' : 'bad'} /> <span className="muted">{p.kept_pct}%</span></>}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

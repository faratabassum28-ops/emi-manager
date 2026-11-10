// A student's full trail (payments, follow-ups, plan changes, status, edits) with quick filters.
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useFetch, useLiveReload } from '../util';
import { Timeline, Loading, ErrorBox } from './ui';

const KINDS = [
  ['all', 'Everything'], ['payment', 'Payments'], ['reminder', 'Follow-ups'], ['schedule', 'Plan & dates'], ['status', 'Status'], ['other', 'Other'],
];
const OTHER = ['enrollment', 'document', 'student'];

export default function HistoryTimeline({ enrollmentId, live = true }) {
  const { data, loading, error, reload } = useFetch(() => api.get(`/enrollments/${enrollmentId}/history`), [enrollmentId]);
  useLiveReload(reload, live ? 60000 : 0);
  const [kind, setKind] = useState('all');
  const events = data ? data.events : [];
  const counts = useMemo(() => {
    const c = { all: events.length };
    for (const [k] of KINDS) if (k !== 'all') c[k] = events.filter((e) => (k === 'other' ? OTHER.includes(e.kind) : e.kind === k)).length;
    return c;
  }, [events]);
  const shown = kind === 'all' ? events : events.filter((e) => (kind === 'other' ? OTHER.includes(e.kind) : e.kind === kind));
  if (loading && !data) return <Loading />;
  return (
    <>
      <ErrorBox error={error} onRetry={reload} />
      <div className="chips" style={{ marginBottom: 6 }}>
        {KINDS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, l]) => <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{l} ({counts[k]})</button>)}
      </div>
      <Timeline events={shown} />
    </>
  );
}

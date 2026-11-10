import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { STATUS_TONE, delta, fmtDate, istDay, istTime, todayIST } from '../util';

export function Modal({ title, onClose, children, wide, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const Badge = ({ status, children }) => <span className={`badge b-${STATUS_TONE[status] || 'gray'}`}>{children || status}</span>;

export const Loading = () => <div className="muted pad">Loading…</div>;
export const ErrorBox = ({ error, onRetry }) => error ? (
  <div className="alert error">{error}{onRetry && <button className="link" onClick={onRetry}> Retry</button>}</div>
) : null;

export function Field({ label, hint, children, span }) {
  return (
    <label className={`field ${span ? 'span-' + span : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Kpi({ label, value, sub, onClick, tone }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`kpi ${tone || ''} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </Tag>
  );
}

// Screenshots are only served to signed-in users, so fetch with the auth header and show a blob.
export function AuthFile({ file, label = 'View' }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(false);
  const isPdf = /\.pdf$/i.test(file || '');
  useEffect(() => {
    if (!file || isPdf) return undefined;
    let live = true;
    let made;
    api.blobUrl(`/files/${file}`).then((u) => { made = u; live ? setUrl(u) : URL.revokeObjectURL(u); }).catch(() => live && setErr(true));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [file, isPdf]);
  if (!file) return <span className="muted">—</span>;
  const open = async (e) => {
    e.preventDefault();
    const w = window.open('', '_blank');
    try { w.location.href = url || (await api.blobUrl(`/files/${file}`)); } catch { w && w.close(); }
  };
  if (isPdf || err) return <a href="#open" className="link" onClick={open}>{isPdf ? 'PDF' : label}</a>;
  return url ? <a href="#open" onClick={open}><img className="thumb" src={url} alt="Payment screenshot" /></a> : <span className="muted">…</span>;
}

export function FileInput({ value, onChange, label = 'Upload', required }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setErr('Max 5 MB');
    setBusy(true);
    setErr('');
    try { onChange(await api.upload(f)); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="file-input">
      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={pick} aria-label={label} required={required && !value} />
      {busy && <span className="muted">Uploading…</span>}
      {value && !busy && <span className="ok">✓ attached</span>}
      {err && <span className="err-text">{err}</span>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>{t.label}{t.count !== undefined ? ` (${t.count})` : ''}</button>
      ))}
    </div>
  );
}

export const Empty = ({ children }) => <div className="empty">{children}</div>;

/* ---------- ported from Order Analytics: drawer, delta chips, segmented control, pager, timeline ---------- */
export function Drawer({ title, onClose, children, sub }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
        <div className="sheet-head"><div><h2 style={{ margin: 0 }}>{title}</h2>{sub && <div className="muted">{sub}</div>}</div><button onClick={onClose}>Close</button></div>
        {children}
      </aside>
    </>
  );
}

// ▲ 12% / ▼ 8% vs the previous window. `up` says which direction is good ('good') or bad ('bad').
export function DeltaChip({ cur, prev, up = 'good' }) {
  const d = delta(cur, prev);
  if (!d) return <span className="chip" title="No previous window to compare">–</span>;
  if (d.diff === 0) return <span className="chip">no change</span>;
  const good = (d.diff > 0) === (up === 'good');
  return <span className={`chip ${good ? 'good' : 'bad'}`} title="Change vs the previous equal-length window">{d.diff > 0 ? '▲' : '▼'} {d.text}</span>;
}

export function Seg({ options, value, onChange }) {
  return <div className="seg" role="tablist">{options.map(([k, l]) => <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

export function Pager({ page, pages, total, onPage }) {
  if (pages <= 1) return total ? <div className="pager">{total} total</div> : null;
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {pages} · {total} total</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

// One line per thing that happened, newest first, grouped by day. `showStudent` links each line to the student (global feed).
export function Timeline({ events, showStudent }) {
  if (!events.length) return <div className="muted">Nothing recorded yet.</div>;
  const today = todayIST();
  const label = (d) => (d === today ? 'Today' : d === new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10) ? 'Yesterday' : fmtDate(d));
  let last = '';
  const out = [];
  events.forEach((e) => {
    const day = istDay(e.at);
    if (day !== last) { out.push(<li key={`d${day}`} className="tl-day" style={{ listStyle: 'none', padding: 0 }}>{label(day)}</li>); last = day; }
    out.push(
      <li key={e.id} className={e.tone || ''}>
        <div className="tl-main">{e.label}</div>
        {e.detail && <div className="tl-detail">{e.detail}</div>}
        {e.reason && <div className="tl-reason">“{e.reason}”</div>}
        <div className="tl-sub tl-who">{e.by} · {istTime(e.at)}{showStudent && e.student && <> · {e.enrollment_id ? <Link to={`/enrollments/${e.enrollment_id}`}>{e.student}</Link> : e.student}{e.batch ? ` (${e.batch})` : ''}</>}</div>
      </li>
    );
  });
  return <ol className="timeline">{out}</ol>;
}

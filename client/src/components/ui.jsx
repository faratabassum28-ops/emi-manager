import { useEffect, useState } from 'react';
import { api } from '../api';
import { STATUS_TONE } from '../util';

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

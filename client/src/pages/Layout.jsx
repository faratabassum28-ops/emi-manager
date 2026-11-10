import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFetch, relTime } from '../util';
import { Modal, Field } from '../components/ui';

function ChangePassword({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState(null);
  const save = async () => {
    try { await api.post('/auth/password', { current, next }); setMsg({ ok: true, text: 'Password changed' }); } catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  return (
    <Modal title="Change password" onClose={onClose} footer={<><button onClick={onClose}>Close</button><button className="primary" onClick={save}>Save</button></>}>
      <div className="grid">
        <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters"><input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        {msg && <div className={`alert ${msg.ok ? 'success' : 'error'}`}>{msg.text}</div>}
      </div>
    </Modal>
  );
}

// Small live counts next to the work screens: what is overdue, what is due today, what Accounts still has to verify.
function usePulse() {
  const [state, setState] = useState({ pulse: null, at: null, failed: false });
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (document.hidden) return;
      try { const pulse = await api.get('/pulse'); if (live) setState({ pulse, at: new Date().toISOString(), failed: false }); } catch { if (live) setState((s) => ({ ...s, failed: true })); }
    };
    load();
    const t = setInterval(load, 60000);
    window.addEventListener('data-changed', load);
    document.addEventListener('visibilitychange', load);
    return () => { live = false; clearInterval(t); window.removeEventListener('data-changed', load); document.removeEventListener('visibilitychange', load); };
  }, []);
  return state;
}

function Badge({ n, tone }) {
  return n > 0 ? <span className={`nav-badge ${tone || ''}`}>{n}</span> : null;
}

export default function Layout() {
  const { user, logout, can } = useAuth();
  const nav = useFetch(() => api.get('/nav'));
  const [pw, setPw] = useState(false);
  const { pulse, at, failed } = usePulse();
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 30000); return () => clearInterval(t); }, []);

  useEffect(() => {
    const refresh = () => nav.reload();
    window.addEventListener('nav-refresh', refresh);
    return () => window.removeEventListener('nav-refresh', refresh);
  }, [nav.reload]);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">EMI Manager<small>MySoulSchool</small></div>
        <NavLink to="/" end>Home</NavLink>
        <div className="group">Programs</div>
        {(nav.data || []).map((p) => <NavLink key={p._id} to={`/p/${p._id}`}>{p.name}</NavLink>)}
        <div className="group">Work</div>
        <NavLink to="/tracker">EMI Tracker{pulse && (pulse.overdue > 0 ? <Badge n={pulse.overdue} tone="bad" /> : <Badge n={pulse.due_today} tone="warn" />)}</NavLink>
        {can.verify && <NavLink to="/verify">Verify payments{pulse && <Badge n={pulse.unverified} tone="warn" />}</NavLink>}
        {can.manage && (<><div className="group">Admin</div><NavLink to="/settings">Settings</NavLink><NavLink to="/import">Import students</NavLink><NavLink to="/activity">Activity log</NavLink></>)}
        <div className="spacer" />
        {pulse && pulse.promised_today > 0 && <div className="sync-note">📞 {pulse.promised_today} promised to pay today</div>}
        <div className={`sync-note ${failed ? 'behind' : ''}`}>{failed ? 'Could not refresh. Retrying…' : at ? `Updated ${relTime(at)}` : ''}</div>
        <div className="who">{user.name}<br />{user.role}</div>
        <button className="linkish" onClick={() => setPw(true)}>Change password</button>
        <button className="linkish" onClick={logout}>Sign out</button>
      </aside>
      <main className="main"><Outlet /></main>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
    </div>
  );
}

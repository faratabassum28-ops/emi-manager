import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFetch, relTime, useStored } from '../util';
import { Modal, Field, initials } from '../components/ui';
import Icon, { LogoMark } from '../components/Icon';
import CommandPalette from '../components/CommandPalette';
import StudentDrawer from '../components/StudentDrawer';
import { NetworkBanner, useTheme, useToast } from '../ui-context';

function ChangePassword({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState(null);
  const toast = useToast();
  const save = async () => {
    try { await api.post('/auth/password', { current, next }); toast.push('Password changed'); onClose(); } catch (e) { setMsg({ ok: false, text: e.message }); }
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

function Shortcuts({ onClose }) {
  const rows = [['Search students / jump to a page', ['Ctrl', 'K']], ['Search (when not typing)', ['/']], ['This help', ['?']], ['Close any window', ['Esc']]];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcuts-list">{rows.map(([l, k]) => <div key={l}><span>{l}</span><span>{k.map((x) => <kbd key={x} style={{ marginLeft: 4 }}>{x}</kbd>)}</span></div>)}</div>
      <p className="muted" style={{ marginTop: 16 }}>On a Mac, use ⌘ instead of Ctrl.</p>
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

// Backup health for Admin / Manager: a dot that turns amber when the last good backup is old, red when it is failing.
function useBackupHealth(enabled) {
  const [h, setH] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const load = () => api.get('/backup/health').then((r) => live && setH(r)).catch(() => {});
    load();
    const t = setInterval(load, 120000);
    window.addEventListener('backup-changed', load);
    return () => { live = false; clearInterval(t); window.removeEventListener('backup-changed', load); };
  }, [enabled]);
  return h;
}

const Badge = ({ n, tone }) => (n > 0 ? <span className={`nav-badge ${tone || ''}`}>{n}</span> : null);
const Link = ({ to, icon, label, end, children }) => (
  <NavLink to={to} end={end} className="nav-link" title={label}>
    <Icon name={icon} className="nav-icon" size={18} /><span className="nav-label">{label}</span>{children}
  </NavLink>
);

export default function Layout() {
  const { user, logout, can } = useAuth();
  const nav = useFetch(() => api.get('/nav'));
  const [pw, setPw] = useState(false);
  const [help, setHelp] = useState(false);
  const [palette, setPalette] = useState(false);
  const [student, setStudent] = useState(null);
  const [mobile, setMobile] = useState(false);
  const [collapsed, setCollapsed] = useStored('sidebar_collapsed', false);
  const { theme, toggle } = useTheme();
  const { pulse, at, failed } = usePulse();
  const backup = useBackupHealth(can.manage);
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const refresh = () => nav.reload();
    window.addEventListener('nav-refresh', refresh);
    return () => window.removeEventListener('nav-refresh', refresh);
  }, [nav.reload]);

  // global shortcuts
  useEffect(() => {
    const on = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      else if (!typing && !e.ctrlKey && !e.metaKey && e.key === '/') { e.preventDefault(); setPalette(true); }
      else if (!typing && e.key === '?') setHelp(true);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const closeMobile = useCallback(() => setMobile(false), []);

  const bh = backup && backup.health;
  const bTone = !backup || bh === 'ok' ? 'good' : bh === 'off' || bh === 'pending' || bh === 'stale' ? 'warn' : 'bad';
  const bText = !backup ? '' : bh === 'ok' ? `Backed up ${relTime(new Date(Date.now() - (backup.age_minutes || 0) * 60000).toISOString())}` : bh === 'off' ? 'Backup is off' : bh === 'pending' ? 'First backup pending' : bh === 'stale' ? 'Backup is out of date' : 'Backup is failing';

  return (
    <div className={`layout ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <NetworkBanner />
      <button className="mobile-menu-btn" onClick={() => setMobile(true)} aria-label="Open menu"><Icon name="menu" /></button>
      {mobile && <div className="sidebar-scrim" onClick={closeMobile} />}
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`} onClick={(e) => e.target.closest('a') && closeMobile()}>
        <div className="sidebar-top">
          <div className="brand"><LogoMark /><div className="brand-text"><div className="brand-title">EMI Manager</div><div className="brand-sub">MySoulSchool</div></div></div>
          {!collapsed && <button className="side-btn" onClick={toggle} aria-label="Switch theme" title="Switch light / dark"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /></button>}
        </div>
        <button className="side-search" onClick={() => setPalette(true)} title="Search (Ctrl K)"><Icon name="search" size={16} /><span className="nav-label">Search…</span><kbd>Ctrl K</kbd></button>
        <nav>
          <Link to="/" end icon="home" label="Home" />
          {can.manage && <Link to="/performance" icon="trophy" label="Team performance" />}
          <div className="nav-group">Programs</div>
          {(nav.data || []).map((p) => <Link key={p._id} to={`/p/${p._id}`} icon="book" label={p.name} />)}
          <div className="nav-group">Work</div>
          <Link to="/tracker" icon="calendar" label="EMI Tracker">{pulse && (pulse.overdue > 0 ? <Badge n={pulse.overdue} tone="bad" /> : <Badge n={pulse.due_today} tone="warn" />)}</Link>
          {can.verify && <Link to="/verify" icon="shield" label="Verify payments">{pulse && <Badge n={pulse.unverified} tone="warn" />}</Link>}
          {can.manage && (
            <>
              <div className="nav-group">Admin</div>
              <Link to="/settings" icon="settings" label="Settings" />
              <Link to="/import" icon="upload" label="Import students" />
              <Link to="/activity" icon="activity" label="Activity log" />
              {can.admin && <Link to="/backup" icon="database" label="Backup & restore"><span className="nav-dot" style={{ color: `var(--${bTone === 'good' ? 'good' : bTone === 'warn' ? 'warn' : 'bad'})` }} /></Link>}
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          {pulse && pulse.promised_today > 0 && <div className="chip-note warn"><Icon name="phone" size={13} /><span>{pulse.promised_today} promised to pay today</span></div>}
          {can.manage && backup && <div className={`chip-note ${bTone}`} title="Backups keep a copy of all data in your Google Sheet"><i /><span>{bText}</span></div>}
          <div className={`chip-note ${failed ? 'bad' : ''}`}><span>{failed ? 'Could not refresh. Retrying…' : at ? `Updated ${relTime(at)}` : ''}</span></div>
          <div className="user-card">
            <span className="avatar">{initials(user.name)}</span>
            <div className="user-meta"><div className="user-name">{user.name}</div><div className="user-role">{user.role}</div></div>
            <div className="user-actions">
              <button className="side-btn" onClick={() => setPw(true)} title="Change password" aria-label="Change password"><Icon name="key" size={14} /></button>
              <button className="side-btn" onClick={logout} title="Sign out" aria-label="Sign out"><Icon name="logout" size={14} /></button>
            </div>
          </div>
          <button className="side-btn" style={{ alignSelf: collapsed ? 'center' : 'flex-end' }} onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand menu' : 'Collapse menu'} title={collapsed ? 'Expand menu' : 'Collapse menu'}><Icon name={collapsed ? 'right' : 'left'} size={15} /></button>
        </div>
      </aside>
      <main className="content"><Outlet /></main>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
      {help && <Shortcuts onClose={() => setHelp(false)} />}
      {palette && <CommandPalette nav={nav.data} onClose={() => setPalette(false)} onStudent={setStudent} onTheme={toggle} onShortcuts={() => setHelp(true)} />}
      {student && <StudentDrawer enrollmentId={student} onClose={() => setStudent(null)} />}
    </div>
  );
}

// Ctrl/⌘+K: jump anywhere, or find a student by name / phone and open their quick view.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useDebounced } from '../util';
import Icon from './Icon';

export default function CommandPalette({ nav, onClose, onStudent, onTheme, onShortcuts }) {
  const { can, logout } = useAuth();
  const go = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [people, setPeople] = useState([]);
  const [sel, setSel] = useState(0);
  const inp = useRef(null);
  useEffect(() => { inp.current && inp.current.focus(); }, []);

  useEffect(() => {
    if (dq.trim().length < 2) { setPeople([]); return undefined; }
    let live = true;
    api.get(`/enrollments/search?q=${encodeURIComponent(dq.trim())}`).then((r) => live && setPeople(Array.isArray(r) ? r.slice(0, 8) : [])).catch(() => live && setPeople([]));
    return () => { live = false; };
  }, [dq]);

  const items = useMemo(() => {
    const pages = [
      { g: 'Go to', icon: 'home', label: 'Home', run: () => go('/') },
      { g: 'Go to', icon: 'calendar', label: 'EMI Tracker', sub: 'Overdue and due today', run: () => go('/tracker') },
      ...(can.verify ? [{ g: 'Go to', icon: 'shield', label: 'Verify payments', run: () => go('/verify') }] : []),
      ...(can.manage ? [{ g: 'Go to', icon: 'users', label: 'Team performance', run: () => go('/performance') }, { g: 'Go to', icon: 'activity', label: 'Activity log', run: () => go('/activity') }, { g: 'Go to', icon: 'upload', label: 'Import students', run: () => go('/import') }, { g: 'Go to', icon: 'settings', label: 'Settings', run: () => go('/settings') }] : []),
      ...(can.admin ? [{ g: 'Go to', icon: 'database', label: 'Backup & restore', sub: 'Keep your data safe', run: () => go('/backup') }] : []),
      ...(nav || []).flatMap((p) => [
        { g: 'Programs', icon: 'book', label: p.name, run: () => go(`/p/${p._id}`) },
        ...(p.batches || []).map((b) => ({ g: 'Programs', icon: 'book', label: `${p.name} · ${b.batch_name}`, run: () => go(`/p/${p._id}/${b._id}`) })),
      ]),
      { g: 'Actions', icon: 'sun', label: 'Switch light / dark theme', run: onTheme },
      { g: 'Actions', icon: 'keyboard', label: 'Keyboard shortcuts', run: onShortcuts },
      { g: 'Actions', icon: 'logout', label: 'Sign out', run: logout },
    ];
    const needle = q.trim().toLowerCase();
    const matched = needle ? pages.filter((p) => `${p.label} ${p.sub || ''}`.toLowerCase().includes(needle)) : pages.slice(0, 7);
    const students = people.map((p) => ({ g: 'Students', icon: 'users', label: p.name || p.student_name, sub: [p.phone, p.program, p.batch || p.batch_name, p.status].filter(Boolean).join(' · '), run: () => onStudent(p.enrollment_id || p.id) }));
    return [...students, ...matched];
  }, [q, people, nav, can, go, logout, onStudent, onTheme, onShortcuts]);

  useEffect(() => setSel(0), [q, people.length]);
  const run = (it) => { onClose(); it.run(); };
  const key = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && items[sel]) run(items[sel]);
  };
  let last = '';
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={key}>
        <div className="palette-input"><Icon name="search" /><input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search students by name or phone, or jump to a page…" aria-label="Search" /></div>
        <div className="palette-list">
          {items.map((it, i) => {
            const head = it.g !== last ? <div className="palette-group" key={`g${i}`}>{it.g}</div> : null; last = it.g;
            return (
              <div key={i}>
                {head}
                <button className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(it)}>
                  <span className="pi-ico"><Icon name={it.icon} size={16} /></span>
                  <span><div>{it.label}</div>{it.sub && <div className="pi-sub">{it.sub}</div>}</span>
                </button>
              </div>
            );
          })}
          {!items.length && <div className="empty">No match for “{q}”.</div>}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}

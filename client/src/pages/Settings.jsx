import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { inr, fmtDate, useFetch } from '../util';
import { Badge, ErrorBox, Field, Loading, Modal, Tabs } from '../components/ui';

const TABS = [
  { key: 'programs', label: 'Programs' }, { key: 'batches', label: 'Batches' }, { key: 'adjustments', label: 'Previous-program adjustments' },
  { key: 'modes', label: 'Payment modes' }, { key: 'rules', label: 'Reminder rules' }, { key: 'templates', label: 'Message templates' }, { key: 'users', label: 'Users & roles' },
];

export default function Settings() {
  const [tab, setTab] = useState('programs');
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><div className="muted">Everything in a dropdown is controlled here. Nothing is hard-coded.</div></div></div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'programs' && <Programs />}
      {tab === 'batches' && <Batches />}
      {tab === 'adjustments' && <Adjustments />}
      {tab === 'modes' && <Modes />}
      {tab === 'rules' && <Rules />}
      {tab === 'templates' && <Templates />}
      {tab === 'users' && <Users />}
    </>
  );
}

const refreshNav = () => window.dispatchEvent(new Event('nav-refresh'));
const Msg = ({ m }) => (m ? <div className={`alert ${m.ok ? 'success' : 'error'}`}>{m.text}</div> : null);

/* ---------------- Programs ---------------- */
function Programs() {
  const { data, loading, error, reload } = useFetch(() => api.get('/programs'));
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Loading />;
  return (
    <>
      <ErrorBox error={error} />
      <p><button className="primary" onClick={() => setEdit({ name: '', default_fee: '', default_application_fee: '', default_commitment_fee: '', max_emis: 12, active: true })}>+ New program</button></p>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th className="num">Default fee</th><th className="num">Application fee</th><th className="num">Commitment fee</th><th className="num">Max EMIs</th><th>Status</th><th /></tr></thead>
        <tbody>{(data || []).map((p) => (
          <tr key={p._id}><td>{p.name}</td><td className="num">{inr(p.default_fee)}</td><td className="num">{inr(p.default_application_fee)}</td><td className="num">{inr(p.default_commitment_fee)}</td><td className="num">{p.max_emis}</td>
            <td><Badge status={p.active ? 'Active' : 'Paused'}>{p.active ? 'Active' : 'Hidden'}</Badge></td><td><button className="small" onClick={() => setEdit(p)}>Edit</button></td></tr>))}</tbody>
      </table></div>
      {edit && <ProgramForm p={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); refreshNav(); }} />}
    </>
  );
}
function ProgramForm({ p, onClose, onDone }) {
  const [f, setF] = useState({ ...p });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      const body = { ...f, default_fee: Number(f.default_fee), default_application_fee: Number(f.default_application_fee || 0), default_commitment_fee: Number(f.default_commitment_fee || 0), max_emis: Number(f.max_emis) };
      if (p._id) await api.put(`/programs/${p._id}`, body); else await api.post('/programs', body);
      onDone();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={p._id ? 'Edit program' : 'New program'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Name" span="all"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Default fee (₹)"><input type="number" value={f.default_fee} onChange={(e) => set('default_fee', e.target.value)} /></Field>
        <Field label="Max EMIs"><input type="number" min="1" value={f.max_emis} onChange={(e) => set('max_emis', e.target.value)} /></Field>
        <Field label="Default application fee (₹)" hint="Optional"><input type="number" value={f.default_application_fee} onChange={(e) => set('default_application_fee', e.target.value)} /></Field>
        <Field label="Default commitment fee (₹)" hint="Optional"><input type="number" value={f.default_commitment_fee} onChange={(e) => set('default_commitment_fee', e.target.value)} /></Field>
      </div>
      <label className="row" style={{ marginTop: 12 }}><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active (inactive programs are hidden from the menu)</label>
      {err && <div className="alert error">{err}</div>}
    </Modal>
  );
}

/* ---------------- Batches ---------------- */
function Batches() {
  const { data, loading, error, reload } = useFetch(() => api.get('/batches?include_archived=1'));
  const programs = useFetch(() => api.get('/programs'));
  const users = useFetch(() => api.get('/users'));
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState('');
  if (loading && !data) return <Loading />;
  const archive = async (b, status) => { setMsg(''); try { await api.put(`/batches/${b._id}`, { status }); reload(); refreshNav(); } catch (e) { setMsg(e.message); } };
  return (
    <>
      <ErrorBox error={error} />
      {msg && <div className="alert error">{msg}</div>}
      <p><button className="primary" onClick={() => setEdit({ program: (programs.data || []).find((p) => p.active)?._id || (programs.data || [])[0]?._id || '', batch_name: '', start_date: '', end_date: '', fee_override: '', status: 'Upcoming', owner: '' })}>+ New Batch</button></p>
      <p className="muted">Saving a batch instantly adds a tab under its program. Batches with enrollments can be archived but never deleted.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Program</th><th>Batch</th><th>Dates</th><th className="num">Fee override</th><th>Owner</th><th>Status</th><th /></tr></thead>
        <tbody>{(data || []).map((b) => (
          <tr key={b._id}><td>{b.code}</td><td>{b.program && b.program.name}</td><td>{b.batch_name}</td><td>{fmtDate(b.start_date)} → {fmtDate(b.end_date)}</td><td className="num">{b.fee_override ? inr(b.fee_override) : '—'}</td><td>{b.owner ? b.owner.name : '—'}</td><td><Badge status={b.status === 'Archived' ? 'Dropped' : 'Active'}>{b.status}</Badge></td>
            <td className="nowrap"><button className="small" onClick={() => setEdit({ ...b, program: b.program._id, owner: b.owner ? b.owner._id : '', fee_override: b.fee_override ?? '' })}>Edit</button>{' '}
              {b.status === 'Archived' ? <button className="small" onClick={() => archive(b, 'Running')}>Restore</button> : <button className="small" onClick={() => archive(b, 'Archived')}>Archive</button>}</td></tr>))}</tbody>
      </table></div>
      {edit && <BatchForm b={edit} programs={programs.data || []} users={users.data || []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); refreshNav(); }} />}
    </>
  );
}
function BatchForm({ b, programs, users, onClose, onDone }) {
  const [f, setF] = useState({ ...b });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      const body = { batch_name: f.batch_name, start_date: f.start_date || '', end_date: f.end_date || '', fee_override: f.fee_override === '' ? '' : Number(f.fee_override), status: f.status, owner: f.owner || '' };
      if (b._id) await api.put(`/batches/${b._id}`, body); else await api.post('/batches', { ...body, program: f.program });
      onDone();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={b._id ? 'Edit batch' : 'New batch'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Program"><select value={f.program} onChange={(e) => set('program', e.target.value)} disabled={!!b._id}>{programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select></Field>
        <Field label="Batch name"><input value={f.batch_name} onChange={(e) => set('batch_name', e.target.value)} placeholder="Batch 7 – Oct 2026" /></Field>
        <Field label="Start date"><input type="date" value={f.start_date || ''} onChange={(e) => set('start_date', e.target.value)} /></Field>
        <Field label="End date"><input type="date" value={f.end_date || ''} onChange={(e) => set('end_date', e.target.value)} /></Field>
        <Field label="Fee override (₹)" hint="Only if this batch has a different price"><input type="number" value={f.fee_override} onChange={(e) => set('fee_override', e.target.value)} /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => set('status', e.target.value)}>{['Upcoming', 'Running', 'Completed', 'Archived'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Collections owner (CRM)"><select value={f.owner} onChange={(e) => set('owner', e.target.value)}><option value="">— none —</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Field>
      </div>
      {err && <div className="alert error">{err}</div>}
    </Modal>
  );
}

/* ---------------- Previous-program adjustments ---------------- */
function Adjustments() {
  const { data, loading, error, reload } = useFetch(() => api.get('/adjustment-types'));
  const programs = useFetch(() => api.get('/programs'));
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState('');
  if (loading && !data) return <Loading />;
  const toggle = async (t) => { setMsg(''); try { await api.put(`/adjustment-types/${t._id}`, { active: !t.active }); reload(); } catch (e) { setMsg(e.message); } };
  return (
    <>
      <ErrorBox error={error} />
      {msg && <div className="alert error">{msg}</div>}
      <p><button className="primary" onClick={() => setEdit({ name: '', default_amount: '', active: true, target_programs: [] })}>+ New adjustment</button></p>
      <p className="muted">Programs whose fees can be credited against a new enrollment. Leave “only for” empty to allow any program.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th className="num">Default amount</th><th>Only for</th><th>Active</th><th /></tr></thead>
        <tbody>{(data || []).map((t) => (
          <tr key={t._id}><td>{t.name}</td><td className="num">{inr(t.default_amount)}</td><td>{t.target_programs.length ? t.target_programs.map((id) => (programs.data || []).find((p) => p._id === id)?.name).filter(Boolean).join(', ') : 'Any program'}</td>
            <td><input type="checkbox" checked={t.active} onChange={() => toggle(t)} aria-label={`Toggle ${t.name}`} /></td><td><button className="small" onClick={() => setEdit(t)}>Edit</button></td></tr>))}</tbody>
      </table></div>
      {edit && <AdjForm t={edit} programs={programs.data || []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </>
  );
}
function AdjForm({ t, programs, onClose, onDone }) {
  const [f, setF] = useState({ ...t });
  const [err, setErr] = useState('');
  const toggleProg = (id) => setF((x) => ({ ...x, target_programs: x.target_programs.includes(id) ? x.target_programs.filter((i) => i !== id) : [...x.target_programs, id] }));
  const save = async () => {
    try {
      const body = { name: f.name, default_amount: Number(f.default_amount || 0), active: f.active, target_programs: f.target_programs };
      if (t._id) await api.put(`/adjustment-types/${t._id}`, body); else await api.post('/adjustment-types', body);
      onDone();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={t._id ? 'Edit adjustment' : 'New adjustment'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <div className="grid">
        <Field label="Program name (e.g. Tarot L1)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Default credit (₹)"><input type="number" value={f.default_amount} onChange={(e) => setF({ ...f, default_amount: e.target.value })} /></Field>
        <div><span className="field-label">Only credited against</span>{programs.map((p) => <label key={p._id} className="row"><input type="checkbox" checked={f.target_programs.includes(p._id)} onChange={() => toggleProg(p._id)} /> {p.name}</label>)}</div>
        {err && <div className="alert error">{err}</div>}
      </div>
    </Modal>
  );
}

/* ---------------- Payment modes / rules / templates (one settings document) ---------------- */
function useSettingsForm() {
  const { data, loading, error, reload } = useFetch(() => api.get('/settings'));
  const [m, setM] = useState(null);
  const save = async (patch) => {
    setM(null);
    try { await api.put('/settings', patch); setM({ ok: true, text: 'Saved' }); reload(); } catch (e) { setM({ ok: false, text: e.message }); }
  };
  return { data, loading, error, save, m };
}

function Modes() {
  const { data, loading, save, m } = useSettingsForm();
  const [list, setList] = useState(null);
  useEffect(() => { if (data) setList(data.payment_modes); }, [data]);
  if (loading || !list) return <Loading />;
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h2>Payment modes</h2>
      {list.map((x, i) => <div className="row" key={i} style={{ marginBottom: 6 }}><input value={x} onChange={(e) => setList(list.map((y, j) => (j === i ? e.target.value : y)))} /><button className="small danger" onClick={() => setList(list.filter((_, j) => j !== i))}>Remove</button></div>)}
      <p><button onClick={() => setList([...list, ''])}>+ Add mode</button></p>
      <Msg m={m} />
      <button className="primary" onClick={() => save({ payment_modes: list })}>Save</button>
    </div>
  );
}

function Rules() {
  const { data, loading, save, m } = useSettingsForm();
  const [r, setR] = useState(null);
  const [limit, setLimit] = useState('');
  const [link, setLink] = useState('');
  useEffect(() => { if (data) { setR(data.reminder); setLimit(String(data.discount_limit)); setLink(data.payment_link_base || ''); } }, [data]);
  if (loading || !r) return <Loading />;
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h2>Reminder rules</h2>
      <div className="form-grid">
        <Field label="Start reminding (days before due)"><input type="number" min="0" value={r.days_before} onChange={(e) => setR({ ...r, days_before: e.target.value })} /></Field>
        <Field label="Grace period (days)" hint="Paid within this many days after the due date still counts as on time"><input type="number" min="0" value={r.grace_days} onChange={(e) => setR({ ...r, grace_days: e.target.value })} /></Field>
        <Field label="Defaulter threshold (days overdue)"><input type="number" min="0" value={r.defaulter_days} onChange={(e) => setR({ ...r, defaulter_days: e.target.value })} /></Field>
        <Field label="Discount needing Manager approval (₹ above)"><input type="number" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        <Field label="Payment link (used as {payment_link})" span="all" hint="Optional. One shared link until per-instalment links arrive in a later phase."><input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></Field>
      </div>
      <Msg m={m} />
      <button className="primary" style={{ marginTop: 10 }} onClick={() => save({ reminder: { days_before: Number(r.days_before), grace_days: Number(r.grace_days), defaulter_days: Number(r.defaulter_days) }, discount_limit: Number(limit), payment_link_base: link })}>Save</button>
    </div>
  );
}

const TPL = [
  ['before3', '3 days before due'], ['due_today', 'Due today'], ['overdue1', '1 day overdue'], ['overdue7', '7 days overdue'], ['thanks', 'Payment received (thank-you)'], ['welcome', 'Welcome with schedule'],
];
function Templates() {
  const { data, loading, save, m } = useSettingsForm();
  const [t, setT] = useState(null);
  useEffect(() => { if (data) setT(data.templates); }, [data]);
  if (loading || !t) return <Loading />;
  return (
    <div className="card">
      <h2>Message templates</h2>
      <p className="muted">Placeholders: {'{name} {amount} {due_date} {emi_number} {payment_link}'}. Thank-you also supports {'{paid_date} {ref} {next_amount} {next_due_date}'}; welcome supports {'{schedule}'}.</p>
      <div className="grid">{TPL.map(([k, label]) => <Field key={k} label={label}><textarea value={t[k] || ''} onChange={(e) => setT({ ...t, [k]: e.target.value })} /></Field>)}</div>
      <Msg m={m} />
      <button className="primary" style={{ marginTop: 10 }} onClick={() => save({ templates: t })}>Save templates</button>
    </div>
  );
}

/* ---------------- Users & roles ---------------- */
function Users() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useFetch(() => api.get('/users'));
  const batches = useFetch(() => api.get('/batches'));
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Loading />;
  return (
    <>
      <ErrorBox error={error} />
      {can.admin ? <p><button className="primary" onClick={() => setEdit({ name: '', email: '', password: '', role: 'CRM', batches: [], can_verify: false, active: true, isNew: true })}>+ Invite user</button></p> : <div className="alert info">Only Admins can add or change users.</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Restricted to</th><th>Verifies payments</th><th>Active</th>{can.admin && <th />}</tr></thead>
        <tbody>{(data || []).map((u) => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.batches && u.batches.length ? `${u.batches.length} batch(es)` : 'All'}</td><td>{u.role === 'Admin' || u.role === 'Manager' || u.can_verify ? '✓' : '—'}</td><td>{u.active ? 'Yes' : <span className="red-text">No</span>}</td>
            {can.admin && <td><button className="small" onClick={() => setEdit({ ...u, password: '' })}>Edit</button></td>}</tr>))}</tbody>
      </table></div>
      {edit && <UserForm u={edit} batches={batches.data || []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </>
  );
}
function UserForm({ u, batches, onClose, onDone }) {
  const [f, setF] = useState({ ...u });
  const [err, setErr] = useState('');
  const toggleBatch = (id) => setF((x) => ({ ...x, batches: x.batches.includes(id) ? x.batches.filter((i) => i !== id) : [...x.batches, id] }));
  const save = async () => {
    try {
      const body = { name: f.name, role: f.role, batches: f.role === 'CRM' ? f.batches : [], can_verify: f.can_verify, active: f.active };
      if (u.isNew) await api.post('/users', { ...body, email: f.email, password: f.password });
      else await api.put(`/users/${u.id}`, { ...body, ...(f.password ? { password: f.password } : {}) });
      onDone();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={u.isNew ? 'Invite user' : 'Edit user'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!u.isNew} /></Field>
        <Field label={u.isNew ? 'Temporary password' : 'Reset password (optional)'} hint="At least 8 characters"><input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option>Admin</option><option>Manager</option><option>CRM</option><option>Viewer</option></select></Field>
      </div>
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.can_verify} onChange={(e) => setF({ ...f, can_verify: e.target.checked })} /> Can verify payments (for Accounts / Viewer)</label>
      {!u.isNew && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
      {f.role === 'CRM' && (
        <div style={{ marginTop: 10 }}><span className="field-label">Restrict to batches (none ticked = all batches)</span>
          {batches.map((b) => <label key={b._id} className="row"><input type="checkbox" checked={f.batches.includes(b._id)} onChange={() => toggleBatch(b._id)} /> {b.program && b.program.name} · {b.batch_name}</label>)}</div>
      )}
      {err && <div className="alert error">{err}</div>}
    </Modal>
  );
}

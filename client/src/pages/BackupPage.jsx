import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDateTime, relTime, useFetch } from '../util';
import { Loading, ErrorBox, Empty, Modal } from '../components/ui';
import Icon from '../components/Icon';
import { useToast } from '../ui-context';

const HEALTH = {
  ok: ['ok', 'checkc', 'Your data is safely backed up'],
  pending: ['pending', 'clock', 'Waiting for the first backup'],
  stale: ['stale', 'alert', 'Backup is out of date'],
  failing: ['failing', 'alert', 'The last backup failed'],
  off: ['off', 'cloud', 'Automatic backup is off'],
};
const changed = () => window.dispatchEvent(new Event('backup-changed'));
const ago = (m) => (m === null || m === undefined ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`);

function Switch({ checked, onChange, children }) {
  return <label className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span className="track" /><span>{children}</span></label>;
}

export default function BackupPage() {
  const toast = useToast();
  const { data: st, loading, error, reload } = useFetch(() => api.get('/backup/status'));
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState('');
  const [script, setScript] = useState('');
  const [tested, setTested] = useState(null);
  const [audit, setAudit] = useState(null);
  const [restore, setRestore] = useState(false);

  useEffect(() => { if (st) setCfg((c) => c || { ...st.config }); }, [st]);
  useEffect(() => { if (!st || !st.running) return undefined; const t = setInterval(reload, 4000); return () => clearInterval(t); }, [st, reload]);

  if (loading && !st) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!cfg) return <Loading />;

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); if (ok) toast.push(typeof ok === 'function' ? ok(r) : ok); return r; } catch (e) { toast.push(e.message, 'bad', 6000); } finally { setBusy(''); reload(); changed(); }
    return null;
  };
  const save = (patch = {}) => run('save', async () => { const out = await api.put('/backup/settings', { ...cfg, ...patch }); setCfg({ ...out.config }); return out; }, 'Settings saved');
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

  const [hk, hico, htxt] = HEALTH[st.health] || HEALTH.off;
  const showScript = async () => { try { setScript(await api.text('/backup/apps-script')); } catch (e) { toast.push(e.message, 'bad'); } };
  const copy = (t) => { navigator.clipboard.writeText(t).then(() => toast.push('Copied'), () => toast.push('Could not copy; select and copy it manually', 'bad')); };
  const download = (files) => run('dl' + files, () => api.download(`/backup/download${files ? '?files=1' : ''}`, `emi-manager-backup${files ? '-with-files' : ''}.json`), 'Backup file downloaded');

  return (
    <>
      <div className="page-head"><div><h1>Backup & restore</h1><div className="muted">Your students, EMIs and payments, copied somewhere safe automatically</div></div></div>

      <div className={`health ${hk}`}>
        <div className="health-ico"><Icon name={hico} size={26} /></div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2>{st.running ? 'Backing up now…' : htxt}</h2>
          <div className="muted">
            {st.last_ok_at ? <>Last good backup {ago(st.age_minutes)} · {fmtDateTime(st.last_ok_at)}</> : 'No backup has completed yet.'}
            {st.last_error && <div className="red-text">Last error: {st.last_error}</div>}
          </div>
        </div>
        <div className="row">
          <button className="primary" disabled={!!busy || st.running || !st.config.has_secret || !st.config.url} onClick={() => run('run', () => api.post('/backup/run'), (r) => `Backed up ${Object.values(r.counts || {}).reduce((a, b) => a + b, 0)} records to Google Sheets`)}>
            <Icon name="refresh" size={15} /> {busy === 'run' ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 16, alignItems: 'start' }}>
        <div className="card">
          <h2><Icon name="download" size={16} /> Download a copy</h2>
          <p className="muted">One file with everything. Keep it on your computer or drive. It contains every phone number and payment, so store it safely.</p>
          <div className="row">
            <button onClick={() => download(false)} disabled={!!busy}>Data only</button>
            <button onClick={() => download(true)} disabled={!!busy}>Data + payment proofs</button>
          </div>
        </div>
        <div className="card">
          <h2><Icon name="shield" size={16} /> Data check</h2>
          <p className="muted">Looks for records that don't add up: orphaned entries, balances that differ from the ledger, missing proof files.</p>
          <button disabled={busy === 'audit'} onClick={async () => { const r = await run('audit', () => api.get('/backup/audit')); if (r) setAudit(r); }}>{busy === 'audit' ? 'Checking…' : 'Run check'}</button>
          {audit && (
            <div style={{ marginTop: 12 }}>
              <div className={`alert ${audit.ok ? 'ok' : 'error'}`}>{audit.ok ? 'No errors found' : `${audit.errors} error(s)`}{audit.warnings ? ` · ${audit.warnings} warning(s)` : ''}</div>
              {audit.issues.map((i) => <div key={i.code} className="muted" style={{ marginTop: 6 }}><b className={i.level === 'error' ? 'red-text' : ''}>{i.count || ''}</b> {i.text}</div>)}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2><Icon name="cloud" size={16} /> Google Sheets backup</h2>
        <ol className="steps-list">
          <li><div><b>Create a secret key</b> <span className="muted">(a password between this site and your sheet)</span><div className="row" style={{ marginTop: 6 }}>
            <button disabled={!!busy} onClick={() => run('gen', async () => { const o = await api.put('/backup/settings', { ...cfg, generate_secret: true }); setCfg({ ...o.config }); }, 'Secret key created')}>{st.config.has_secret ? 'Make a new key' : 'Generate key'}</button>
            {st.config.has_secret && <span className="chip good">key is set</span>}
          </div>{st.config.has_secret && <div className="muted" style={{ marginTop: 4 }}>If you make a new key, re-copy the script below and redeploy it.</div>}</div></li>
          <li><div><b>Make the sheet</b>: create a new Google Sheet, open <i>Extensions → Apps Script</i>, delete what's there and paste the script below.
            <div className="row" style={{ marginTop: 6 }}>
              <button disabled={!st.config.has_secret} onClick={showScript}>Show script</button>
              {script && <button onClick={() => copy(script)}><Icon name="copy" size={14} /> Copy script</button>}
            </div>
            {script && <pre className="code" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{script.slice(0, 1200)}{script.length > 1200 ? '\n… (use Copy script for the full text)' : ''}</pre>}
          </div></li>
          <li><div><b>Deploy it</b>: in Apps Script click <i>Deploy → New deployment → Web app</i>. Execute as <i>Me</i>, access <i>Anyone</i>. Authorise, then copy the Web app link.</div></li>
          <li><div><b>Paste the link</b>
            <div className="row" style={{ marginTop: 6 }}>
              <input style={{ flex: 1, minWidth: 220 }} placeholder="https://script.google.com/macros/s/…/exec" value={cfg.url || ''} onChange={(e) => set('url', e.target.value)} />
              <button disabled={!!busy} onClick={async () => { await save(); const r = await run('test', () => api.post('/backup/test'), 'Connected to your sheet'); if (r) setTested(r); }}>{busy === 'test' ? 'Testing…' : 'Save & test'}</button>
            </div>
            {tested && <div className="alert ok" style={{ marginTop: 8 }}>Connected to “{tested.sheet_name}”. <a href={tested.sheet_url} target="_blank" rel="noreferrer">Open sheet</a></div>}
          </div></li>
        </ol>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2><Icon name="clock" size={16} /> Schedule</h2>
        <div className="grid two">
          <Switch checked={!!cfg.enabled} onChange={(v) => set('enabled', v)}>Automatic backups on</Switch>
          <Switch checked={cfg.on_change !== false} onChange={(v) => set('on_change', v)}>Back up soon after data changes</Switch>
        </div>
        <div className="grid kpis" style={{ marginTop: 12 }}>
          <label className="field"><span className="field-label">At most once every (minutes)</span><input type="number" min="5" value={cfg.interval_minutes} onChange={(e) => set('interval_minutes', Number(e.target.value))} /></label>
          <label className="field"><span className="field-label">Daily backup hour (IST, 0–23)</span><input type="number" min="0" max="23" value={cfg.daily_hour} onChange={(e) => set('daily_hour', Number(e.target.value))} /></label>
          <label className="field"><span className="field-label">Dated copies to keep in Drive</span><input type="number" min="0" value={cfg.keep_copies} onChange={(e) => set('keep_copies', Number(e.target.value))} /></label>
        </div>
        <button className="primary" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => save()}>Save settings</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><h2 style={{ margin: 0 }}><Icon name="upload" size={16} /> Restore</h2><div className="muted">Bring data back from a backup file or from your Google Sheet. You always see a preview first, and nothing is ever deleted.</div></div>
          <button onClick={() => setRestore(true)}>Start restore</button>
        </div>
      </div>

      <h2 style={{ marginTop: 22 }}>Backup history</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Trigger</th><th>Result</th><th className="num">Time</th><th>Records</th><th>By</th></tr></thead>
          <tbody>{st.recent.map((r) => (
            <tr key={r._id}>
              <td title={fmtDateTime(r.createdAt)}>{relTime(r.createdAt)}</td><td>{r.trigger}</td>
              <td>{r.ok ? <span className="badge b-green">OK</span> : <span className="badge b-red" title={r.error}>Failed</span>}</td>
              <td className="num">{r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '—'}</td>
              <td className="muted">{r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : '—'}</td><td>{r.by || '—'}</td>
            </tr>))}</tbody>
        </table>
        {!st.recent.length && <Empty icon="cloud">No backups yet.</Empty>}
      </div>
      {restore && <RestoreModal hasSheet={!!(st.config.url && st.config.has_secret)} onClose={() => setRestore(false)} />}
    </>
  );
}

function RestoreModal({ hasSheet, onClose }) {
  const toast = useToast();
  const [source, setSource] = useState('file');
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('missing');
  const [prev, setPrev] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  const send = async (confirm) => {
    const fd = new FormData();
    fd.append('source', source); fd.append('mode', mode);
    if (source === 'file') { if (!file) { setErr('Choose a backup file first'); return; } fd.append('file', file); }
    if (confirm) fd.append('confirm', 'RESTORE');
    setBusy(true); setErr('');
    try {
      const r = await api.postForm('/backup/restore', fd);
      if (confirm) { setDone(true); toast.push('Restore complete'); changed(); } else setPrev(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const reset = () => { setPrev(null); setTyped(''); setDone(false); };
  return (
    <Modal title="Restore data" onClose={onClose} wide>
      <div className="grid" style={{ gap: 12 }}>
        <div className="seg">
          <button className={source === 'file' ? 'on active' : ''} onClick={() => { setSource('file'); reset(); }}>From a file</button>
          <button className={source === 'sheet' ? 'on active' : ''} disabled={!hasSheet} onClick={() => { setSource('sheet'); reset(); }}>From Google Sheet</button>
        </div>
        {source === 'file' && <input type="file" accept=".json,application/json" onChange={(e) => { setFile(e.target.files[0] || null); reset(); }} />}
        <label className="field"><span className="field-label">What should happen to records that already exist?</span>
          <select value={mode} onChange={(e) => { setMode(e.target.value); reset(); }}>
            <option value="missing">Only add what is missing (safest)</option>
            <option value="overwrite">Add missing and overwrite existing with the backup version</option>
          </select>
        </label>
        {err && <div className="alert error">{err}</div>}
        {!prev && <button className="primary" disabled={busy} onClick={() => send(false)}>{busy ? 'Reading…' : 'Preview restore'}</button>}
        {prev && !done && (
          <>
            <div className="table-wrap"><table>
              <thead><tr><th>Data</th><th className="num">In backup</th><th className="num">Already here</th><th className="num">Will add</th>{mode === 'overwrite' && <th className="num">Will replace</th>}</tr></thead>
              <tbody>{Object.entries(prev.report).map(([k, r]) => <tr key={k}><td>{k}</td><td className="num">{r.in_backup}</td><td className="num">{r.already_there}</td><td className="num">{r.added}</td>{mode === 'overwrite' && <td className="num">{r.replaced}</td>}</tr>)}</tbody>
            </table></div>
            <div className="muted">This was only a preview. Nothing has been changed yet.</div>
            <label className="field"><span className="field-label">Type RESTORE to apply it</span><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RESTORE" /></label>
            <button className="primary" disabled={busy || typed !== 'RESTORE'} onClick={() => send(true)}>{busy ? 'Restoring…' : 'Restore now'}</button>
          </>
        )}
        {done && <div className="alert ok">Restore finished. Your data is back.</div>}
      </div>
    </Modal>
  );
}

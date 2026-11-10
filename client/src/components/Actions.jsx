// Shared row actions: Log call, Send WhatsApp, Record payment (spec sections 7 and 8).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Modal, Field, FileInput } from './ui';
import { inr, fmtDate, todayIST, useFetch } from '../util';

/* ---------------- WhatsApp: pre-filled template, logs a reminder when sent ---------------- */
export async function sendWhatsApp(instalmentId) {
  const w = window.open('', '_blank'); // opened synchronously so pop-up blockers allow it
  try {
    const msg = await api.post(`/instalments/${instalmentId}/whatsapp`);
    if (w) w.location.href = msg.wa; else window.location.href = msg.wa;
    return null;
  } catch (e) {
    if (w) w.close();
    return e.message;
  }
}

/* ---------------- Log call ---------------- */
const OUTCOMES = ['Paid', 'Will pay on date', 'No answer', 'Asked for extension', 'Dispute'];
export function LogCall({ instalmentId, who, onClose, onDone }) {
  const [outcome, setOutcome] = useState('No answer');
  const [promised, setPromised] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const needsDate = outcome === 'Will pay on date' || outcome === 'Asked for extension';
  const save = async () => {
    setErr('');
    try {
      await api.post('/reminders', { instalment: instalmentId, channel: 'Call', outcome, promised_date: needsDate ? promised : undefined, notes });
      onDone();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={`Log call${who ? ` · ${who}` : ''}`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <div className="grid">
        <Field label="Outcome"><select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select></Field>
        {needsDate && <Field label="Promised date" hint="The row leaves the overdue queue until this date"><input type="date" value={promised} min={todayIST()} onChange={(e) => setPromised(e.target.value)} /></Field>}
        <Field label="Note"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {err && <div className="alert error">{err}</div>}
      </div>
    </Modal>
  );
}

/* ---------------- Record payment ---------------- */
export function RecordPayment({ enrollmentId, instalmentId, studentLabel, onClose, onDone }) {
  const settings = useFetch(() => api.get('/settings'));
  const detail = useFetch(() => (enrollmentId ? api.get(`/enrollments/${enrollmentId}`) : Promise.resolve(null)), [enrollmentId]);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState([]);
  const [enrId, setEnrId] = useState(enrollmentId || '');
  const [d, setD] = useState(null);

  // free-search path (no enrollment preselected)
  useEffect(() => {
    if (enrollmentId || search.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => api.get(`/enrollments/search?q=${encodeURIComponent(search)}`).then(setFound).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [search, enrollmentId]);
  useEffect(() => { if (enrollmentId) setD(detail.data); }, [detail.data, enrollmentId]);
  useEffect(() => { if (enrId && !enrollmentId) api.get(`/enrollments/${enrId}`).then(setD).catch(() => setD(null)); }, [enrId, enrollmentId]);

  const open = useMemo(() => (d ? d.instalments.filter((i) => i.balance > 0 && i.status !== 'Waived') : []), [d]);
  const [pick, setPick] = useState(instalmentId || '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIST());
  const [mode, setMode] = useState('');
  const [shot, setShot] = useState('');
  const [note, setNote] = useState('');
  const [foreignCur, setForeignCur] = useState('');
  const [foreignAmt, setForeignAmt] = useState('');
  const [changeNext, setChangeNext] = useState(false);
  const [nextDate, setNextDate] = useState('');
  const [nextReason, setNextReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const oldest = open.filter((i) => i.type === 'EMI' || true).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  useEffect(() => { if (!pick && oldest) setPick(oldest.id); }, [oldest, pick]);
  useEffect(() => { if (!mode && settings.data) setMode(settings.data.payment_modes[0]); }, [settings.data, mode]);
  const picked = open.find((i) => i.id === pick);
  useEffect(() => { if (picked && !amount) setAmount(String(picked.balance)); }, [picked]); // eslint-disable-line

  // live allocation preview (what the system will clear, and the excess rule)
  useEffect(() => {
    const n = Number(amount);
    if (!d || !n || n <= 0 || !Number.isInteger(n)) { setPreview(null); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.post('/payments/preview', { enrollment: d.enrollment.id, instalments: pick ? [pick] : [], amount: n, payment_date: date })
        .then((r) => { if (live) { setPreview(r.preview); setErr(''); } })
        .catch((e) => { if (live) { setPreview(null); setErr(e.message); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [d, pick, amount, date]);

  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api.post('/payments', {
        enrollment: d.enrollment.id, instalments: pick ? [pick] : [], amount: Number(amount), payment_date: date, mode, screenshot: shot, note,
        original_currency: foreignCur || undefined, original_amount: foreignAmt ? Number(foreignAmt) : undefined,
        next_due_date: changeNext ? nextDate : undefined, next_reason: changeNext ? nextReason : undefined,
      });
      const thanks = await api.get(`/payments/${r.id}/thanks`).catch(() => null);
      setDone({ ...r, thanks });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Modal title="Payment recorded" onClose={() => onDone()} footer={<button className="primary" onClick={() => onDone()}>Done</button>}>
        <div className="alert success">Saved. It now appears in Accounts' “to verify” list.</div>
        <table><tbody>{done.preview.map((p) => <tr key={p.instalment_id}><td>{p.label}</td><td className="num">{inr(p.paying)}</td><td><span className="muted">→ {p.status_after}{p.remaining_after ? `, ${inr(p.remaining_after)} left` : ''}</span></td></tr>)}</tbody></table>
        <p>{done.next ? <>Next EMI: <b>{inr(done.next.amount)}</b> due <b>{fmtDate(done.next.due_date)}</b> (EMI {done.next.emi_number}).</> : <b>All instalments are now paid.</b>}</p>
        {done.thanks && <a className="btn" href={done.thanks.wa} target="_blank" rel="noreferrer">Send thank-you on WhatsApp</a>}
      </Modal>
    );
  }

  const modes = settings.data ? settings.data.payment_modes : [];
  const intl = /international/i.test(mode);
  const ready = d && Number(amount) > 0 && date && mode && ref.trim() && shot && !busy && (!changeNext || (nextDate && nextReason.trim()));

  return (
    <Modal title="Record payment" wide onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ready} onClick={save}>{busy ? 'Saving…' : 'Save payment'}</button></>}>
      <div className="grid">
        {!enrollmentId && (
          <Field label="Student" hint="Search by name or phone">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Start typing…" />
            {found.length > 0 && !enrId && <div className="card" style={{ padding: 6 }}>{found.map((f) => <div key={f.enrollment_id}><button className="link" onClick={() => { setEnrId(f.enrollment_id); setSearch(`${f.name} · ${f.phone}`); setFound([]); }}>{f.name} · {f.phone} · {f.program} / {f.batch}</button></div>)}</div>}
          </Field>
        )}
        {enrollmentId && studentLabel && <div><b>{studentLabel}</b></div>}
        {d && (<>
          <div className="form-grid">
            <Field label="Instalment being paid" hint="Defaults to the oldest unpaid one">
              <select value={pick} onChange={(e) => { setPick(e.target.value); const i = open.find((x) => x.id === e.target.value); if (i) setAmount(String(i.balance)); }}>
                {open.map((i) => <option key={i.id} value={i.id}>{i.type === 'EMI' ? `EMI ${i.emi_number}` : i.type} · due {fmtDate(i.due_date)} · {inr(i.balance)}{i.days_overdue ? ` · ${i.days_overdue}d overdue` : ''}</option>)}
              </select>
            </Field>
            <Field label="Amount received (₹)"><input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Payment date"><input type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Payment mode"><select value={mode} onChange={(e) => setMode(e.target.value)}>{modes.map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Screenshot (required, max 5 MB)"><FileInput value={shot} onChange={setShot} /></Field>
            {intl && <>
              <Field label="Original currency"><input value={foreignCur} onChange={(e) => setForeignCur(e.target.value.toUpperCase())} placeholder="USD" maxLength={3} /></Field>
              <Field label="Original amount"><input type="number" min="0" step="0.01" value={foreignAmt} onChange={(e) => setForeignAmt(e.target.value)} /></Field>
            </>}
            <Field label="Note" span="all"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>

          {preview && (
            <div className="alert info">
              <b>What this will do</b>
              <table><tbody>{preview.map((p) => <tr key={p.instalment_id}><td>{p.label}</td><td className="num">{inr(p.paying)} of {inr(p.amount_due - p.already_paid)}</td><td>→ {p.status_after}{p.remaining_after ? ` (${inr(p.remaining_after)} stays open on ${fmtDate(p.due_date)})` : ''}</td></tr>)}</tbody></table>
              {preview.length > 1 && <div>The excess is applied to the next instalment(s), oldest first.</div>}
            </div>
          )}

          <label className="row"><input type="checkbox" checked={changeNext} onChange={(e) => setChangeNext(e.target.checked)} /> The student agreed a new date for the next EMI</label>
          {changeNext && <div className="form-grid"><Field label="New next due date"><input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></Field><Field label="Reason (logged)"><input value={nextReason} onChange={(e) => setNextReason(e.target.value)} /></Field></div>}
        </>)}
        {err && <div className="alert error">{err}</div>}
      </div>
    </Modal>
  );
}

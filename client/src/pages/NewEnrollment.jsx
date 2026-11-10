import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { inr, fmtDate, todayIST, autoSplit, useFetch } from '../util';
import { Field, FileInput, Loading, Modal } from '../components/ui';

const STEPS = ['Student', 'Fee & adjustments', 'EMI plan', 'Review & save'];
const blankPay = { amount: '', date: todayIST(), mode: '', ref: '', screenshot: '' };

export default function NewEnrollment() {
  const { programId, batchId } = useParams();
  const navigate = useNavigate();
  const programs = useFetch(() => api.get('/programs'));
  const batches = useFetch(() => api.get('/batches'));
  const types = useFetch(() => api.get('/adjustment-types'));
  const settings = useFetch(() => api.get('/settings'));

  const [step, setStep] = useState(0);
  const [stu, setStu] = useState({ full_name: '', phone: '', email: '', city: '', country: '' });
  const [existing, setExisting] = useState(null);
  const [past, setPast] = useState([]);
  const [matches, setMatches] = useState([]);
  const [fee, setFee] = useState('');
  const [feeReason, setFeeReason] = useState('');
  const [adj, setAdj] = useState([]);
  const [discount, setDiscount] = useState('');
  const [discReason, setDiscReason] = useState('');
  const [app, setApp] = useState({ ...blankPay });
  const [com, setCom] = useState({ ...blankPay });
  const [count, setCount] = useState(6);
  const [first, setFirst] = useState('');
  const [emis, setEmis] = useState([]);
  const [agreement, setAgreement] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  const program = (programs.data || []).find((p) => p._id === programId);
  const batch = (batches.data || []).find((b) => b._id === batchId);
  const listFee = batch ? (batch.fee_override ?? (program && program.default_fee) ?? 0) : 0;
  const modes = settings.data ? settings.data.payment_modes : [];

  // prefill defaults once data arrives
  useEffect(() => { if (program && batch && fee === '') setFee(String(listFee)); }, [program, batch]); // eslint-disable-line
  useEffect(() => {
    if (program && modes.length) {
      setApp((a) => ({ ...a, mode: a.mode || modes[0], amount: a.amount || (program.default_application_fee ? String(program.default_application_fee) : '') }));
      setCom((a) => ({ ...a, mode: a.mode || modes[0], amount: a.amount || (program.default_commitment_fee ? String(program.default_commitment_fee) : '') }));
    }
  }, [program, modes.length]); // eslint-disable-line

  // Step 1: search existing students while the phone is typed, link instead of duplicating
  useEffect(() => {
    const digits = stu.phone.replace(/\D/g, '');
    if (existing || digits.length < 5) { setMatches([]); return undefined; }
    const t = setTimeout(() => api.get(`/students/search?q=${digits}`).then(setMatches).catch(() => setMatches([])), 300);
    return () => clearTimeout(t);
  }, [stu.phone, existing]);

  const link = async (s) => {
    setExisting(s);
    setStu({ full_name: s.full_name, phone: s.phone, email: s.email, city: s.city || '', country: s.country || '' });
    setMatches([]);
    setPast(await api.get(`/students/${s._id}/enrollments`).catch(() => []));
  };
  const unlink = () => { setExisting(null); setPast([]); };

  const money = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
  const totalFee = money(fee);
  const adjTotal = adj.reduce((a, x) => a + money(x.amount), 0);
  const disc = money(discount);
  const appAmt = money(app.amount);
  const comAmt = money(com.amount);
  const net = totalFee - adjTotal - disc;
  const balance = net - appAmt - comAmt;
  const planSum = emis.reduce((a, e) => a + money(e.amount_due), 0);
  const diff = balance - planSum;
  const datesOk = emis.every((e, i) => e.due_date && (i === 0 || e.due_date >= emis[i - 1].due_date));
  const maxEmis = program ? program.max_emis : 12;
  const whole = (v) => Number.isInteger(money(v)) && money(v) >= 0;

  const availableTypes = useMemo(() => (types.data || []).filter((t) => t.active && (!t.target_programs.length || t.target_programs.includes(programId))), [types.data, programId]);

  const stepError = (s) => {
    if (s === 0) {
      if (!stu.full_name.trim()) return 'Enter the student name';
      if (!/^\+?\d[\d\s-]{7,}$/.test(stu.phone.trim())) return 'Enter the phone number with country code, e.g. +919800000000';
      if (!/^\S+@\S+\.\S+$/.test(stu.email)) return 'Enter a valid email';
    }
    if (s === 1) {
      if (![fee, discount, app.amount, com.amount, ...adj.map((a) => a.amount)].every(whole)) return 'All amounts must be whole rupees';
      if (totalFee !== listFee && !feeReason.trim()) return 'Give a reason for changing the total fee';
      if (adjTotal > totalFee) return 'Adjustments cannot exceed the total fee';
      if (adj.some((a) => !a.name)) return 'Pick a program for each adjustment';
      if (disc > 0 && !discReason.trim()) return 'Give a reason for the discount';
      if (balance < 0) return 'Application + commitment fee exceed the net payable';
      for (const [label, p] of [['Application', app], ['Commitment', com]]) {
        if (money(p.amount) > 0 && (!p.date || !p.mode || !p.ref.trim() || !p.screenshot)) return `${label} fee: date, mode, reference and screenshot are required`;
      }
    }
    if (s === 2) {
      if (!emis.length && balance !== 0) return 'Create the EMI plan (or make the balance zero)';
      if (diff !== 0) return `EMI amounts must add up to ${inr(balance)} (difference ${inr(diff)})`;
      if (emis.some((e) => money(e.amount_due) <= 0)) return 'Every EMI needs an amount above zero';
      if (!datesOk) return 'EMI due dates must be in ascending order';
    }
    return '';
  };
  const next = () => { const e = stepError(step); setErr(e); if (!e) setStep(step + 1); };

  const doSplit = () => {
    if (count > maxEmis) return setErr(`${program.name} allows at most ${maxEmis} EMIs`);
    setErr('');
    setEmis(autoSplit(balance, Number(count), first || todayIST()));
  };
  const setEmi = (i, k, v) => setEmis((l) => l.map((e, j) => (j === i ? { ...e, [k]: k === 'amount_due' ? v : v } : e)));

  const save = async () => {
    for (const s of [0, 1, 2]) { const e = stepError(s); if (e) { setErr(e); setStep(s); return; } }
    setBusy(true);
    setErr('');
    try {
      const up = (p) => (money(p.amount) > 0 ? { amount: money(p.amount), date: p.date, mode: p.mode, ref: p.ref, screenshot: p.screenshot } : undefined);
      const r = await api.post('/enrollments', {
        batch: batchId,
        ...(existing ? { student_id: existing._id } : { student: stu }),
        total_fee: totalFee, fee_change_reason: feeReason,
        adjustments: adj.map((a) => ({ adjustment: a.adjustment, name: a.name, amount: money(a.amount), notes: a.notes })),
        discount: disc, discount_reason: discReason, application: up(app), commitment: up(com),
        emis: emis.map((e) => ({ amount_due: money(e.amount_due), due_date: e.due_date })), agreement_file: agreement || undefined,
      });
      const welcome = await api.get(`/enrollments/${r.id}/welcome`).catch(() => null);
      setSaved({ id: r.id, welcome });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (programs.loading || batches.loading || types.loading || settings.loading) return <Loading />;
  if (!program || !batch) return <div className="empty">Batch not found.</div>;

  return (
    <>
      <div className="page-head"><div><h1>New enrollment</h1><div className="muted">{program.name} · {batch.batch_name}</div></div><div className="actions"><Link className="btn" to={`/p/${programId}/${batchId}`}>Cancel</Link></div></div>
      <div className="steps">{STEPS.map((s, i) => <span key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>{i + 1}. {s}</span>)}</div>

      <div className="wizard">
        <div className="card">
          {step === 0 && (
            <div className="grid">
              {existing && <div className="alert info">Linked to existing student <b>{existing.full_name}</b> — no duplicate will be created. <button className="link" onClick={unlink}>Not them?</button>{past.length > 0 && <div style={{ marginTop: 6 }}>Past MSS programs: {past.map((p) => `${p.program} / ${p.batch} (${p.status})`).join(', ')}</div>}</div>}
              <div className="form-grid">
                <Field label="Phone (with country code)"><input value={stu.phone} onChange={(e) => setStu({ ...stu, phone: e.target.value })} placeholder="+919800000000" disabled={!!existing} autoFocus /></Field>
                <Field label="Full name"><input value={stu.full_name} onChange={(e) => setStu({ ...stu, full_name: e.target.value })} disabled={!!existing} /></Field>
                <Field label="Email"><input type="email" value={stu.email} onChange={(e) => setStu({ ...stu, email: e.target.value })} disabled={!!existing} /></Field>
                <Field label="City"><input value={stu.city} onChange={(e) => setStu({ ...stu, city: e.target.value })} disabled={!!existing} /></Field>
                <Field label="Country" hint="International students: record the INR amount, with currency noted on each payment"><input value={stu.country} onChange={(e) => setStu({ ...stu, country: e.target.value })} disabled={!!existing} /></Field>
              </div>
              {matches.length > 0 && <div className="alert warn"><b>Already in the system:</b>{matches.map((m) => <div key={m._id}>{m.full_name} · {m.phone} <button className="small" onClick={() => link(m)}>Use this student</button></div>)}</div>}
            </div>
          )}

          {step === 1 && (
            <div className="grid">
              <div className="form-grid">
                <Field label="Total fee (₹)" hint={`List price ${inr(listFee)}`}><input type="number" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
                {totalFee !== listFee && <Field label="Reason for changing the fee"><input value={feeReason} onChange={(e) => setFeeReason(e.target.value)} /></Field>}
              </div>
              <div>
                <h3>Previous program adjustments</h3>
                {adj.map((a, i) => (
                  <div className="row" key={i} style={{ marginTop: 8 }}>
                    <select style={{ maxWidth: 240 }} value={a.adjustment || ''} onChange={(e) => { const t = availableTypes.find((x) => x._id === e.target.value); setAdj((l) => l.map((x, j) => (j === i ? { adjustment: t._id, name: t.name, amount: String(t.default_amount) } : x))); }}>
                      <option value="" disabled>Choose program…</option>{availableTypes.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                    </select>
                    <input type="number" style={{ maxWidth: 140 }} value={a.amount} onChange={(e) => setAdj((l) => l.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    <input style={{ maxWidth: 220 }} placeholder="Proof / notes" value={a.notes || ''} onChange={(e) => setAdj((l) => l.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} />
                    <button className="small danger" onClick={() => setAdj((l) => l.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                ))}
                <p><button onClick={() => setAdj([...adj, { adjustment: '', name: '', amount: '' }])}>+ Add previous program adjustment</button></p>
              </div>
              <div className="form-grid">
                <Field label="Discount (₹)" hint={settings.data ? `Above ${inr(settings.data.discount_limit)} needs Manager approval` : ''}><input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
                {disc > 0 && <Field label="Discount reason"><input value={discReason} onChange={(e) => setDiscReason(e.target.value)} /></Field>}
              </div>
              {[['Application fee received', app, setApp], ['Commitment fee received', com, setCom]].map(([label, p, set]) => (
                <div key={label} className="card" style={{ background: '#fafbfd' }}>
                  <h3>{label}</h3>
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <Field label="Amount (₹)"><input type="number" value={p.amount} onChange={(e) => set({ ...p, amount: e.target.value })} /></Field>
                    <Field label="Date"><input type="date" value={p.date} max={todayIST()} onChange={(e) => set({ ...p, date: e.target.value })} /></Field>
                    <Field label="Mode"><select value={p.mode} onChange={(e) => set({ ...p, mode: e.target.value })}>{modes.map((m) => <option key={m}>{m}</option>)}</select></Field>
                    <Field label="Transaction / UTR ref"><input value={p.ref} onChange={(e) => set({ ...p, ref: e.target.value })} /></Field>
                    <Field label="Screenshot"><FileInput value={p.screenshot} onChange={(f) => set({ ...p, screenshot: f })} /></Field>
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="grid">
              <div className="row">
                <Field label="Number of EMIs"><input type="number" min="1" max={maxEmis} value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 100 }} /></Field>
                <Field label="First due date"><input type="date" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
                <button style={{ alignSelf: 'flex-end' }} onClick={doSplit} disabled={balance <= 0}>Auto-split {inr(balance)}</button>
              </div>
              <p className="muted">Equal split, any rupee remainder goes on the last EMI, one month apart. Then edit any row — every student's plan is different.</p>
              {balance === 0 && <div className="alert info">The balance due is zero, so no EMIs are needed.</div>}
              {emis.length > 0 && (
                <table><thead><tr><th>#</th><th>Amount (₹)</th><th>Due date</th><th /></tr></thead>
                  <tbody>{emis.map((e, i) => (
                    <tr key={i}><td>{i + 1}</td>
                      <td><input type="number" value={e.amount_due} onChange={(ev) => setEmi(i, 'amount_due', ev.target.value)} /></td>
                      <td><input type="date" value={e.due_date} onChange={(ev) => setEmi(i, 'due_date', ev.target.value)} /></td>
                      <td><button className="small danger" onClick={() => setEmis((l) => l.filter((_, j) => j !== i))}>Remove</button></td></tr>))}</tbody></table>
              )}
              {emis.length > 0 && <div className={diff === 0 ? 'diff-ok' : 'diff-bad'}>{diff === 0 ? '✓ EMIs add up to the balance due' : `Difference: ${inr(diff)} (EMIs ${inr(planSum)} vs balance ${inr(balance)})`}{!datesOk && ' · due dates must be ascending'}</div>}
            </div>
          )}

          {step === 3 && (
            <div className="grid">
              <h3>Review</h3>
              <dl className="kv">
                <dt>Student</dt><dd>{stu.full_name} · {stu.phone}{existing && ' (existing)'}</dd>
                <dt>Net payable</dt><dd>{inr(net)}</dd>
                <dt>Paid upfront</dt><dd>{inr(appAmt + comAmt)}</dd>
                <dt>Balance in {emis.length} EMIs</dt><dd>{emis.map((e) => `${inr(e.amount_due)} on ${fmtDate(e.due_date)}`).join(' · ') || '—'}</dd>
              </dl>
              <Field label="Signed EMI agreement (optional)"><FileInput value={agreement} onChange={setAgreement} /></Field>
            </div>
          )}

          {err && <div className="alert error">{err}</div>}
          <div className="row" style={{ marginTop: 14 }}>
            {step > 0 && <button onClick={() => { setErr(''); setStep(step - 1); }}>Back</button>}
            <span className="grow" />
            {step < 3 ? <button className="primary" onClick={next}>Next</button> : <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save enrollment'}</button>}
          </div>
        </div>

        <div className="card summary">
          <h3 style={{ marginBottom: 8 }}>Live fee summary</h3>
          <div className="line"><span>Total fee</span><span>{inr(totalFee)}</span></div>
          {adj.filter((a) => money(a.amount)).map((a, i) => <div className="line" key={i}><span>Less: {a.name || 'adjustment'}</span><span>−{inr(a.amount)}</span></div>)}
          {disc > 0 && <div className="line"><span>Less: discount</span><span>−{inr(disc)}</span></div>}
          <div className="line total"><span>Net payable</span><span>{inr(net)}</span></div>
          <div className="line"><span>Less: application fee</span><span>−{inr(appAmt)}</span></div>
          <div className="line"><span>Less: commitment fee</span><span>−{inr(comAmt)}</span></div>
          <div className="line total"><span>Balance due → EMIs</span><span className={balance < 0 ? 'diff-bad' : ''}>{inr(balance)}</span></div>
          {emis.length > 0 && <div className="muted" style={{ marginTop: 8 }}>{emis.length} EMIs · {diff === 0 ? 'matches balance' : `off by ${inr(diff)}`}</div>}
        </div>
      </div>

      {saved && (
        <Modal title="Enrollment saved" onClose={() => navigate(`/enrollments/${saved.id}`)} footer={<button className="primary" onClick={() => navigate(`/enrollments/${saved.id}`)}>Open student profile</button>}>
          <div className="alert success">{stu.full_name} is enrolled and the full EMI schedule has been created.</div>
          {saved.welcome && <a className="btn" href={saved.welcome.wa} target="_blank" rel="noreferrer">Send welcome message with schedule on WhatsApp</a>}
        </Modal>
      )}
    </>
  );
}

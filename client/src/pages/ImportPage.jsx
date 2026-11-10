import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { inr } from '../util';

// Bulk import of existing SUPER / RGM students: preview, fix errors, then commit (spec 11.1).
export default function ImportPage() {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const readFile = async (e) => {
    const f = e.target.files[0];
    if (f) { setCsv(await f.text()); setPreview(null); setResult(null); }
  };
  const doPreview = async () => {
    setErr(''); setResult(null); setBusy(true);
    try { setPreview(await api.post('/import/preview', { csv })); } catch (e) { setErr(e.message); setPreview(null); } finally { setBusy(false); }
  };
  const commit = async () => {
    setErr(''); setBusy(true);
    try {
      const rows = preview.rows.filter((r) => r.ok).map((r) => ({ line: r.line, payload: r.payload }));
      setResult(await api.post('/import/commit', { rows }));
      setPreview(null); setCsv('');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Import students</h1><div className="muted">One row per enrollment, EMIs in repeating columns. Nothing is saved until you review the preview.</div></div>
        <div className="actions"><button onClick={() => api.download('/import/template', 'emi-import-template.csv').catch((e) => setErr(e.message))}>Download template</button></div>
      </div>
      <div className="alert info">The program and batch must already exist (Settings → Batches). Past payments are imported as payment rows without a screenshot. Amounts paid per EMI use <code>emiN_paid</code>.</div>
      <div className="card">
        <div className="grid">
          <input type="file" accept=".csv,text/csv" onChange={readFile} />
          <textarea style={{ minHeight: 140, fontFamily: 'monospace', fontSize: 12 }} placeholder="…or paste CSV here" value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} />
          <div><button className="primary" disabled={!csv.trim() || busy} onClick={doPreview}>{busy && !preview ? 'Checking…' : 'Preview & validate'}</button></div>
        </div>
      </div>
      {err && <div className="alert error">{err}</div>}

      {preview && (
        <div style={{ marginTop: 16 }}>
          <div className="row"><b>{preview.valid} ready</b><span className={preview.invalid ? 'red-text' : 'muted'}>{preview.invalid} with errors</span><span className="grow" />
            <button className="primary" disabled={!preview.valid || busy} onClick={commit}>{busy ? 'Importing…' : `Import ${preview.valid} valid rows`}</button></div>
          <div className="table-wrap" style={{ marginTop: 10 }}><table>
            <thead><tr><th>Line</th><th>Student</th><th>Program / batch</th><th className="num">Net payable</th><th className="num">Balance</th><th>EMIs</th><th className="num">Paid so far</th><th>Result</th></tr></thead>
            <tbody>{preview.rows.map((r) => (
              <tr key={r.line}><td>{r.line}</td><td>{r.display.name}<div className="muted">{r.display.phone}</div></td><td>{r.display.program} · {r.display.batch}</td>
                <td className="num">{inr(r.display.net_payable)}</td><td className="num">{inr(r.display.balance_due)}</td><td>{r.display.emis}</td><td className="num">{inr(r.display.paid)}</td>
                <td className="wrap">{r.ok ? <span className="ok">✓ ready</span> : <span className="red-text">{r.errors.join('; ')}</span>}</td></tr>))}</tbody>
          </table></div>
        </div>
      )}

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className={`alert ${result.failed ? 'warn' : 'success'}`}>{result.created} enrollments imported{result.failed ? `, ${result.failed} failed` : ''}.</div>
          {result.results.filter((r) => !r.ok).map((r) => <div key={r.line} className="red-text">Line {r.line}: {r.error}</div>)}
          <p><Link to="/">Go to Home</Link></p>
        </div>
      )}
    </>
  );
}

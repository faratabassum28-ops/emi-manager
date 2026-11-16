// Lightweight SVG charts (no chart library): small, fast, and themed with the same CSS variables as the rest of the app.
import { useRef, useState } from 'react';
import { inr } from '../util';

export const COLORS = { accent: 'var(--accent)', accent2: 'var(--accent-2)', good: 'var(--good)', bad: 'var(--bad)', warn: 'var(--warn)', muted: 'var(--faint)' };
export const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
};
const niceMax = (m) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

// data: [{ label, values: [a, b?], tip?: string }]; series: [{ name, color }]
export function BarChart({ data, series, height = 220, fmt = inr, onBar }) {
  const [tip, setTip] = useState(null);
  const box = useRef(null);
  const W = 640; const padL = 44; const padB = 24; const padT = 10;
  const H = height;
  const max = niceMax(Math.max(0, ...data.flatMap((d) => d.values)));
  const n = Math.max(1, data.length);
  const slot = (W - padL) / n;
  const bw = Math.min(34, (slot * 0.7) / series.length);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const every = Math.ceil(n / 12);
  return (
    <div className="chart-wrap" ref={box}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}><line className="grid-line" x1={padL} x2={W} y1={y(max * t)} y2={y(max * t)} /><text x={padL - 6} y={y(max * t) + 4} textAnchor="end">{compact(max * t)}</text></g>
        ))}
        {data.map((d, i) => {
          const x0 = padL + i * slot + (slot - bw * series.length - (series.length - 1) * 3) / 2;
          return (
            <g key={i} onMouseLeave={() => setTip(null)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" onMouseMove={(e) => { const r = box.current.getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top - 10, d }); }} onClick={() => onBar && onBar(d, i)} style={{ cursor: onBar ? 'pointer' : 'default' }} />
              {d.values.map((v, k) => <rect key={k} className="bar" x={x0 + k * (bw + 3)} y={y(v)} width={bw} height={Math.max(0, H - padB - y(v))} rx="3" fill={series[k].color} pointerEvents="none" />)}
              {i % every === 0 && <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {tip && <div className="chart-tip" style={{ left: tip.x, top: tip.y }}><b>{tip.d.label}</b>{tip.d.values.map((v, k) => <div key={k}>{series.length > 1 ? `${series[k].name}: ` : ''}{fmt(v)}</div>)}{tip.d.tip && <div className="muted">{tip.d.tip}</div>}</div>}
      {series.length > 1 && <div className="legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>}
    </div>
  );
}

// slices: [{ label, value, color, key }]
export function Donut({ slices, size = 170, center, onSlice, fmt = (v) => v }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 62; const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="donut-wrap">
      <div className="ring-wrap" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 160 160" role="img" aria-label="Breakdown">
          <circle cx="80" cy="80" r={r} fill="none" stroke="var(--ring-track)" strokeWidth="18" />
          {total > 0 && slices.filter((s) => s.value > 0).map((s) => {
            const len = (s.value / total) * c; const off = -acc; acc += len;
            return <circle key={s.key || s.label} cx="80" cy="80" r={r} fill="none" stroke={s.color} strokeWidth="18" strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`} strokeDashoffset={off} transform="rotate(-90 80 80)" style={{ cursor: onSlice ? 'pointer' : 'default', transition: 'stroke-dasharray .5s' }} onClick={() => onSlice && onSlice(s)}><title>{s.label}: {fmt(s.value)}</title></circle>;
          })}
        </svg>
        {center && <div className="ring-center"><b>{center.value}</b><span>{center.label}</span></div>}
      </div>
      <div className="donut-legend">
        {slices.map((s) => <button key={s.key || s.label} onClick={() => onSlice && onSlice(s)} disabled={!onSlice}><i style={{ background: s.color }} />{s.label}<b>{fmt(s.value)}</b></button>)}
      </div>
    </div>
  );
}

export function Ring({ pct, size = 150, label, sub, color = 'var(--good)' }) {
  const r = 58; const c = 2 * Math.PI * r; const p = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 140 140" role="img" aria-label={`${p}%`}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--ring-track)" strokeWidth="13" />
        <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="13" strokeLinecap="round" strokeDasharray={`${(p / 100) * c} ${c}`} transform="rotate(-90 70 70)" style={{ transition: 'stroke-dasharray .7s cubic-bezier(.2,.8,.2,1)' }} />
      </svg>
      <div className="ring-center"><b>{label ?? `${Math.round(p)}%`}</b>{sub && <span>{sub}</span>}</div>
    </div>
  );
}

// rows: [{ label, value, color?, onClick? }]
export function HBars({ rows, fmt = inr, color = 'var(--accent)' }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div className="hbar" key={r.label} onClick={r.onClick} style={{ cursor: r.onClick ? 'pointer' : 'default' }}>
          <span className="label" title={r.label}>{r.label}</span>
          <span className="meter"><i style={{ width: `${(r.value / max) * 100}%`, background: r.color || color }} /></span>
          <b>{fmt(r.value)}</b>
        </div>
      ))}
    </div>
  );
}

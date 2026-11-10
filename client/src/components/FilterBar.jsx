// Time-window picker (remembered between visits), same idea as the Order Analytics top bar.
import { WINDOWS, fmtDate, useStored } from '../util';

export function useWindow(key = 'window', initial = 'this_month') {
  const [state, setState] = useStored(key, { window: initial, from: '', to: '' });
  const ready = state.window !== 'custom' || (state.from && state.to && state.from <= state.to);
  const params = state.window === 'custom' ? `window=custom&from=${state.from}&to=${state.to}` : `window=${state.window}`;
  return { ...state, ready, params, set: (patch) => setState((s) => ({ ...s, ...patch })) };
}

export default function FilterBar({ win, range, children }) {
  return (
    <div className="topbar">
      <select aria-label="Time window" value={win.window} onChange={(e) => win.set({ window: e.target.value })}>
        {WINDOWS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {win.window === 'custom' && (
        <>
          <input type="date" aria-label="From" value={win.from} onChange={(e) => win.set({ from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={win.to} onChange={(e) => win.set({ to: e.target.value })} />
        </>
      )}
      <span className="range">
        {range ? (range.start ? <><b>{fmtDate(range.start)}</b> to <b>{fmtDate(range.end)}</b> (IST)</> : <b>All time</b>) : ''}
        {range && range.partial ? ' · period still in progress' : ''}
      </span>
      <span className="grow" />
      {children}
    </div>
  );
}

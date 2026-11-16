import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/* ---------- theme (dark by default, remembered) ---------- */
const ThemeCtx = createContext({ theme: 'dark', toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('emi_theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('emi_theme', theme); } catch { /* private mode */ }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

/* ---------- toasts ---------- */
const ToastCtx = createContext({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const id = useRef(0);
  const push = useCallback((text, tone = 'good', ms = 3600) => {
    const k = ++id.current;
    setItems((l) => [...l.slice(-3), { k, text, tone }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.k !== k)), ms);
  }, []);
  const api = useRef({ push });
  api.current.push = push;
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div className="toast-stack" aria-live="polite">{items.map((t) => <div key={t.k} className={`toast toast-${t.tone}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/* ---------- offline banner ---------- */
export function NetworkBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [back, setBack] = useState(false);
  useEffect(() => {
    const off = () => { setOnline(false); setBack(false); };
    const on = () => { setOnline(true); setBack(true); setTimeout(() => setBack(false), 2500); };
    window.addEventListener('offline', off); window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);
  if (online && !back) return null;
  return online
    ? <div className="net-banner net-ok" role="status">Back online</div>
    : <div className="net-banner net-offline" role="alert">You are offline. Changes will not save until the connection returns.</div>;
}

import { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken, hasToken } from './api';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!hasToken());

  useEffect(() => {
    if (hasToken()) {
      api.get('/auth/me').then((r) => setUser(r.user)).catch(() => setToken('')).finally(() => setReady(true));
    }
    const out = () => setUser(null);
    window.addEventListener('auth-expired', out);
    return () => window.removeEventListener('auth-expired', out);
  }, []);

  const login = async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    setToken(r.token);
    setUser(r.user);
  };
  const logout = () => { setToken(''); setUser(null); };

  const role = user && user.role;
  const can = {
    write: ['Admin', 'Manager', 'CRM'].includes(role),
    manage: ['Admin', 'Manager'].includes(role),
    admin: role === 'Admin',
    verify: !!(user && user.can_verify),
    export: ['Admin', 'Manager', 'Viewer'].includes(role),
  };
  return <Ctx.Provider value={{ user, ready, login, logout, can }}>{children}</Ctx.Provider>;
}

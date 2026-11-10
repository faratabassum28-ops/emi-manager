const BASE = import.meta.env.VITE_API_URL || '/api';
let token = localStorage.getItem('emi_token') || '';

export function setToken(t) {
  token = t || '';
  if (t) localStorage.setItem('emi_token', t);
  else localStorage.removeItem('emi_token');
}
export const hasToken = () => !!token;

async function request(method, path, body, { raw } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401 && path !== '/auth/login') {
    setToken('');
    window.dispatchEvent(new Event('auth-expired'));
  }
  if (raw) {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b || {}),
  put: (p, b) => request('PUT', p, b || {}),
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    return (await request('POST', '/uploads', fd)).file;
  },
  async blobUrl(path) {
    const res = await request('GET', path, null, { raw: true });
    return URL.createObjectURL(await res.blob());
  },
  async download(path, filename) {
    const res = await request('GET', path, null, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

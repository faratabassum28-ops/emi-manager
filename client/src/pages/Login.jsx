import { useState } from 'react';
import { useAuth } from '../auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>EMI Manager</h1>
        <p className="muted">MySoulSchool · internal fee & EMI tracking</p>
        <div className="grid" style={{ marginTop: 16 }}>
          <label className="field"><span className="field-label">Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="username" /></label>
          <label className="field"><span className="field-label">Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
          {error && <div className="alert error">{error}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}

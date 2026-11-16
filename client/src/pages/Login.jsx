import { useState } from 'react';
import { useAuth } from '../auth';
import { LogoMark } from '../components/Icon';

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
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <LogoMark size={46} />
          <div><h1>EMI Manager</h1><p>MySoulSchool · fee & EMI tracking</p></div>
        </div>
        <div className="login-form">
          <label><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="username" /></label>
          <label><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
          {error && <div className="alert error">{error}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
        <p className="login-hint">Your data is backed up automatically.</p>
      </form>
    </div>
  );
}

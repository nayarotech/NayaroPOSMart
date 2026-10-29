import { Barcode, DatabaseBackup, ShieldCheck, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { api, errMsg } from '../api';
import { Brand, FiscalChip } from '../components/Layout';
import { Banner, Field } from '../components/ui';
import { useSession } from '../session';

export function Login() {
  const { setUser, info } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setUser(await api('auth.login', { username, password }));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-art">
        <Brand sub={`${info?.storeName ?? 'Nayaro Mart'} · Powered by Nayaro Tech`} />
        <div>
          <h1>Fast, reliable checkout — even without internet.</h1>
          <div className="feature"><WifiOff /><div><b>Offline-first.</b> Sales, stock and reports live in a local database on this computer.</div></div>
          <div className="feature"><Barcode /><div><b>Barcodes & labels.</b> Use manufacturer barcodes or print Nayaro Mart Code 128 labels.</div></div>
          <div className="feature"><ShieldCheck /><div><b>Controlled.</b> Roles, audit trail, and approval for voids, refunds and large discounts.</div></div>
          <div className="feature"><DatabaseBackup /><div><b>Backed up.</b> Verified local backups with tested restore.</div></div>
        </div>
        <div className="small" style={{ color: '#8a96b0' }}>© Nayaro Tech · Demo MVP — not yet reviewed for production or tax compliance.</div>
      </div>
      <div className="login-form">
        <form className="login-card col gap-lg" onSubmit={submit}>
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>Use your counter account.</p>
          </div>
          <FiscalChip />
          {error && <Banner kind="danger">{error}</Banner>}
          <Field label="Username">
            <input className="input lg" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <input className="input lg" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <button className="btn primary lg" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {info?.demoCredentialsActive && (
            <Banner kind="warn">
              <b>Demo accounts</b> (local demonstration only — change before real use):<br />
              Administrator: <span className="mono">admin / Admin@123</span>
              <br />
              Cashier: <span className="mono">cashier / Cashier@123</span>
            </Banner>
          )}
        </form>
      </div>
    </div>
  );
}

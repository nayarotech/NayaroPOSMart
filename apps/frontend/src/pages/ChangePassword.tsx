import { useState } from 'react';
import { api, errMsg } from '../api';
import { Banner, Field, useToast } from '../components/ui';
import { useSession } from '../session';

export function ChangePassword({ forced }: { forced?: boolean }) {
  const { user, setUser, logout, refreshInfo } = useSession();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mismatch = again.length > 0 && next !== again;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('auth.changePassword', { currentPassword: cur, newPassword: next });
      toast.ok('Password changed');
      setUser(await api('auth.session'));
      await refreshInfo();
      setCur('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(errMsg(err));
    }
  }

  const form = (
    <form className="card card-pad col" style={{ maxWidth: 440 }} onSubmit={save}>
      <h2>Change password</h2>
      {forced && <Banner kind="warn">You must set a new password for <b>{user?.username}</b> before continuing.</Banner>}
      {error && <Banner kind="danger">{error}</Banner>}
      <Field label="Current password"><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus /></Field>
      <Field label="New password" hint="At least 8 characters. Do not reuse the demo password."><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field label="Repeat new password" error={mismatch ? 'Passwords do not match' : null}><input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
      <div className="row">
        <button className="btn primary" disabled={!cur || next.length < 8 || next !== again}>Save password</button>
        {forced && <button type="button" className="btn ghost" onClick={() => void logout()}>Sign out</button>}
      </div>
    </form>
  );
  return forced ? <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>{form}</div> : (
    <div>
      <div className="page-head"><div><h1>My account</h1><p>Signed in as {user?.fullName} ({user?.role})</p></div></div>
      {form}
    </div>
  );
}

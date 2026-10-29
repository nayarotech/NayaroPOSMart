import type { UserRow } from '@srmart/shared';
import { KeyRound, Plus, UserCog } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../api';
import { Banner, DemoBadge, Empty, ErrorState, Field, Loading, Modal, Pager, useAsync, useToast } from '../components/ui';
import { dateTime } from '../lib/format';
import { useSession } from '../session';

export function Users() {
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  return (
    <div>
      <div className="page-head"><div><h1>Users & audit</h1><p>Administrator and cashier accounts, and the permanent audit trail of sensitive actions.</p></div></div>
      <div className="tabs">
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Users</button>
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button>
      </div>
      {tab === 'users' ? <UserList /> : <AuditLog />}
    </div>
  );
}

function UserList() {
  const { user: me, info } = useSession();
  const list = useAsync(() => api('users.list'), []);
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const [reset, setReset] = useState<UserRow | null>(null);
  return (
    <div className="col">
      {info?.demoCredentialsActive && (
        <Banner kind="warn">Demo accounts still use their published demo passwords. Before real use: change them (<Link to="/account">my password</Link> / “Reset password” below), or create new accounts and disable the demo ones.</Banner>
      )}
      <div className="card">
        <div className="card-head"><h2>Accounts</h2><button className="btn primary" onClick={() => setEdit('new')}><Plus /> New user</button></div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {list.data.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{u.fullName} {u.isDemo && <DemoBadge />} {u.id === me?.id && <span className="badge blue">you</span>}</td>
                  <td className="mono">{u.username}</td>
                  <td><span className={`badge ${u.role === 'admin' ? 'amber' : 'gray'}`}>{u.role === 'admin' ? 'Administrator' : 'Cashier'}</span></td>
                  <td>{u.active ? <span className="badge green">Active</span> : <span className="badge red">Disabled</span>}{u.mustChangePassword && <span className="badge amber" style={{ marginLeft: 4 }}>must change password</span>}</td>
                  <td className="small">{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'never'}</td>
                  <td className="right nowrap">
                    <button className="btn ghost sm" onClick={() => setEdit(u)}><UserCog /> Edit</button>
                    <button className="btn ghost sm" onClick={() => setReset(u)}><KeyRound /> Reset password</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card card-pad small muted">
        <b>Cashiers can:</b> sell, apply discounts up to the configured limit, view sales, reprint receipts, print labels, look up products.
        <b> Cashiers cannot</b> (without an administrator entering their password): give larger discounts, void sales, process returns/refunds. Product, price, stock, purchase, report, user, settings and backup screens are administrator-only.
      </div>
      {edit && <UserEditor user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
      {reset && <ResetPassword user={reset} onClose={() => setReset(null)} onDone={() => (setReset(null), list.reload())} />}
    </div>
  );
}

function UserEditor({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ username: user?.username ?? '', fullName: user?.fullName ?? '', role: user?.role ?? 'cashier', active: user?.active ?? true, password: '' });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      if (user) await api('users.update', { id: user.id, fullName: f.fullName, role: f.role, active: f.active });
      else await api('users.create', { username: f.username, fullName: f.fullName, role: f.role, password: f.password });
      toast.ok('User saved');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Modal title={user ? `Edit ${user.username}` : 'New user'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void save()}>Save</button></>}>
      <div className="col">
        {error && <Banner kind="danger">{error}</Banner>}
        {!user && <Field label="Username" hint="3–30 characters: letters, digits, . _ -"><input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoFocus /></Field>}
        <Field label="Full name"><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label="Role">
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'admin' | 'cashier' })}><option value="cashier">Cashier</option><option value="admin">Administrator</option></select>
        </Field>
        {!user && <Field label="Temporary password" hint="At least 8 characters. The user must change it at first sign-in."><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
        {user && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Account active (disabled accounts cannot sign in)</label>}
      </div>
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      await api('users.resetPassword', { id: user.id, newPassword: pw });
      toast.ok('Password reset');
      onDone();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Modal title={`Reset password — ${user.username}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={pw.length < 8} onClick={() => void save()}>Reset</button></>}>
      <div className="col">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="New password" hint="At least 8 characters. Other users must change it at next sign-in."><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
      </div>
    </Modal>
  );
}

const ACTIONS = ['', 'sale.', 'sale.voided', 'sale.returned', 'sale.discount', 'product.price_changed', 'product.', 'stock.adjusted', 'purchase.', 'user.', 'auth.', 'settings.', 'backup.', 'demo.', 'labels.'];

function AuditLog() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const list = useAsync(() => api('audit.list', { page, pageSize: 50, action: action || undefined }), [page, action]);
  return (
    <div className="card">
      <div className="card-head">
        <select className="select" style={{ width: 240 }} value={action} onChange={(e) => (setAction(e.target.value), setPage(1))}>
          {ACTIONS.map((a) => <option key={a} value={a}>{a ? `${a}${a.endsWith('.') ? '*' : ''}` : 'All actions'}</option>)}
        </select>
        <span className="small muted">Audit entries cannot be edited or deleted.</span>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? <Empty title="No audit entries" /> : (
        <>
          <table className="table">
            <thead><tr><th>When</th><th>Action</th><th>By</th><th>Approved by</th><th>Details</th></tr></thead>
            <tbody>
              {list.data.rows.map((a) => (
                <tr key={a.id}>
                  <td className="small nowrap">{dateTime(a.createdAt)}</td>
                  <td><span className="mono">{a.action}</span><div className="sub">{a.entityType}{a.entityId ? ` #${a.entityId}` : ''}</div></td>
                  <td>{a.userName ?? '—'}</td>
                  <td>{a.approvedByName ?? '—'}</td>
                  <td>{a.details ? <pre className="json">{JSON.stringify(a.details, null, 1).replace(/[{}"]/g, '').trim()}</pre> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} pageSize={50} total={list.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

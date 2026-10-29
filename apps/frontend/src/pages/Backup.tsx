import type { BackupInfo, VerifyResult } from '@srmart/shared';
import { DatabaseBackup, FolderOpen, FolderInput, ShieldCheck, TestTube2 } from 'lucide-react';
import { useState } from 'react';
import { api, errMsg } from '../api';
import { Banner, Empty, ErrorState, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import { bytes, dateTime } from '../lib/format';
import { useSession } from '../session';

export function BackupPage() {
  const { settings, refreshSettings, logout } = useSession();
  const toast = useToast();
  const status = useAsync(() => api('backup.status'), []);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ file: string; r: VerifyResult } | null>(null);
  const [restore, setRestore] = useState<BackupInfo | null>(null);

  async function act<T>(fn: () => Promise<T>, ok: (t: T) => string) {
    setBusy(true);
    try {
      const t = await fn();
      toast.ok(ok(t));
      status.reload();
      return t;
    } catch (e) {
      toast.error(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function chooseDir() {
    const r = await api('backup.chooseDirectory').catch((e) => (toast.error(e), null));
    if (!r?.directory || !settings) return;
    await act(() => api('settings.update', { ...settings, backup: { ...settings.backup, directory: r.directory } }), () => 'Backup folder updated');
    await refreshSettings();
  }

  const s = status.data;
  return (
    <div className="col gap-lg">
      <div className="page-head">
        <div><h1>Backup & recovery</h1><p>Verified copies of the local database, stored outside the database folder.</p></div>
        <div className="row">
          <button className="btn" onClick={() => void act(() => api('backup.openFolder'), () => 'Opened backup folder')}><FolderOpen /> Open folder</button>
          <button className="btn" onClick={() => void chooseDir()}><FolderInput /> Change folder</button>
          <button className="btn primary" disabled={busy} onClick={() => void act(() => api('backup.create'), (b) => `Backup ${b.file} created and verified`)}><DatabaseBackup /> Back up now</button>
        </div>
      </div>
      {status.error ? <ErrorState error={status.error} onRetry={status.reload} /> : !s ? <Loading /> : (
        <>
          <div className="grid g3">
            <div className="card stat"><div className="stat-label">Last backup</div><div className="stat-value" style={{ fontSize: 18 }}>{s.lastBackupAt ? dateTime(s.lastBackupAt) : 'Never'}</div><div className="stat-sub">{s.backups.length} backups kept (retention {settings?.backup.keep ?? '—'})</div></div>
            <div className="card stat"><div className="stat-label">Backup folder</div><div className="mono small" style={{ marginTop: 6, wordBreak: 'break-all' }}>{s.directory}</div></div>
            <div className="card stat"><div className="stat-label">Live database</div><div className="mono small" style={{ marginTop: 6, wordBreak: 'break-all' }}>{s.primaryDbPath}</div></div>
          </div>
          {s.sameDriveWarning && <Banner kind="warn">Backups are on the <b>same disk</b> as the database. If this disk fails, both are lost. Choose a USB drive or second disk with “Change folder”, and regularly copy a backup off-site.</Banner>}
          <Banner kind="info">Automatic backups: once a day at start-up and every time the app closes{settings?.backup.autoBackupOnExit ? '' : ' (disabled)'}. Each backup is a consistent snapshot, verified with an integrity check, written under a new unique name and never overwrites an existing file. Retention never deletes the newest verified backup or pre-restore safety copies.</Banner>
          <div className="card">
            <div className="card-head"><h2>Backups</h2></div>
            {s.backups.length === 0 ? <Empty title="No backups yet" icon={<DatabaseBackup />}>Click “Back up now”.</Empty> : (
              <table className="table">
                <thead><tr><th>File</th><th>Created</th><th>Reason</th><th className="num">Size</th><th>Verified</th><th /></tr></thead>
                <tbody>
                  {s.backups.map((b) => (
                    <tr key={b.file}>
                      <td className="mono small">{b.file}</td>
                      <td className="small">{dateTime(b.createdAt)}</td>
                      <td><span className="badge gray">{b.reason}</span></td>
                      <td className="num small">{bytes(b.sizeBytes)}</td>
                      <td>{b.verified === true ? <span className="badge green">verified</span> : b.verified === false ? <span className="badge red">failed</span> : <span className="badge gray">unknown</span>}</td>
                      <td className="right nowrap">
                        <button className="btn ghost sm" disabled={busy} onClick={() => void act(() => api('backup.verify', { file: b.file }), (r) => (setResult({ file: b.file, r }), r.message))}><ShieldCheck /> Verify</button>
                        <button className="btn ghost sm" disabled={busy} onClick={() => void act(() => api('backup.testRestore', { file: b.file }), (r) => (setResult({ file: b.file, r }), r.message))}><TestTube2 /> Test restore</button>
                        <button className="btn sm" disabled={busy} onClick={() => setRestore(b)}>Restore…</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {result && (
            <Banner kind={result.r.ok ? 'ok' : 'danger'}>
              <b>{result.file}</b>: {result.r.message} · integrity: {result.r.integrity} · schema v{result.r.schemaVersion} · {Object.entries(result.r.tables).map(([t, n]) => `${t} ${n}`).join(', ')}
            </Banner>
          )}
          <div className="card card-pad small">
            <h3>Restore procedure</h3>
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Click <b>Test restore</b> on the backup first: it restores into a separate temporary copy and checks it, without touching live data.</li>
              <li>Click <b>Restore…</b> and enter your password. The app first saves a <i>pre-restore</i> safety backup of the current database.</li>
              <li>The live database is closed, replaced atomically with the backup, reopened and migrated. Everyone must sign in again.</li>
              <li>Check today's sales and stock. If something is wrong, restore the <i>pre-restore</i> backup to undo.</li>
            </ol>
          </div>
        </>
      )}
      {restore && <RestoreDialog backup={restore} onClose={() => setRestore(null)} onDone={() => void logout().then(() => window.location.reload())} errorText={errMsg} />}
    </div>
  );
}

function RestoreDialog({ backup, onClose, onDone }: { backup: BackupInfo; onClose: () => void; onDone: () => void; errorText: (e: unknown) => string }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await api('backup.restore', { file: backup.file, password: pw });
      toast.ok(`Restored. Safety copy: ${r.safetyBackup}`);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Restore database" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || typed !== 'RESTORE' || !pw} onClick={() => void go()}>{busy ? 'Restoring…' : 'Restore now'}</button></>}>
      <div className="col">
        <Banner kind="danger">The current database will be replaced by <b className="mono">{backup.file}</b> ({dateTime(backup.createdAt)}). Sales recorded after that time will no longer appear (they remain in the automatic pre-restore safety backup).</Banner>
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label={<>Type <span className="mono">RESTORE</span></>}><input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></Field>
        <Field label="Your password"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

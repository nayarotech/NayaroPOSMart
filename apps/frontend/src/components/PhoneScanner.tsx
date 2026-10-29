import type { ScannerStatus } from '@srmart/shared';
import { QrCode, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../api';
import { Banner, Empty, Loading, Modal } from './ui';
import { dateTime } from '../lib/format';

/** Pair a phone as a barcode scanner: shows a short-lived QR code with the local HTTPS address. */
export function PhoneScannerModal({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<ScannerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => api('scanner.status').then(setSt).catch((e) => setError(errMsg(e))), []);
  const pair = useCallback(() => api('scanner.startPairing').then((s) => (setSt(s), setError(null))).catch((e) => setError(errMsg(e))), []);

  useEffect(() => {
    void pair();
    // Poll so a newly paired phone appears (and the QR disappears) without clicking.
    const t = setInterval(() => (void refresh(), setNow(Date.now())), 2000);
    return () => clearInterval(t);
  }, [pair, refresh]);

  const secondsLeft = st?.pairing ? Math.max(0, Math.round((new Date(st.pairing.expiresAt).getTime() - now) / 1000)) : 0;

  return (
    <Modal title="Phone barcode scanner" size="wide" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      {!st && !error ? <Loading /> : (
        <div className="grid" style={{ gridTemplateColumns: '300px 1fr', gap: 24 }}>
          <div className="col" style={{ alignItems: 'center' }}>
            {st?.pairing ? (
              <>
                <img alt="Pairing QR code" src={`data:image/svg+xml;utf8,${encodeURIComponent(st.pairing.qrSvg)}`} style={{ width: 260, height: 260, background: '#fff', borderRadius: 12, border: '1px solid var(--border)' }} />
                <div className="small muted">Valid for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} · one phone per code</div>
              </>
            ) : (
              <div className="card card-pad col" style={{ alignItems: 'center', width: 260, boxShadow: 'none' }}>
                <QrCode size={48} color="var(--text-3)" />
                <div className="small muted center">{st?.running ? 'Code used or expired.' : 'Phone scanner is not running.'}</div>
              </div>
            )}
            <button className="btn" disabled={!st?.running} onClick={() => void pair()}><QrCode /> New pairing code</button>
          </div>
          <div className="col">
            {error && <Banner kind="danger">{error}</Banner>}
            {st && !st.running && <Banner kind="warn">{st.message}</Banner>}
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.75 }}>
              <li>Connect the phone to the <b>same Wi-Fi</b> as this computer (no internet needed).</li>
              <li>Open the phone camera and scan the QR code.</li>
              <li>The browser warns about the certificate the first time — tap <b>Advanced → Proceed</b>. It is this computer's own offline certificate.</li>
              <li>Tap <b>Start camera</b> and point it at a barcode. Items appear in the cart here.</li>
            </ol>
            {st?.urls.length ? <div className="small muted">Address: <span className="mono">{st.urls.join('  ·  ')}</span></div> : null}
            <div>
              <div className="section-title">Paired phones</div>
              {!st?.devices.length ? <Empty title="No phone paired yet" icon={<Smartphone />} /> : (
                <table className="table">
                  <tbody>
                    {st.devices.map((d) => (
                      <tr key={d.id}>
                        <td><b>{d.name}</b><div className="sub">paired {dateTime(d.pairedAt)} · last seen {dateTime(d.lastSeenAt)}</div></td>
                        <td className="num">{d.scans} scans</td>
                        <td className="right"><button className="btn ghost sm" onClick={() => void api('scanner.unpair', { deviceId: d.id }).then(setSt)}><Trash2 /> Unpair</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="small faint">Pairings last until this app restarts. A paired phone can only send barcodes — it cannot see sales or change anything.</div>
          </div>
        </div>
      )}
    </Modal>
  );
}

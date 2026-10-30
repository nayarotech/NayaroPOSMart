import type { SavedCart } from '@srmart/shared';
import { useState } from 'react';
import { api, errMsg } from '../api';
import { dateTime } from '../lib/format';
import { Banner, Empty, ErrorState, Field, Loading, Modal, useAsync } from './ui';

export function ParkCartDialog({ onPark, onClose }: { onPark: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function park() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onPark(name.trim()); onClose(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return <Modal title="Park current sale" onClose={() => !busy && onClose()} footer={<><button className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void park()}>{busy ? 'Saving…' : 'Park sale'}</button></>}>
    <div className="col"><Field label="Cart name"><input className="input" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer collecting later" onKeyDown={(e) => e.key === 'Enter' && void park()} /></Field><p className="muted small">Stock is reserved only when payment completes. Prices and offers are checked again when this cart resumes.</p>{error && <Banner kind="danger">{error}</Banner>}</div>
  </Modal>;
}
export function ParkedCartsDialog({ onResume, onClose, hasCurrent }: { onResume: (cart: SavedCart) => Promise<void>; onClose: () => void; hasCurrent: boolean }) {
  const data = useAsync(() => api('carts.list'), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function action(cart: SavedCart, discard: boolean) {
    if (busy) return;
    if (discard && !confirm(`Discard parked cart "${cart.name}"?`)) return;
    setBusy(true); setError(null);
    try {
      if (discard) { await api('carts.discard', { id: cart.id, revision: cart.revision }); data.reload(); }
      else { await onResume(cart); onClose(); }
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return <Modal title="Your parked carts" onClose={() => !busy && onClose()} size="wide">
    <div className="col">{hasCurrent && <Banner kind="info">Park or clear your current sale before resuming another cart.</Banner>}
      {error && <Banner kind="danger">{error}</Banner>}
      {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.data ? <Loading /> : data.data.length === 0 ? <Empty title="No parked carts" /> : <table className="table"><thead><tr><th>Cart</th><th>Items</th><th /></tr></thead><tbody>{data.data.map((cart) => <tr key={cart.id}><td><b>{cart.name}</b><div className="sub">{dateTime(cart.updatedAt)}</div><div className="sub">{cart.lines.slice(0, 3).map((l) => l.name).join(', ')}{cart.lines.length > 3 ? '…' : ''}</div></td><td>{cart.lines.reduce((n, l) => n + l.quantity, 0)}</td><td><div className="row"><button className="btn primary sm" disabled={busy || hasCurrent} onClick={() => void action(cart, false)}>Resume</button><button className="btn sm" disabled={busy} onClick={() => void action(cart, true)}>Discard</button></div></td></tr>)}</tbody></table>}
    </div>
  </Modal>;
}

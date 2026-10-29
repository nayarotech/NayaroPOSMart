import type { MovementType, Product } from '@srmart/shared';
import { Boxes, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { api, errMsg } from '../api';
import { ProductPicker } from '../components/ProductPicker';
import { Banner, Empty, ErrorState, Field, Loading, Modal, Pager, StockBadge, useAsync, useToast } from '../components/ui';
import { dateTime } from '../lib/format';

const TYPE_BADGE: Record<MovementType, string> = { opening: 'gray', sale: 'blue', purchase: 'green', return: 'amber', void: 'amber', adjustment: 'red' };

export function Inventory() {
  const [tab, setTab] = useState<'ledger' | 'low' | 'expiry'>('ledger');
  const [adjust, setAdjust] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <div>
      <div className="page-head">
        <div><h1>Inventory</h1><p>Every stock change is a ledger entry: sales, purchases, returns, voids and reasoned adjustments.</p></div>
        <button className="btn primary" onClick={() => setAdjust(true)}><SlidersHorizontal /> Adjust stock</button>
      </div>
      <div className="tabs">
        <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>Stock movements</button>
        <button className={tab === 'low' ? 'on' : ''} onClick={() => setTab('low')}>Low stock</button>
        <button className={tab === 'expiry' ? 'on' : ''} onClick={() => setTab('expiry')}>Batches & expiry</button>
      </div>
      {tab === 'ledger' && <Ledger key={key} />}
      {tab === 'low' && <LowStock key={key} />}
      {tab === 'expiry' && <Expiry />}
      {adjust && <AdjustDialog onClose={() => setAdjust(false)} onDone={() => (setAdjust(false), setKey((k) => k + 1))} />}
    </div>
  );
}

function Ledger() {
  const [product, setProduct] = useState<Product | null>(null);
  const [type, setType] = useState<MovementType | ''>('');
  const [page, setPage] = useState(1);
  const list = useAsync(() => api('inventory.movements', { productId: product?.id, type: type || undefined, page, pageSize: 50 }), [product, type, page]);
  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <div style={{ width: 320 }}><ProductPicker onPick={(p) => (setProduct(p), setPage(1))} placeholder="Filter by product (scan or search)" /></div>
          {product && <span className="badge blue">{product.name} <button className="btn ghost sm" onClick={() => setProduct(null)}>×</button></span>}
          <select className="select" style={{ width: 160 }} value={type} onChange={(e) => (setType(e.target.value as MovementType | ''), setPage(1))}>
            <option value="">All types</option>
            {(['opening', 'sale', 'purchase', 'return', 'void', 'adjustment'] as const).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? <Empty title="No movements" icon={<Boxes />} /> : (
        <>
          <table className="table">
            <thead><tr><th>When</th><th>Product</th><th>Type</th><th className="num">Change</th><th className="num">Balance</th><th>Reference / reason</th><th>User</th></tr></thead>
            <tbody>
              {list.data.rows.map((m) => (
                <tr key={m.id}>
                  <td className="small nowrap">{dateTime(m.createdAt)}</td>
                  <td>{m.productName}<div className="sub">{m.sku}</div></td>
                  <td><span className={`badge ${TYPE_BADGE[m.type]}`}>{m.type}</span></td>
                  <td className="num" style={{ fontWeight: 700, color: m.quantityDelta < 0 ? 'var(--danger)' : 'var(--ok)' }}>{m.quantityDelta > 0 ? '+' : ''}{m.quantityDelta}</td>
                  <td className="num">{m.balanceAfter}</td>
                  <td className="small">{m.refLabel && <span className="mono">{m.refLabel}</span>} {m.reason}</td>
                  <td className="small">{m.userName ?? '—'}</td>
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

function LowStock() {
  const list = useAsync(() => api('inventory.lowStock'), []);
  return (
    <div className="card">
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? <Empty title="No low-stock products" /> : (
        <table className="table">
          <thead><tr><th>Product</th><th>Category</th><th className="num">On hand</th><th className="num">Minimum</th><th className="num">Suggested order</th></tr></thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.id}><td>{p.name}<div className="sub">{p.sku}</div></td><td>{p.categoryName ?? '—'}</td><td className="num"><StockBadge qty={p.qtyOnHand} min={p.minStock} unit={p.unit} /></td><td className="num">{p.minStock}</td><td className="num">{Math.max(0, p.minStock * 2 - p.qtyOnHand)} {p.unit}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Expiry() {
  const [days, setDays] = useState(60);
  const list = useAsync(() => api('inventory.expiring', { days }), [days]);
  return (
    <div className="card">
      <div className="card-head">
        <div className="row"><span className="small muted">Show batches expiring within</span>
          <select className="select" style={{ width: 120 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
        </div>
        <span className="small muted">Batch quantities are decremented first-expiry-first-out on sale (informational).</span>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? <Empty title="No batches expiring in this period" /> : (
        <table className="table">
          <thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th className="num">Days left</th><th className="num">Remaining</th></tr></thead>
          <tbody>
            {list.data.map((b) => (
              <tr key={b.id}><td>{b.productName}<div className="sub">{b.sku}</div></td><td className="mono">{b.batchNo ?? '—'}</td><td>{b.expiryDate}</td>
                <td className="num"><span className={`badge ${(b.daysToExpiry ?? 0) < 0 ? 'red' : (b.daysToExpiry ?? 0) <= 30 ? 'amber' : 'gray'}`}>{(b.daysToExpiry ?? 0) < 0 ? 'expired' : b.daysToExpiry}</span></td>
                <td className="num">{b.qtyRemaining} / {b.qtyReceived}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const REASONS = [
  ['count_correction', 'Stock count correction'], ['damaged', 'Damaged'], ['expired', 'Expired'], ['lost_or_stolen', 'Lost or stolen'], ['internal_use', 'Internal use'], ['other', 'Other'],
] as const;

function AdjustDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<Product | null>(null);
  const [dir, setDir] = useState<1 | -1>(-1);
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>('damaged');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const delta = dir * (Number(qty) || 0);
  async function save() {
    if (!p) return;
    try {
      const m = await api('inventory.adjust', { productId: p.id, quantityDelta: delta, reason, note });
      toast.ok(`${p.name}: stock now ${m.balanceAfter}`);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Modal title="Adjust stock" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!p || !delta || note.trim().length < 3} onClick={() => void save()}>Record adjustment</button></>}>
      <div className="col">
        <Banner kind="info">Adjustments are for corrections only (counts, damage, expiry). Use Purchases to receive stock. Every adjustment is recorded with your name and reason.</Banner>
        {error && <Banner kind="danger">{error}</Banner>}
        {p ? (
          <div className="row between card card-pad" style={{ boxShadow: 'none' }}><div><b>{p.name}</b><div className="small faint">{p.sku} · on hand {p.qtyOnHand}</div></div><button className="btn sm" onClick={() => setP(null)}>Change</button></div>
        ) : <ProductPicker onPick={setP} autoFocus />}
        <div className="grid g2">
          <Field label="Direction"><div className="seg"><button className={dir === -1 ? 'on' : ''} onClick={() => setDir(-1)}>Remove (−)</button><button className={dir === 1 ? 'on' : ''} onClick={() => setDir(1)}>Add (+)</button></div></Field>
          <Field label="Quantity" hint={p ? `New balance: ${p.qtyOnHand + delta}` : undefined}><input className="input num" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <Field label="Reason"><select className="select" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Note (required)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 packets torn during unloading" /></Field>
      </div>
    </Modal>
  );
}

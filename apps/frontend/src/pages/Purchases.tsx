import type { Product, Supplier } from '@srmart/shared';
import { paisaToRupeesInput, parseRupees, toLocalISODate } from '@srmart/shared';
import { PackagePlus, Plus, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { api, errMsg } from '../api';
import { ProductPicker } from '../components/ProductPicker';
import { Banner, DemoBadge, Empty, ErrorState, Field, fieldErrors, Loading, Modal, MoneyInput, Pager, useAsync, useToast } from '../components/ui';
import { dateTime, npr } from '../lib/format';

export function Purchases() {
  const [tab, setTab] = useState<'purchases' | 'suppliers'>('purchases');
  return (
    <div>
      <div className="page-head"><div><h1>Purchases & suppliers</h1><p>Receive supplier invoices into stock. Each receipt increases stock in one transaction and is recorded in the stock ledger.</p></div></div>
      <div className="tabs">
        <button className={tab === 'purchases' ? 'on' : ''} onClick={() => setTab('purchases')}>Purchase invoices</button>
        <button className={tab === 'suppliers' ? 'on' : ''} onClick={() => setTab('suppliers')}>Suppliers</button>
      </div>
      {tab === 'purchases' ? <PurchaseList /> : <SupplierList />}
    </div>
  );
}

function PurchaseList() {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const list = useAsync(() => api('purchases.list', { page, pageSize: 25 }), [page]);
  return (
    <div className="card">
      <div className="card-head"><h2>Received purchases</h2><button className="btn primary" onClick={() => setCreating(true)}><PackagePlus /> Receive purchase</button></div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? <Empty title="No purchases yet" icon={<Truck />}>Receive a supplier invoice to add stock.</Empty> : (
        <>
          <table className="table">
            <thead><tr><th>Purchase</th><th>Supplier</th><th>Invoice</th><th>Invoice date</th><th>FY</th><th className="num">Units</th><th className="num">Total cost</th><th>Received by</th></tr></thead>
            <tbody>
              {list.data.rows.map((p) => (
                <tr key={p.id} className="click" onClick={() => setView(p.id)}>
                  <td className="mono">{p.purchaseNo} {p.isDemo && <DemoBadge />}</td>
                  <td>{p.supplierName}</td><td>{p.invoiceNo}</td><td>{p.invoiceDate}</td><td>{p.fiscalYear}</td>
                  <td className="num">{p.itemCount}</td><td className="num" style={{ fontWeight: 650 }}>{npr(p.totalPaisa)}</td><td>{p.receivedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />
        </>
      )}
      {creating && <NewPurchase onClose={() => setCreating(false)} onDone={(id) => (setCreating(false), list.reload(), setView(id))} />}
      {view && <PurchaseView id={view} onClose={() => setView(null)} />}
    </div>
  );
}

function PurchaseView({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useAsync(() => api('purchases.get', { id }), [id]);
  const p = d.data;
  return (
    <Modal title={p ? `Purchase ${p.purchaseNo}` : 'Purchase'} size="wide" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {!p ? <Loading /> : (
        <div className="col">
          <dl className="kv">
            <dt>Supplier</dt><dd>{p.supplierName}</dd><dt>Invoice</dt><dd>{p.invoiceNo} · {p.invoiceDate}</dd>
            <dt>Fiscal year</dt><dd>{p.fiscalYear}</dd><dt>Received</dt><dd>{dateTime(p.receivedAt)} by {p.receivedBy}</dd>
            {p.notes && (<><dt>Notes</dt><dd>{p.notes}</dd></>)}
          </dl>
          <table className="table">
            <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Unit cost</th><th>Batch / expiry</th><th className="num">Line total</th></tr></thead>
            <tbody>
              {p.items.map((i) => <tr key={i.id}><td>{i.name}<div className="sub">{i.sku}</div></td><td className="num">{i.quantity}</td><td className="num">{npr(i.unitCostPaisa)}</td><td className="small">{i.batchNo ?? '—'}{i.expiryDate ? ` · exp ${i.expiryDate}` : ''}</td><td className="num">{npr(i.lineTotalPaisa)}</td></tr>)}
              <tr><td colSpan={4} className="right"><b>Total</b></td><td className="num"><b>{npr(p.totalPaisa)}</b></td></tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

interface Row { product: Product; qty: string; cost: string; batch: string; expiry: string }

function NewPurchase({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const suppliers = useAsync(() => api('suppliers.list'), []);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(toLocalISODate(new Date()));
  const [notes, setNotes] = useState('');
  const [updateCost, setUpdateCost] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = (p: Product) => setRows((r) => (r.some((x) => x.product.id === p.id) ? r : [...r, { product: p, qty: '1', cost: paisaToRupeesInput(p.costPaisa), batch: '', expiry: '' }]));
  const upd = (i: number, k: keyof Row, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const total = rows.reduce((a, r) => a + (Number(r.qty) || 0) * (parseRupees(r.cost || '0') ?? 0), 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const items = rows.map((r) => {
        const unit = parseRupees(r.cost || '0');
        if (unit === null) throw new Error(`Invalid cost for ${r.product.name}`);
        return { productId: r.product.id, quantity: Number(r.qty), unitCostPaisa: unit, batchNo: r.batch || null, expiryDate: r.expiry || null };
      });
      const p = await api('purchases.create', { supplierId: Number(supplierId), invoiceNo, invoiceDate, notes: notes || null, updateCostPrice: updateCost, items });
      toast.ok(`${p.purchaseNo} received — stock updated`);
      onDone(p.id);
    } catch (e) {
      const f = fieldErrors(e);
      setError(Object.keys(f).length ? Object.entries(f).map(([k, v]) => `${k}: ${v}`).join('; ') : errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Receive purchase" size="xwide" onClose={onClose} footer={<><span className="grow muted">Total cost <b style={{ color: 'var(--text)', fontSize: 18 }}>{npr(total)}</b></span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !supplierId || !invoiceNo || !rows.length} onClick={() => void submit()}>{busy ? 'Saving…' : 'Receive into stock'}</button></>}>
      <div className="col">
        {error && <Banner kind="danger">{error}</Banner>}
        <div className="grid g4">
          <Field label="Supplier">
            <select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Select supplier…</option>
              {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Supplier invoice no."><input className="input" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
          <Field label="Invoice date" hint="Determines the fiscal year"><input className="input" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></Field>
          <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <ProductPicker onPick={add} autoFocus />
        {rows.length === 0 ? <Empty title="Add the products on this invoice">Scan each product's barcode or search by name.</Empty> : (
          <table className="table">
            <thead><tr><th>Product</th><th style={{ width: 100 }}>Qty</th><th style={{ width: 130 }}>Unit cost (Rs.)</th><th style={{ width: 130 }}>Batch</th><th style={{ width: 160 }}>Expiry</th><th className="num">Line</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.product.id}>
                  <td>{r.product.name}<div className="sub">{r.product.sku} · now {r.product.qtyOnHand} in stock{r.product.trackExpiry ? ' · tracks expiry' : ''}</div></td>
                  <td><input className="input num" inputMode="numeric" value={r.qty} onChange={(e) => upd(i, 'qty', e.target.value.replace(/\D/g, ''))} /></td>
                  <td><MoneyInput value={r.cost} onChange={(v) => upd(i, 'cost', v)} /></td>
                  <td><input className="input" value={r.batch} onChange={(e) => upd(i, 'batch', e.target.value)} /></td>
                  <td><input className="input" type="date" value={r.expiry} onChange={(e) => upd(i, 'expiry', e.target.value)} /></td>
                  <td className="num">{npr((Number(r.qty) || 0) * (parseRupees(r.cost || '0') ?? 0))}</td>
                  <td><button className="btn ghost sm icon" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label className="check"><input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} /> Update each product's cost price to this invoice's unit cost (used for margin estimates)</label>
        <div className="small muted">The same supplier invoice number cannot be received twice, so stock cannot be doubled by mistake.</div>
      </div>
    </Modal>
  );
}

function SupplierList() {
  const list = useAsync(() => api('suppliers.list'), []);
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  return (
    <div className="card">
      <div className="card-head"><h2>Suppliers</h2><button className="btn primary" onClick={() => setEdit('new')}><Plus /> New supplier</button></div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? <Empty title="No suppliers yet" /> : (
        <table className="table">
          <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>PAN/VAT</th><th className="num">Purchases</th></tr></thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id} className="click" onClick={() => setEdit(s)}>
                <td style={{ fontWeight: 600 }}>{s.name} {s.isDemo && <DemoBadge />}</td><td>{s.contactName ?? '—'}</td><td>{s.phone ?? '—'}</td><td>{s.panVat ?? '—'}</td><td className="num">{s.purchaseCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <SupplierEditor supplier={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
    </div>
  );
}

function SupplierEditor({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: supplier?.name ?? '', contactName: supplier?.contactName ?? '', phone: supplier?.phone ?? '', email: supplier?.email ?? '', address: supplier?.address ?? '', panVat: supplier?.panVat ?? '', notes: supplier?.notes ?? '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function save() {
    try {
      if (supplier) await api('suppliers.update', { id: supplier.id, ...f });
      else await api('suppliers.create', f);
      toast.ok('Supplier saved');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Modal title={supplier ? 'Edit supplier' : 'New supplier'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={f.name.trim().length < 2} onClick={() => void save()}>Save</button></>}>
      <div className="col">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
        <div className="grid g2">
          <Field label="Contact person"><input className="input" value={f.contactName} onChange={set('contactName')} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input className="input" value={f.email} onChange={set('email')} /></Field>
          <Field label="PAN / VAT no."><input className="input" value={f.panVat} onChange={set('panVat')} /></Field>
        </div>
        <Field label="Address"><input className="input" value={f.address} onChange={set('address')} /></Field>
        <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

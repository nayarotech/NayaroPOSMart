import type { Category, ImportReport, Product, Symbology } from '@srmart/shared';
import { paisaToRupeesInput, parseRupees, SYMBOLOGIES } from '@srmart/shared';
import { Barcode, Download, FileUp, Plus, Search, Star, Tags, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg } from '../api';
import { Banner, DemoBadge, Empty, ErrorState, Field, fieldErrors, Loading, Modal, MoneyInput, Pager, StockBadge, useAsync, useToast } from '../components/ui';
import { dateTime, npr } from '../lib/format';
import { useSession } from '../session';

export function Products() {
  const { isAdmin } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [stock, setStock] = useState<'all' | 'low' | 'out'>('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const cats = useAsync(() => api('categories.list'), []);
  const list = useAsync(() => api('products.list', { q: q || undefined, categoryId, status, stock, page, pageSize: 25 }), [q, categoryId, status, stock, page]);

  async function exportCsv() {
    try {
      const r = await api('products.exportCsv');
      if (r.saved) toast.ok(`Exported ${r.count} products to ${r.path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>Products & barcodes</h1><p>Catalogue, prices, stock levels and every barcode that identifies a product.</p></div>
        {isAdmin && (
          <div className="row">
            <button className="btn" onClick={() => setImporting(true)}><FileUp /> Import CSV</button>
            <button className="btn" onClick={() => void exportCsv()}><Download /> Export CSV</button>
            <button className="btn primary" onClick={() => setEditing('new')}><Plus /> New product</button>
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <div className="row wrap">
            <div className="search" style={{ width: 300 }}><Search /><input className="input" placeholder="Name, SKU, brand or barcode" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} autoFocus /></div>
            <select className="select" style={{ width: 180 }} value={categoryId ?? ''} onChange={(e) => (setCategoryId(e.target.value ? Number(e.target.value) : null), setPage(1))}>
              <option value="">All categories</option>
              {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.productCount})</option>)}
            </select>
            <select className="select" style={{ width: 130 }} value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))}>
              <option value="active">Active</option><option value="inactive">Disabled</option><option value="all">All</option>
            </select>
            <select className="select" style={{ width: 140 }} value={stock} onChange={(e) => (setStock(e.target.value as typeof stock), setPage(1))}>
              <option value="all">Any stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
            </select>
          </div>
          <span className="small muted">{list.data?.total ?? 0} products</span>
        </div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? (
          <Empty title="No products found">{isAdmin ? 'Try other filters, or create a product.' : 'Try other filters.'}</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th>SKU</th><th>Barcode</th><th>Category</th><th className="num">Cost</th><th className="num">Price</th><th className="num">Stock</th><th>Status</th></tr></thead>
                <tbody>
                  {list.data.rows.map((p) => {
                    const bc = p.barcodes.find((b) => b.isPrimary) ?? p.barcodes[0];
                    return (
                      <tr key={p.id} className="click" onClick={() => setEditing(p.id)}>
                        <td><div style={{ fontWeight: 600 }}>{p.name} {p.isDemo && <DemoBadge />}</div><div className="sub">{p.brand ?? '—'} · {p.unit}</div></td>
                        <td className="mono">{p.sku}</td>
                        <td>
                          {bc ? <span className="mono">{bc.code}</span> : <span className="badge red">none</span>}
                          <div className="sub">{bc ? `${bc.symbology} · ${bc.source}` : ''}{p.barcodes.length > 1 ? ` · +${p.barcodes.length - 1} more` : ''}</div>
                        </td>
                        <td>{p.categoryName ?? '—'}</td>
                        <td className="num">{npr(p.costPaisa)}</td>
                        <td className="num" style={{ fontWeight: 650 }}>{npr(p.pricePaisa)}{p.labelOutdated && <div><span className="badge amber" title="Price changed after the label was printed">label outdated</span></div>}</td>
                        <td className="num"><StockBadge qty={p.qtyOnHand} min={p.minStock} unit={p.unit} /></td>
                        <td>{p.active ? <span className="badge green">Active</span> : <span className="badge gray">Disabled</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {editing !== null && (
        <ProductEditor
          id={editing === 'new' ? null : editing}
          categories={cats.data ?? []}
          readOnly={!isAdmin}
          onCategoriesChanged={cats.reload}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            list.reload();
            setEditing(p.id);
          }}
          onLabels={(id) => nav(`/labels?products=${id}`)}
        />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={() => (list.reload(), cats.reload())} />}
    </div>
  );
}

interface Form {
  name: string;
  categoryId: number | null;
  brand: string;
  unit: string;
  cost: string;
  price: string;
  minStock: string;
  trackExpiry: boolean;
  openingQty: string;
  barcode: string;
  priceChangeReason: string;
}

function toForm(p: Product | null): Form {
  return {
    name: p?.name ?? '',
    categoryId: p?.categoryId ?? null,
    brand: p?.brand ?? '',
    unit: p?.unit ?? 'pcs',
    cost: p ? paisaToRupeesInput(p.costPaisa) : '',
    price: p ? paisaToRupeesInput(p.pricePaisa) : '',
    minStock: String(p?.minStock ?? 5),
    trackExpiry: p?.trackExpiry ?? false,
    openingQty: '0',
    barcode: '',
    priceChangeReason: '',
  };
}

function ProductEditor({ id, categories, readOnly, onClose, onSaved, onCategoriesChanged, onLabels }: {
  id: number | null; categories: Category[]; readOnly: boolean; onClose: () => void; onSaved: (p: Product) => void; onCategoriesChanged: () => void; onLabels: (id: number) => void;
}) {
  const toast = useToast();
  const detail = useAsync(() => (id ? api('products.get', { id }) : Promise.resolve(null)), [id]);
  const p = detail.data;
  const [form, setForm] = useState<Form | null>(id ? null : toForm(null));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCat, setNewCat] = useState('');
  if (id && p && !form) setForm(toForm(p));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  if (!form) return <Modal title="Product" onClose={onClose}>{detail.error ? <Banner kind="danger">{detail.error}</Banner> : <Loading />}</Modal>;
  const cost = parseRupees(form.cost || '0');
  const price = parseRupees(form.price || '');
  const marginBp = price && cost !== null && price > 0 ? Math.round(((price - cost) * 10000) / price) : null;
  const priceChanged = !!p && price !== null && price !== p.pricePaisa;

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      if (price === null || cost === null) throw new Error('Enter valid cost and selling prices');
      const common = { name: form.name, categoryId: form.categoryId, brand: form.brand || null, unit: form.unit, costPaisa: cost, pricePaisa: price, minStock: Number(form.minStock) || 0, trackExpiry: form.trackExpiry };
      const saved = p
        ? await api('products.update', { id: p.id, ...common, priceChangeReason: form.priceChangeReason || null })
        : await api('products.create', { ...common, openingQty: Number(form.openingQty) || 0, barcode: form.barcode.trim() || null, generateInternalBarcode: !form.barcode.trim() });
      toast.ok(p ? 'Product saved' : `Created ${saved.sku}`);
      setForm(toForm(saved));
      onSaved(saved);
      detail.reload();
    } catch (e) {
      setErrors(fieldErrors(e));
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function addCategory() {
    try {
      const c = await api('categories.create', { name: newCat });
      onCategoriesChanged();
      set('categoryId', c.id);
      setNewCat('');
    } catch (e) {
      toast.error(e);
    }
  }

  async function toggleActive() {
    if (!p) return;
    try {
      await api('products.setActive', { id: p.id, active: !p.active });
      toast.ok(p.active ? 'Product disabled — it can no longer be sold' : 'Product enabled');
      detail.reload();
      onSaved(p);
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <Modal
      title={p ? <>{p.name} <span className="mono faint" style={{ fontSize: 13 }}>{p.sku}</span></> : 'New product'}
      onClose={onClose}
      size="xwide"
      footer={readOnly ? <button className="btn" onClick={onClose}>Close</button> : (
        <>
          {p && <button className="btn" onClick={() => onLabels(p.id)}><Tags /> Print labels</button>}
          {p && <button className="btn" onClick={() => void toggleActive()}>{p.active ? 'Disable product' : 'Enable product'}</button>}
          <div className="grow" />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : p ? 'Save changes' : 'Create product'}</button>
        </>
      )}
    >
      <div className="grid" style={{ gridTemplateColumns: p ? '1.2fr 1fr' : '1fr', gap: 24 }}>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="col">
          {error && <Banner kind="danger">{error}</Banner>}
          {p?.labelOutdated && <Banner kind="warn">The price changed after the last label print ({p.labelPrintedAt && dateTime(p.labelPrintedAt)}). Shelf labels may show an old price — reprint them.</Banner>}
          <Field label="Product name" error={errors.name}><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
          <div className="grid g3">
            <Field label="Category">
              <select className="select" value={form.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Brand"><input className="input" value={form.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
            <Field label="Unit" hint="pcs, pkt, btl, kg (pre-packed)…"><input className="input" value={form.unit} onChange={(e) => set('unit', e.target.value)} /></Field>
          </div>
          {!readOnly && (
            <div className="row">
              <input className="input" placeholder="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} style={{ maxWidth: 260 }} />
              <button type="button" className="btn sm" disabled={newCat.trim().length < 2} onClick={() => void addCategory()}><Plus /> Add category</button>
            </div>
          )}
          <div className="grid g3">
            <Field label="Cost price (Rs.)" error={errors.costPaisa}><MoneyInput value={form.cost} onChange={(v) => set('cost', v)} /></Field>
            <Field label="Selling price (Rs.)" error={errors.pricePaisa} hint={marginBp !== null ? `Est. margin ${(marginBp / 100).toFixed(1)}%` : undefined}><MoneyInput value={form.price} onChange={(v) => set('price', v)} /></Field>
            <Field label="Minimum stock" hint="Low-stock alert at or below"><input className="input num" inputMode="numeric" value={form.minStock} onChange={(e) => set('minStock', e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          {priceChanged && <Field label="Reason for price change (recorded in audit log)"><input className="input" value={form.priceChangeReason} onChange={(e) => set('priceChangeReason', e.target.value)} placeholder="e.g. supplier price increase" /></Field>}
          <label className="check"><input type="checkbox" checked={form.trackExpiry} onChange={(e) => set('trackExpiry', e.target.checked)} /> Track batches & expiry dates (entered when receiving purchases)</label>
          {!p && (
            <>
              <div className="grid g2">
                <Field label="Opening stock" hint="Recorded as an 'opening' stock movement"><input className="input num" inputMode="numeric" value={form.openingQty} onChange={(e) => set('openingQty', e.target.value.replace(/\D/g, ''))} /></Field>
                <Field label="Manufacturer barcode (optional)" hint="Scan the product's existing barcode. Leave empty to generate an Nayaro Mart Code 128 barcode." error={errors.barcode}>
                  <input className="input mono" value={form.barcode} onChange={(e) => set('barcode', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} placeholder="Scan here" />
                </Field>
              </div>
            </>
          )}
          {p && (
            <dl className="kv small">
              <dt>Stock on hand</dt><dd><StockBadge qty={p.qtyOnHand} min={p.minStock} unit={p.unit} /> <span className="faint">(change via Purchases or Inventory → Adjust)</span></dd>
              <dt>Created</dt><dd>{dateTime(p.createdAt)}</dd>
              <dt>Last label print</dt><dd>{p.labelPrintedAt ? dateTime(p.labelPrintedAt) : 'never'}</dd>
            </dl>
          )}
        </fieldset>
        {p && (
          <div className="col">
            <BarcodePanel product={p} readOnly={readOnly} onChanged={detail.reload} />
            <div>
              <div className="section-title">Price history</div>
              <table className="table">
                <thead><tr><th>From</th><th className="num">Price</th><th className="num">Cost</th><th>By / reason</th></tr></thead>
                <tbody>
                  {p.priceHistory.map((h) => (
                    <tr key={h.id}><td className="small">{dateTime(h.effectiveFrom)}</td><td className="num">{npr(h.pricePaisa)}</td><td className="num">{npr(h.costPaisa)}</td><td className="small">{h.changedBy ?? '—'}{h.reason ? ` · ${h.reason}` : ''}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="small faint mt">Past sales keep the price that applied at the time of sale.</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function BarcodePanel({ product, readOnly, onChanged }: { product: Product; readOnly: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [sym, setSym] = useState<'' | Symbology>('');
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      toast.ok(msg);
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <div className="card card-pad" style={{ boxShadow: 'none' }}>
      <div className="row between mb"><h3 className="row"><Barcode size={16} /> Barcodes</h3>
        {!readOnly && !product.barcodes.some((b) => b.source === 'internal') && (
          <button className="btn sm" onClick={() => void run(() => api('barcodes.generateInternal', { productId: product.id }), 'Internal barcode generated')}><Wand2 /> Generate internal</button>
        )}
      </div>
      {error && <div className="mb"><Banner kind="danger">{error}</Banner></div>}
      {product.barcodes.length === 0 ? <div className="small muted">No barcode yet. Scan the manufacturer barcode below or generate an internal one.</div> : (
        <table className="table">
          <tbody>
            {product.barcodes.map((b) => (
              <tr key={b.id}>
                <td className="mono">{b.code}</td>
                <td><span className="badge gray">{b.symbology}</span> <span className={`badge ${b.source === 'internal' ? 'blue' : 'green'}`}>{b.source}</span></td>
                <td className="right nowrap">
                  {b.isPrimary ? <span className="badge amber"><Star size={11} /> primary</span> : !readOnly && <button className="btn ghost sm" onClick={() => void run(() => api('barcodes.setPrimary', { barcodeId: b.id }), 'Primary barcode updated')}>Make primary</button>}
                  {!readOnly && <button className="btn ghost sm icon" title="Remove barcode" onClick={() => confirm(`Remove barcode ${b.code}? Scanning it will no longer find this product.`) && void run(() => api('barcodes.remove', { barcodeId: b.id }), 'Barcode removed')}><Trash2 /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!readOnly && (
        <div className="row mt">
          <input className="input mono" placeholder="Scan / type another barcode" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void run(() => api('barcodes.add', { productId: product.id, code: code.trim(), symbology: sym || undefined }), 'Barcode registered').then(() => setCode(''))} />
          <select className="select" style={{ width: 130 }} value={sym} onChange={(e) => setSym(e.target.value as Symbology | '')}>
            <option value="">Auto-detect</option>
            {SYMBOLOGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="btn" disabled={!code.trim()} onClick={() => void run(() => api('barcodes.add', { productId: product.id, code: code.trim(), symbology: sym || undefined }), 'Barcode registered').then(() => setCode(''))}>Add</button>
        </div>
      )}
      <div className="small faint mt">A barcode only identifies the product — the price is always read from the database at checkout. Each barcode can belong to one product only.</div>
    </div>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(f: File) {
    setFileName(f.name);
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    setError(null);
    try {
      setReport(await api('products.importCsv', { csv: text, commit: false }));
    } catch (e) {
      setError(errMsg(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!csv) return;
    setBusy(true);
    try {
      const r = await api('products.importCsv', { csv, commit: true });
      setReport(r);
      toast.ok(`Imported ${r.ok} products`);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Import products from CSV" size="wide" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={!report || report.committed || !report.ok || busy} onClick={() => void commit()}>Import {report?.ok ?? 0} valid rows</button></>}>
      <div className="col">
        <Banner kind="info">Columns: <span className="mono">name, selling_price</span> (required) and optional <span className="mono">sku, category, brand, unit, cost_price, qty_on_hand, min_stock, barcode, barcode_type, track_expiry, active</span>. Tip: export first to get a template. Existing products are never overwritten; duplicates are reported and skipped. Nothing is saved until you press Import.</Banner>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
        {busy && <Loading text="Checking file…" />}
        {error && <Banner kind="danger">{error}</Banner>}
        {report && (
          <>
            <div className="row">
              <b>{fileName}</b>
              <span className="badge green">{report.ok} ok</span>
              <span className="badge amber">{report.duplicates} duplicates</span>
              <span className="badge red">{report.errors} errors</span>
              {report.committed && <span className="badge blue">imported</span>}
            </div>
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table className="table">
                <thead><tr><th>Row</th><th>Name</th><th>Result</th><th>Details</th></tr></thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.row}><td>{r.row}</td><td>{r.name}</td><td><span className={`badge ${r.status === 'ok' ? 'green' : r.status === 'duplicate' ? 'amber' : 'red'}`}>{r.status}</span></td><td className="small">{r.message}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

import type { SaleDetail } from '@srmart/shared';
import { Ban, Printer, ReceiptText, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, errMsg } from '../api';
import { ApprovalDialog, Banner, DemoBadge, Empty, ErrorState, Field, Loading, Modal, Pager, useAsync, useToast } from '../components/ui';
import { dateTime, npr, STATUS_LABEL } from '../lib/format';
import { useSession } from '../session';
import { ReceiptModal } from './Pos';

const statusBadge = (s: string) => <span className={`badge ${s === 'completed' ? 'green' : s === 'voided' ? 'red' : 'amber'}`}>{STATUS_LABEL[s]}</span>;

export function Sales() {
  const { info } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [fy, setFy] = useState(info?.fiscal.code ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'all' | 'completed' | 'voided' | 'partially_returned' | 'returned'>('all');
  const [page, setPage] = useState(1);
  const fys = useAsync(() => api('reports.fiscalYears'), []);
  const list = useAsync(() => api('sales.list', { q: q || undefined, fiscalYear: fy || undefined, from: from || undefined, to: to || undefined, status, page, pageSize: 25 }), [q, fy, from, to, status, page]);
  const openId = params.get('id') ? Number(params.get('id')) : null;

  return (
    <div>
      <div className="page-head">
        <div><h1>Sales & receipts</h1><p>Every completed sale is kept permanently. Corrections are made with voids or returns, never deletion.</p></div>
      </div>
      <div className="card">
        <div className="card-head">
          <div className="row wrap">
            <div className="search" style={{ width: 260 }}><Search /><input className="input" placeholder="Receipt no. (scan receipt barcode)" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} /></div>
            <select className="select" style={{ width: 170 }} value={fy} onChange={(e) => (setFy(e.target.value), setPage(1))}>
              <option value="">All fiscal years</option>
              {fys.data?.map((f) => <option key={f.code} value={f.code}>FY {f.code}{f.isCurrent ? ' (running)' : ''}</option>)}
            </select>
            <input className="input" type="date" style={{ width: 150 }} value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} title="From" />
            <input className="input" type="date" style={{ width: 150 }} value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} title="To" />
            <select className="select" style={{ width: 160 }} value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))}>
              <option value="all">All statuses</option><option value="completed">Completed</option><option value="partially_returned">Part returned</option><option value="returned">Returned</option><option value="voided">Voided</option>
            </select>
          </div>
        </div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? <Empty title="No sales match these filters" icon={<ReceiptText />} /> : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Receipt</th><th>Date (AD / BS)</th><th>FY</th><th>Cashier</th><th>Payment</th><th className="num">Items</th><th>Status</th><th className="num">Total</th><th className="num">Refunded</th></tr></thead>
                <tbody>
                  {list.data.rows.map((s) => (
                    <tr key={s.id} className={`click ${openId === s.id ? 'sel' : ''}`} onClick={() => setParams({ id: String(s.id) })}>
                      <td className="mono">{s.receiptNo} {s.isDemo && <DemoBadge />}</td>
                      <td>{dateTime(s.createdAt)}</td>
                      <td>{s.fiscalYear}</td>
                      <td>{s.cashierName}</td>
                      <td>{s.paymentMethod}</td>
                      <td className="num">{s.itemCount}</td>
                      <td>{statusBadge(s.status)}</td>
                      <td className="num" style={{ fontWeight: 650 }}>{npr(s.totalPaisa)}</td>
                      <td className="num">{s.refundedPaisa ? npr(s.refundedPaisa) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {openId && <SaleDrawer id={openId} onClose={() => setParams({})} onChanged={list.reload} />}
    </div>
  );
}

function SaleDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { data: sale, error, reload, setData } = useAsync(() => api('sales.get', { id }), [id]);
  const [receipt, setReceipt] = useState(false);
  const [mode, setMode] = useState<'void' | 'return' | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !mode && !receipt && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mode, receipt, onClose]);
  const updated = (s: SaleDetail) => {
    setData(s);
    setMode(null);
    onChanged();
  };
  return (
    <div className="drawer">
      <div className="modal-head">
        <h2>{sale ? <span className="mono">{sale.receiptNo}</span> : 'Sale'}</h2>
        <button className="btn ghost icon sm" onClick={onClose}><X /></button>
      </div>
      <div className="modal-body col" style={{ flex: 1 }}>
        {error ? <ErrorState error={error} onRetry={reload} /> : !sale ? <Loading /> : (
          <>
            <div className="row wrap">
              {statusBadge(sale.status)} {sale.isDemo && <DemoBadge />} <span className="badge blue">FY {sale.fiscalYear}</span>
            </div>
            <dl className="kv">
              <dt>Date</dt><dd>{dateTime(sale.createdAt)} · {sale.bsDate} BS</dd>
              <dt>Cashier</dt><dd>{sale.cashierName}</dd>
              {sale.discountApprovedBy && (<><dt>Discount approved by</dt><dd>{sale.discountApprovedBy}</dd></>)}
              {sale.customer && (<><dt>Customer</dt><dd>{sale.customer.name} · <span className="mono">{sale.customer.phone}</span></dd></>)}
              {sale.coupons.length > 0 && (<><dt>Lucky-draw coupons</dt><dd><span className="mono">{sale.coupons.map((c) => c.couponNo).join(', ')}</span> {!sale.coupons[0]!.eligible && <span className="badge red">no longer eligible</span>}</dd></>)}
              {sale.voidReason && (<><dt>Voided</dt><dd>{sale.voidedBy} · {sale.voidedAt && dateTime(sale.voidedAt)} — “{sale.voidReason}”</dd></>)}
            </dl>
            <table className="table">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Disc.</th><th className="num">Net</th></tr></thead>
              <tbody>
                {sale.items.map((i) => (
                  <tr key={i.id}>
                    <td><div style={{ fontWeight: 600 }}>{i.name}</div><div className="sub">{i.sku}{i.returnedQuantity ? ` · ${i.returnedQuantity} returned` : ''}</div>{i.promoDiscountPaisa > 0 && <span className="badge green">{i.promotionName} −{npr(i.promoDiscountPaisa)}</span>}</td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{npr(i.unitPricePaisa)}</td>
                    <td className="num">{i.discountPaisa ? npr(i.discountPaisa) : '—'}</td>
                    <td className="num">{npr(i.lineTotalPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="totals card" style={{ boxShadow: 'none' }}>
              <div className="line"><span>Subtotal</span><span>{npr(sale.subtotalPaisa)}</span></div>
              {sale.promoDiscountPaisa > 0 && <div className="line"><span>Festival offers</span><span>-{npr(sale.promoDiscountPaisa)}</span></div>}
              <div className="line"><span>Discount</span><span>-{npr(sale.discountPaisa - sale.promoDiscountPaisa)}</span></div>
              {sale.taxPaisa > 0 && <div className="line"><span>{sale.taxLabel}</span><span>{npr(sale.taxPaisa)}</span></div>}
              <div className="grand"><span className="muted">Total</span><span className="v" style={{ fontSize: 24 }}>{npr(sale.totalPaisa)}</span></div>
            </div>
            <div>
              <div className="section-title">Payments & refunds</div>
              <table className="table">
                <tbody>
                  {sale.payments.map((p) => (
                    <tr key={p.id}>
                      <td><span className={`badge ${p.kind === 'payment' ? 'green' : 'red'}`}>{p.kind}</span> {p.method}</td>
                      <td className="small muted">{dateTime(p.createdAt)}{p.reference ? ` · ${p.reference}` : ''}</td>
                      <td className="num">{p.kind === 'refund' ? '-' : ''}{npr(p.amountPaisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sale.returns.length > 0 && (
              <div>
                <div className="section-title">Returns</div>
                {sale.returns.map((r) => (
                  <div key={r.id} className="card card-pad small" style={{ boxShadow: 'none', marginBottom: 8 }}>
                    <div className="row between"><b className="mono">{r.returnNo}</b><span>{npr(r.refundPaisa)}</span></div>
                    <div className="muted">{dateTime(r.createdAt)} · by {r.createdBy}{r.approvedBy ? ` · approved by ${r.approvedBy}` : ''} · {r.restock ? 'restocked' : 'not restocked'}</div>
                    <div>“{r.reason}” — {r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {sale && (
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <button className="btn" onClick={() => setReceipt(true)}><Printer /> Reprint receipt</button>
          <div className="row">
            <button className="btn" disabled={sale.status === 'voided' || sale.status === 'returned'} onClick={() => setMode('return')}><RotateCcw /> Return items</button>
            <button className="btn danger" disabled={sale.status !== 'completed'} onClick={() => setMode('void')}><Ban /> Void sale</button>
          </div>
        </div>
      )}
      {receipt && sale && <ReceiptModal sale={sale} reprint onClose={() => setReceipt(false)} />}
      {mode === 'void' && sale && <VoidDialog sale={sale} onClose={() => setMode(null)} onDone={updated} />}
      {mode === 'return' && sale && <ReturnDialog sale={sale} onClose={() => setMode(null)} onDone={updated} />}
    </div>
  );
}

function useApprovalAction() {
  const [needApproval, setNeedApproval] = useState<null | ((c: { username: string; password: string }) => void)>(null);
  return { needApproval, setNeedApproval };
}

function VoidDialog({ sale, onClose, onDone }: { sale: SaleDetail; onClose: () => void; onDone: (s: SaleDetail) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { needApproval, setNeedApproval } = useApprovalAction();
  async function run(override?: { username: string; password: string }) {
    setError(null);
    try {
      const s = await api('sales.void', { saleId: sale.id, reason, override: override ?? null });
      toast.ok(`Sale ${sale.receiptNo} voided; stock restored`);
      onDone(s);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedApproval(() => (c: { username: string; password: string }) => void run(c));
      else setError(errMsg(e));
    }
  }
  return (
    <>
      <Modal title={`Void ${sale.receiptNo}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={reason.trim().length < 5} onClick={() => void run()}>Void sale</button></>}>
        <div className="col">
          <Banner kind="warn">Voiding reverses the whole sale ({npr(sale.totalPaisa)}): all items return to stock and a refund is recorded. The sale stays in the records, marked VOIDED, with your reason in the audit log.</Banner>
          {error && <Banner kind="danger">{error}</Banner>}
          <Field label="Reason (required)"><textarea className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong items scanned, customer cancelled" /></Field>
        </div>
      </Modal>
      {needApproval && <ApprovalDialog purpose="Voiding a sale" onCancel={() => setNeedApproval(null)} onApprove={(c) => (setNeedApproval(null), needApproval(c))} />}
    </>
  );
}

function ReturnDialog({ sale, onClose, onDone }: { sale: SaleDetail; onClose: () => void; onDone: (s: SaleDetail) => void }) {
  const toast = useToast();
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { needApproval, setNeedApproval } = useApprovalAction();
  const items = Object.entries(qty).filter(([, q]) => q > 0).map(([saleItemId, quantity]) => ({ saleItemId: Number(saleItemId), quantity }));
  async function run(override?: { username: string; password: string }) {
    setError(null);
    try {
      const s = await api('sales.return', { saleId: sale.id, items, reason, restock, override: override ?? null });
      toast.ok(`Return recorded: refund ${npr(s.returns.at(-1)?.refundPaisa ?? 0)}`);
      onDone(s);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedApproval(() => (c: { username: string; password: string }) => void run(c));
      else setError(errMsg(e));
    }
  }
  return (
    <>
      <Modal title={`Return items — ${sale.receiptNo}`} size="wide" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!items.length || reason.trim().length < 5} onClick={() => void run()}>Record return & refund</button></>}>
        <div className="col">
          {error && <Banner kind="danger">{error}</Banner>}
          <table className="table">
            <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Already returned</th><th style={{ width: 120 }}>Return now</th></tr></thead>
            <tbody>
              {sale.items.map((i) => {
                const left = i.quantity - i.returnedQuantity;
                return (
                  <tr key={i.id}>
                    <td>{i.name}<div className="sub">{npr(i.unitPricePaisa)} each</div></td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{i.returnedQuantity}</td>
                    <td><input className="input num" type="number" min={0} max={left} disabled={!left} value={qty[i.id] ?? 0} onChange={(e) => setQty({ ...qty, [i.id]: Math.max(0, Math.min(left, Number(e.target.value) || 0)) })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Field label="Reason (required)"><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Damaged packaging, wrong size" /></Field>
          <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put returned items back into sellable stock</label>
          <div className="small muted">The refund amount is calculated from the original sale prices and discounts and paid out with the original payment method.</div>
        </div>
      </Modal>
      {needApproval && <ApprovalDialog purpose="A return / refund" onCancel={() => setNeedApproval(null)} onApprove={(c) => (setNeedApproval(null), needApproval(c))} />}
    </>
  );
}

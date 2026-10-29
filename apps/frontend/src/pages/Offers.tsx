import type { Promotion, Scheme } from '@srmart/shared';
import { paisaToRupeesInput, parseRupees, toLocalISODate } from '@srmart/shared';
import { Dice5, Gift, Plus, Search, Tag, Trophy, Users } from 'lucide-react';
import { useState } from 'react';
import { api, errMsg } from '../api';
import { Banner, DemoBadge, Empty, ErrorState, Field, Loading, Modal, MoneyInput, Pager, useAsync, useToast } from '../components/ui';
import { dateTime, npr } from '../lib/format';

const STATE_BADGE: Record<Promotion['state'], string> = { running: 'green', scheduled: 'blue', ended: 'gray', inactive: 'red' };
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toLocalISODate(d);
};

export function Offers() {
  const [tab, setTab] = useState<'promos' | 'schemes' | 'customers'>('promos');
  return (
    <div>
      <div className="page-head">
        <div><h1>Offers & lucky draw</h1><p>Festival discounts applied automatically at checkout, and lucky-draw coupons for bigger bills.</p></div>
      </div>
      <div className="tabs">
        <button className={tab === 'promos' ? 'on' : ''} onClick={() => setTab('promos')}><Tag size={14} /> Festival discounts</button>
        <button className={tab === 'schemes' ? 'on' : ''} onClick={() => setTab('schemes')}><Gift size={14} /> Lucky-draw schemes</button>
        <button className={tab === 'customers' ? 'on' : ''} onClick={() => setTab('customers')}><Users size={14} /> Customers</button>
      </div>
      {tab === 'promos' && <Promotions />}
      {tab === 'schemes' && <Schemes />}
      {tab === 'customers' && <Customers />}
    </div>
  );
}

// ---------------- festival discounts ----------------
function Promotions() {
  const list = useAsync(() => api('promotions.list'), []);
  const [edit, setEdit] = useState<Promotion | 'new' | null>(null);
  return (
    <div className="col">
      <Banner kind="info">A running offer is applied automatically to matching products at checkout (the best offer wins if several match). It does not count toward the cashier's discount limit, and each sale records exactly which offer was applied.</Banner>
      <div className="card">
        <div className="card-head"><h2>Offers</h2><button className="btn primary" onClick={() => setEdit('new')}><Plus /> New offer</button></div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? <Empty title="No offers yet" icon={<Tag />}>Create e.g. “Dashain offer — 10% on everything”.</Empty> : (
          <table className="table">
            <thead><tr><th>Offer</th><th className="num">Discount</th><th>Applies to</th><th>Period</th><th>Status</th><th className="num">Lines</th><th className="num">Discount given</th></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="click" onClick={() => setEdit(p)}>
                  <td style={{ fontWeight: 600 }}>{p.name} {p.isDemo && <DemoBadge />}</td>
                  <td className="num"><b>{p.percentBp / 100}%</b></td>
                  <td>{p.categoryName ?? 'All products'}</td>
                  <td className="small">{p.startsOn} → {p.endsOn}</td>
                  <td><span className={`badge ${STATE_BADGE[p.state]}`}>{p.state}</span></td>
                  <td className="num">{p.timesApplied}</td>
                  <td className="num">{npr(p.discountGivenPaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <PromotionEditor promo={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
    </div>
  );
}

function PromotionEditor({ promo, onClose, onSaved }: { promo: Promotion | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const cats = useAsync(() => api('categories.list'), []);
  const [f, setF] = useState({ name: promo?.name ?? '', percent: promo ? String(promo.percentBp / 100) : '10', categoryId: promo?.categoryId ?? null, startsOn: promo?.startsOn ?? toLocalISODate(new Date()), endsOn: promo?.endsOn ?? plusDays(14), active: promo?.active ?? true });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      const body = { name: f.name, percentBp: Math.round(Number(f.percent) * 100), categoryId: f.categoryId, startsOn: f.startsOn, endsOn: f.endsOn, active: f.active };
      if (promo) await api('promotions.update', { id: promo.id, ...body });
      else await api('promotions.create', body);
      toast.ok('Offer saved');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Modal title={promo ? 'Edit offer' : 'New festival offer'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void save()}>Save</button></>}>
      <div className="col">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Offer name" hint="Shown on the receipt, e.g. “Dashain offer”"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <div className="grid g2">
          <Field label="Discount (%)"><input className="input num" type="number" step="0.5" min={0.5} max={90} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field>
          <Field label="Applies to">
            <select className="select" value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">All products</option>
              {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Starts on"><input className="input" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></Field>
          <Field label="Ends on (inclusive)"><input className="input" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (untick to stop the offer early)</label>
        <div className="small muted">Changing an offer never changes past sales — they keep the discount recorded at the time.</div>
      </div>
    </Modal>
  );
}

// ---------------- lucky-draw schemes ----------------
function Schemes() {
  const list = useAsync(() => api('schemes.list'), []);
  const [edit, setEdit] = useState<Scheme | 'new' | null>(null);
  const [view, setView] = useState<number | null>(null);
  return (
    <div className="col">
      <Banner kind="warn">
        Prize schemes and lucky draws may need permission or have rules in Nepal (see <span className="mono">docs/NEPAL_COMPLIANCE.md</span>). Customer phone numbers are personal data: they are stored only when the customer agrees at the counter, used only for this scheme, and visible to administrators only.
      </Banner>
      <div className="card">
        <div className="card-head"><h2>Schemes</h2><button className="btn primary" onClick={() => setEdit('new')}><Plus /> New scheme</button></div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? <Empty title="No schemes yet" icon={<Gift />}>e.g. “Tihar Lucky Draw — 1 coupon per Rs 2,000 bill”.</Empty> : (
          <table className="table">
            <thead><tr><th>Scheme</th><th>Rule</th><th>Period</th><th>Status</th><th className="num">Coupons (eligible)</th><th className="num">Customers</th><th className="num">Winners</th></tr></thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="click" onClick={() => setView(s.id)}>
                  <td style={{ fontWeight: 600 }}>{s.name} {s.isDemo && <DemoBadge />}<div className="sub mono">{s.couponPrefix}-#####</div></td>
                  <td className="small">Bill ≥ {npr(s.minBillPaisa)}{s.entryStepPaisa ? ` · +1 coupon per ${npr(s.entryStepPaisa)}` : ' · 1 coupon'}</td>
                  <td className="small">{s.startsOn} → {s.endsOn}</td>
                  <td><span className={`badge ${STATE_BADGE[s.state]}`}>{s.state}</span></td>
                  <td className="num">{s.couponCount} ({s.eligibleCouponCount})</td>
                  <td className="num">{s.customerCount}</td>
                  <td className="num">{s.winnerCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <SchemeEditor scheme={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
      {view && <SchemeView id={view} onClose={() => (setView(null), list.reload())} onEdit={(s) => (setView(null), setEdit(s))} />}
    </div>
  );
}

function SchemeEditor({ scheme, onClose, onSaved }: { scheme: Scheme | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: scheme?.name ?? '',
    description: scheme?.description ?? '',
    min: scheme ? paisaToRupeesInput(scheme.minBillPaisa) : '2000',
    step: scheme?.entryStepPaisa ? paisaToRupeesInput(scheme.entryStepPaisa) : '',
    startsOn: scheme?.startsOn ?? toLocalISODate(new Date()),
    endsOn: scheme?.endsOn ?? plusDays(30),
    couponPrefix: scheme?.couponPrefix ?? '',
    active: scheme?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const min = parseRupees(f.min || '0') ?? 0;
  const step = f.step ? parseRupees(f.step) : null;
  const example = (total: number) => (total < min ? 0 : !step ? 1 : 1 + Math.floor((total - min) / step));
  const locked = (scheme?.couponCount ?? 0) > 0;
  async function save() {
    setError(null);
    try {
      const body = { name: f.name, description: f.description, minBillPaisa: min, entryStepPaisa: step, startsOn: f.startsOn, endsOn: f.endsOn, couponPrefix: f.couponPrefix, active: f.active };
      if (scheme) await api('schemes.update', { id: scheme.id, ...body });
      else await api('schemes.create', body);
      toast.ok('Scheme saved');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Modal title={scheme ? 'Edit scheme' : 'New lucky-draw scheme'} size="wide" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void save()}>Save</button></>}>
      <div className="col">
        {error && <Banner kind="danger">{error}</Banner>}
        {locked && <Banner kind="info">Coupons were already issued, so the coupon prefix, minimum bill and step are locked. You can still rename it, change the dates or stop it.</Banner>}
        <div className="grid g2">
          <Field label="Scheme name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label="Coupon prefix" hint="Letters/digits, e.g. TIHAR → TIHAR-00001"><input className="input mono" value={f.couponPrefix} disabled={locked} onChange={(e) => setF({ ...f, couponPrefix: e.target.value.toUpperCase() })} /></Field>
          <Field label="Minimum bill (Rs.)" hint="Bills at or above this get 1 coupon"><MoneyInput value={f.min} onChange={(v) => !locked && setF({ ...f, min: v })} /></Field>
          <Field label="Extra coupon for every (Rs.)" hint="Optional. Empty = 1 coupon per bill"><MoneyInput value={f.step} onChange={(v) => !locked && setF({ ...f, step: v })} /></Field>
          <Field label="Starts on"><input className="input" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></Field>
          <Field label="Ends on (inclusive)"><input className="input" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>
        </div>
        <Field label="Description / terms (for staff)"><textarea className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        <div className="small muted">Examples: Rs 1,999 → {example(199900)} · Rs 2,000 → {example(200000)} · Rs 3,000 → {example(300000)} · Rs 5,000 → {example(500000)} coupon(s).</div>
      </div>
    </Modal>
  );
}

function SchemeView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (s: Scheme) => void }) {
  const d = useAsync(() => api('schemes.get', { id }), [id]);
  const [drawing, setDrawing] = useState(false);
  const s = d.data;
  return (
    <Modal title={s ? s.name : 'Scheme'} size="xwide" onClose={onClose} footer={s && <><button className="btn" onClick={() => onEdit(s)}>Edit scheme</button><div className="grow" /><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={s.eligibleCouponCount - s.winnerCount <= 0} onClick={() => setDrawing(true)}><Dice5 /> Draw winner(s)</button></>}>
      {!s ? <Loading /> : (
        <div className="col">
          <div className="grid g4">
            <div className="card stat"><div className="stat-label">Status</div><div className="stat-value" style={{ fontSize: 18 }}>{s.state}</div><div className="stat-sub">{s.startsOn} → {s.endsOn}</div></div>
            <div className="card stat"><div className="stat-label">Coupons issued</div><div className="stat-value">{s.couponCount}</div><div className="stat-sub">{s.eligibleCouponCount - s.winnerCount} still in the draw (voided/returned and already-won coupons excluded)</div></div>
            <div className="card stat"><div className="stat-label">Customers</div><div className="stat-value">{s.customerCount}</div></div>
            <div className="card stat"><div className="stat-label">Winners drawn</div><div className="stat-value">{s.winnerCount}</div></div>
          </div>
          {s.winners.length > 0 && (
            <div className="card">
              <div className="card-head"><h2 className="row"><Trophy size={18} /> Winners</h2></div>
              <table className="table">
                <thead><tr><th>#</th><th>Prize</th><th>Coupon</th><th>Customer</th><th>Phone</th><th>Receipt</th><th>Drawn</th></tr></thead>
                <tbody>{s.winners.map((w) => <tr key={w.id}><td><b>{w.rank}</b></td><td>{w.prize}</td><td className="mono">{w.couponNo}</td><td>{w.customerName}</td><td className="mono">{w.customerPhone}</td><td className="mono small">{w.receiptNo}</td><td className="small">{dateTime(w.drawnAt)} by {w.drawnBy} · from {w.poolSize} coupons</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h2>Coupons</h2><span className="small muted">Coupons from voided or fully returned sales are not eligible.</span></div>
            {s.coupons.length === 0 ? <Empty title="No coupons yet" /> : (
              <div className="table-wrap" style={{ maxHeight: 360 }}>
                <table className="table">
                  <thead><tr><th>Coupon</th><th>Customer</th><th>Phone</th><th>Receipt</th><th className="num">Bill</th><th>Issued</th><th /></tr></thead>
                  <tbody>{s.coupons.map((c) => <tr key={c.id}><td className="mono">{c.couponNo}</td><td>{c.customerName}</td><td className="mono">{c.customerPhone}</td><td className="mono small">{c.receiptNo}</td><td className="num">{npr(c.billTotalPaisa)}</td><td className="small">{dateTime(c.createdAt)}</td><td>{c.eligible ? <span className="badge green">eligible</span> : <span className="badge red">void</span>}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      {drawing && s && <DrawDialog scheme={s} onClose={() => setDrawing(false)} onDone={() => (setDrawing(false), d.reload())} />}
    </Modal>
  );
}

function DrawDialog({ scheme, onClose, onDone }: { scheme: Scheme; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [prize, setPrize] = useState('');
  const [count, setCount] = useState('1');
  const [early, setEarly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notEnded = scheme.state !== 'ended';
  async function draw() {
    setBusy(true);
    setError(null);
    try {
      const winners = await api('schemes.draw', { schemeId: scheme.id, prize, count: Number(count), allowBeforeEnd: early });
      toast.ok(`Winner${winners.length > 1 ? 's' : ''}: ${winners.map((w) => `${w.couponNo} (${w.customerName})`).join(', ')}`);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Draw — ${scheme.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || prize.trim().length < 2 || (notEnded && !early)} onClick={() => void draw()}><Dice5 /> Draw now</button></>}>
      <div className="col">
        <Banner kind="info">Winners are picked at random by the computer from {scheme.eligibleCouponCount - scheme.winnerCount} eligible coupon(s). Every coupon has an equal chance. Results are final, cannot be edited, and are recorded in the audit log. Draw in front of witnesses if possible.</Banner>
        {error && <Banner kind="danger">{error}</Banner>}
        <div className="grid g2">
          <Field label="Prize"><input className="input" value={prize} onChange={(e) => setPrize(e.target.value)} autoFocus placeholder="e.g. First prize: 25 kg rice" /></Field>
          <Field label="Number of winners"><input className="input num" type="number" min={1} max={50} value={count} onChange={(e) => setCount(e.target.value)} /></Field>
        </div>
        {notEnded && <label className="check"><input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} /> The scheme runs until {scheme.endsOn}. Draw early anyway (customers buying later will miss this draw).</label>}
      </div>
    </Modal>
  );
}

// ---------------- customers ----------------
function Customers() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useAsync(() => api('customers.list', { q: q || undefined, page, pageSize: 25 }), [q, page]);
  return (
    <div className="card">
      <div className="card-head">
        <div className="search" style={{ width: 300 }}><Search /><input className="input" placeholder="Name or phone" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} /></div>
        <span className="small muted">Only customers who agreed at the counter are stored. Administrators only.</span>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? <Empty title="No customers recorded" icon={<Users />} /> : (
        <>
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th><th className="num">Purchases</th><th className="num">Total spent</th><th className="num">Coupons</th><th>Last purchase</th><th>Consent</th></tr></thead>
            <tbody>
              {list.data.rows.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name} {c.isDemo && <DemoBadge />}</td>
                  <td className="mono">{c.phone}</td>
                  <td className="num">{c.saleCount}</td>
                  <td className="num">{npr(c.totalSpentPaisa)}</td>
                  <td className="num">{c.couponCount}</td>
                  <td className="small">{c.lastPurchaseAt ? dateTime(c.lastPurchaseAt) : '—'}</td>
                  <td className="small">{c.consentAt ? dateTime(c.consentAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

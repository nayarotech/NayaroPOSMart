import type { Product, SaleDetail, SaleQuote, ScannerStatus } from '@srmart/shared';
import { paisaToRupeesInput, parseRupees } from '@srmart/shared';
import { Banknote, CheckCircle2, Gift, Minus, Percent, Plus, Printer, ScanBarcode, Search, ShoppingCart, Smartphone, Tag, Trash2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, errMsg } from '../api';
import { ApprovalDialog, Banner, Empty, Field, Modal, MoneyInput, useToast } from '../components/ui';
import { PhoneScannerModal } from '../components/PhoneScanner';
import { npr } from '../lib/format';
import { useSession } from '../session';

interface Line {
  productId: number;
  name: string;
  sku: string;
  unit: string;
  unitPricePaisa: number;
  quantity: number;
  discountPaisa: number;
  qtyAvailable: number;
}

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1250 : 220;
    g.gain.value = 0.06;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.06 : 0.25));
    o.onended = () => void ctx.close();
  } catch {
    /* audio is optional */
  }
}

const newTxnId = () => crypto.randomUUID();

export function Pos() {
  const { settings, user } = useSession();
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>([]);
  const [orderDiscountPaisa, setOrderDiscount] = useState(0);
  const [quote, setQuote] = useState<SaleQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [hi, setHi] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [lineEdit, setLineEdit] = useState<(Line & { promo: number }) | null>(null);
  const [done, setDone] = useState<SaleDetail | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phones, setPhones] = useState(0);
  const txnId = useRef(newTxnId());
  const lastScan = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const scanRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceMs = settings?.pos.scanDebounceMs ?? 350;
  const usbEnabled = settings?.scanner?.usbEnabled ?? true;
  const phoneEnabled = settings?.scanner?.phoneEnabled ?? false;
  const modalOpen = payOpen || discountOpen || !!lineEdit || !!done || phoneOpen;

  const focusScan = useCallback(() => {
    setTimeout(() => scanRef.current?.focus(), 0);
  }, []);
  useEffect(() => focusScan(), [focusScan]);

  // Authoritative totals from the main process whenever the cart changes.
  useEffect(() => {
    if (!lines.length) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api('sales.quote', { lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, discountPaisa: l.discountPaisa })), orderDiscountPaisa })
        .then((q) => live && (setQuote(q), setQuoteError(null)))
        .catch((e) => live && (setQuote(null), setQuoteError(errMsg(e))));
    }, 80);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [lines, orderDiscountPaisa]);

  const addProduct = useCallback((p: Product, qty = 1) => {
    setLines((cur) => {
      const i = cur.findIndex((l) => l.productId === p.id);
      if (i >= 0) {
        const next = [...cur];
        // Price always refreshed from the latest lookup (database), never kept from an older scan.
        next[i] = { ...next[i]!, quantity: next[i]!.quantity + qty, unitPricePaisa: p.pricePaisa, qtyAvailable: p.qtyOnHand };
        return next;
      }
      return [...cur, { productId: p.id, name: p.name, sku: p.sku, unit: p.unit, unitPricePaisa: p.pricePaisa, quantity: qty, discountPaisa: 0, qtyAvailable: p.qtyOnHand }];
    });
    setFlashId(p.id);
    setTimeout(() => setFlashId(null), 600);
  }, []);

  async function handleScan(raw: string, source: 'usb' | 'phone' = 'usb') {
    const code = raw.trim();
    if (source === 'usb') setScan('');
    if (!code) return;
    const now = Date.now();
    // Scanner double-reads: ignore an identical code arriving within the debounce window.
    if (code === lastScan.current.code && now - lastScan.current.at < debounceMs) {
      setScanMsg({ ok: true, text: `Duplicate read of ${code} ignored (within ${debounceMs} ms)` });
      return;
    }
    lastScan.current = { code, at: now };
    try {
      const p = await api('products.lookupBarcode', { code });
      if (!p) {
        beep(false);
        setScanMsg({ ok: false, text: `Unknown barcode "${code}". Search by name, or register the barcode under Products.` });
        return;
      }
      beep(true);
      addProduct(p);
      setScanMsg({ ok: true, text: `${source === 'phone' ? '📱 ' : ''}${p.name} — ${npr(p.pricePaisa)}` });
    } catch (e) {
      beep(false);
      setScanMsg({ ok: false, text: errMsg(e) });
    }
  }

  // Codes from a paired phone arrive through the preload bridge and go through the same scan path.
  const scanRefFn = useRef(handleScan);
  scanRefFn.current = handleScan;
  useEffect(() => {
    if (!phoneEnabled || !window.srmart?.onScannerCode) return;
    return window.srmart.onScannerCode((e) => void scanRefFn.current(e.code, 'phone'));
  }, [phoneEnabled]);
  useEffect(() => {
    if (!phoneEnabled) return;
    const load = () => void api('scanner.status').then((st: ScannerStatus) => setPhones(st.devices.length)).catch(() => undefined);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [phoneEnabled, phoneOpen]);

  useEffect(() => {
    if (!search.trim()) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api('products.search', { q: search, limit: 12 })
        .then((r) => live && (setResults(r), setHi(0)))
        .catch(() => live && setResults([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [search]);

  const pick = (p: Product) => {
    addProduct(p);
    setSearch('');
    setResults([]);
    focusScan();
  };

  const clearCart = () => {
    setLines([]);
    setOrderDiscount(0);
    txnId.current = newTxnId();
    setScanMsg(null);
    focusScan();
  };

  // Keyboard: F2 scan, F4 search, F8 discount, F9/F12 pay, Esc clears search.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (modalOpen) return;
      if (e.key === 'F2') (e.preventDefault(), scanRef.current?.focus());
      else if (e.key === 'F4') (e.preventDefault(), searchRef.current?.focus());
      else if (e.key === 'F8' && lines.length) (e.preventDefault(), setDiscountOpen(true));
      else if ((e.key === 'F9' || e.key === 'F12') && quote) (e.preventDefault(), setPayOpen(true));
      else if (e.key === 'Escape') (setSearch(''), focusScan());
      else {
        // Keystrokes typed while nothing is focused (e.g. a scanner after clicking the page) go to the scan box.
        const el = document.activeElement;
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
        if (usbEnabled && !typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) scanRef.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [modalOpen, lines.length, quote, focusScan, usbEnabled]);

  const setQty = (id: number, q: number) => setLines((cur) => cur.map((l) => (l.productId === id ? { ...l, quantity: Math.max(1, Math.min(10000, Math.floor(q) || 1)) } : l)));
  const remove = (id: number) => setLines((cur) => cur.filter((l) => l.productId !== id));
  const itemCount = useMemo(() => lines.reduce((a, l) => a + l.quantity, 0), [lines]);
  const quoteLine = (id: number) => quote?.lines.find((l) => l.productId === id);

  return (
    <div className="pos">
      <div className="pos-left">
        <div className="card scanbox">
          {usbEnabled ? (
          <div className="search grow">
            <ScanBarcode style={{ left: 14, width: 22, height: 22, color: 'var(--brand)' }} />
            <input
              ref={scanRef}
              className="input scan-input"
              placeholder="Scan barcode / type SKU + Enter"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Tab') {
                  if (e.key === 'Tab' && !scan) return;
                  e.preventDefault();
                  void handleScan(scan);
                }
              }}
              autoComplete="off"
              spellCheck={false}
              aria-label="Barcode scanner input"
            />
          </div>
          ) : (
            <div className="grow small muted" style={{ padding: '0 6px' }}>USB scanner input is turned off in Settings → Barcode scanners. Use search{phoneEnabled ? ' or the phone scanner' : ''}.</div>
          )}
          {phoneEnabled && (
            <button className="btn lg" onClick={() => setPhoneOpen(true)} title="Pair a phone as a barcode scanner">
              <Smartphone /> {phones > 0 ? <span className="badge green">{phones} phone</span> : 'Phone'}
            </button>
          )}
          <div className="search" style={{ width: 240 }}>
            <Search />
            <input
              ref={searchRef}
              className="input lg"
              placeholder="Search name / brand (F4)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, results.length - 1)));
                if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
                if (e.key === 'Enter' && results[hi]) pick(results[hi]!);
              }}
            />
            {results.length > 0 && (
              <div className="results">
                {results.map((p, i) => (
                  <div key={p.id} className={`result ${i === hi ? 'hi' : ''}`} onMouseDown={() => pick(p)}>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div className="small faint">{p.sku} · {p.brand ?? p.categoryName ?? ''} · stock {p.qtyOnHand}</div>
                    </div>
                    <b className="num">{npr(p.pricePaisa)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {scanMsg && (
          <div className={`scan-state ${scanMsg.ok ? '' : ''}`} style={{ color: scanMsg.ok ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
            {scanMsg.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {scanMsg.text}
          </div>
        )}

        <div className="card cart">
          <div className="card-head">
            <h2 className="row"><ShoppingCart size={18} /> Current sale</h2>
            <span className="muted small">{lines.length} lines · {itemCount} items</span>
          </div>
          {lines.length === 0 ? (
            <Empty title="Cart is empty" icon={<ScanBarcode />}>Scan a product barcode, or search by name with <kbd>F4</kbd>.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Item</th><th className="num">Price</th><th style={{ width: 150 }}>Qty</th><th className="num">Discount</th><th className="num">Amount</th><th /></tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const q = quoteLine(l.productId);
                    const over = l.quantity > l.qtyAvailable;
                    return (
                      <tr key={l.productId} className={flashId === l.productId ? 'flash' : ''}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{l.name}</div>
                          <div className="sub">{l.sku} · {over ? <span style={{ color: 'var(--danger)' }}>only {l.qtyAvailable} in stock</span> : `${l.qtyAvailable} in stock`}</div>
                          {q?.promoDiscountPaisa ? <span className="badge green" style={{ marginTop: 3 }}><Tag size={11} /> {q.promotionName} −{npr(q.promoDiscountPaisa)}</span> : null}
                        </td>
                        <td className="num">{npr(q?.unitPricePaisa ?? l.unitPricePaisa)}</td>
                        <td>
                          <div className="qty">
                            <button onClick={() => setQty(l.productId, l.quantity - 1)} aria-label="Decrease"><Minus size={14} /></button>
                            <input value={l.quantity} inputMode="numeric" onChange={(e) => setQty(l.productId, Number(e.target.value.replace(/\D/g, '')))} onKeyDown={(e) => e.key === 'Enter' && focusScan()} />
                            <button onClick={() => setQty(l.productId, l.quantity + 1)} aria-label="Increase"><Plus size={14} /></button>
                          </div>
                        </td>
                        <td className="num">
                          <button className="btn ghost sm" onClick={() => setLineEdit({ ...l, promo: q?.promoDiscountPaisa ?? 0 })}>{l.discountPaisa ? `-${npr(l.discountPaisa)}` : <span className="faint">add</span>}</button>
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>{npr(q?.lineTotalPaisa ?? l.unitPricePaisa * l.quantity - l.discountPaisa)}</td>
                        <td className="right"><button className="btn ghost sm icon" onClick={() => remove(l.productId)} title="Remove"><Trash2 /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="keys">
          <span><kbd>F2</kbd> Scan</span><span><kbd>F4</kbd> Search</span><span><kbd>F8</kbd> Order discount</span><span><kbd>F9</kbd> Pay</span><span><kbd>Esc</kbd> Back to scanner</span>
        </div>
      </div>

      <div className="pos-right">
        <div className="card totals">
          <div className="line"><span>Subtotal</span><span>{npr(quote?.subtotalPaisa ?? 0)}</span></div>
          {quote?.promoDiscountPaisa ? <div className="line" style={{ color: 'var(--ok)' }}><span><Tag size={13} /> Festival offers</span><span>-{npr(quote.promoDiscountPaisa)}</span></div> : null}
          <div className="line"><span>Line discounts</span><span>-{npr(quote?.lineDiscountPaisa ?? 0)}</span></div>
          <div className="line">
            <span>Order discount <button className="btn ghost sm" disabled={!lines.length} onClick={() => setDiscountOpen(true)}><Percent size={14} /> edit</button></span>
            <span>-{npr(quote?.orderDiscountPaisa ?? orderDiscountPaisa)}</span>
          </div>
          {quote?.tax.enabled ? (
            <div className="line"><span>{quote.tax.label} {quote.tax.rateBp / 100}%{quote.tax.inclusive ? ' (incl.)' : ''}</span><span>{npr(quote.taxPaisa)}</span></div>
          ) : (
            <div className="line faint small"><span>Tax</span><span>not configured</span></div>
          )}
          <div className="grand"><span className="muted">Total</span><span className="v">{npr(quote?.totalPaisa ?? 0)}</span></div>
          {quote?.discountRequiresApproval && <Banner kind="warn">Discount exceeds the cashier limit ({(settings?.pos.cashierMaxDiscountBp ?? 0) / 100}%). Admin approval will be requested.</Banner>}
          {quoteError && <Banner kind="danger">{quoteError}</Banner>}
          {quote?.qualifyingSchemes.map((sch) => (
            <Banner key={sch.id} kind="ok"><Gift size={14} /> Qualifies for <b>{sch.name}</b>: {sch.coupons} coupon{sch.coupons > 1 ? 's' : ''}. Ask for the customer's name and phone at payment.</Banner>
          ))}
          {quote?.nearSchemes.map((sch) => (
            <Banner key={sch.id} kind="info"><Gift size={14} /> Add <b>{npr(sch.shortByPaisa)}</b> more to enter <b>{sch.name}</b> (min {npr(sch.minBillPaisa)}).</Banner>
          ))}
          {quote?.warnings.map((w) => <Banner key={w} kind="warn">{w}</Banner>)}
        </div>
        <button className="btn primary xl" disabled={!quote} onClick={() => setPayOpen(true)}>
          <Banknote size={22} /> Pay {quote ? npr(quote.totalPaisa) : ''} <kbd style={{ marginLeft: 6 }}>F9</kbd>
        </button>
        <button className="btn" disabled={!lines.length} onClick={() => confirm('Clear the current sale?') && clearCart()}>Clear sale</button>
        <div className="card card-pad small muted">
          Cashier: <b>{user?.fullName}</b>. Prices come from the local database at the moment of sale. Works offline.
        </div>
      </div>

      {lineEdit && (
        <LineDiscountModal
          line={lineEdit}
          onClose={() => (setLineEdit(null), focusScan())}
          onSave={(d) => {
            setLines((cur) => cur.map((l) => (l.productId === lineEdit.productId ? { ...l, discountPaisa: d } : l)));
            setLineEdit(null);
            focusScan();
          }}
        />
      )}
      {discountOpen && (
        <OrderDiscountModal
          current={orderDiscountPaisa}
          due={(quote?.subtotalPaisa ?? 0) - (quote?.promoDiscountPaisa ?? 0) - (quote?.lineDiscountPaisa ?? 0)}
          onClose={() => (setDiscountOpen(false), focusScan())}
          onSave={(d) => (setOrderDiscount(d), setDiscountOpen(false), focusScan())}
        />
      )}
      {payOpen && quote && (
        <PaymentModal
          quote={quote}
          lines={lines}
          orderDiscountPaisa={orderDiscountPaisa}
          txnId={txnId.current}
          onClose={() => (setPayOpen(false), focusScan())}
          onDone={(sale) => {
            setPayOpen(false);
            setDone(sale);
            setLines([]);
            setOrderDiscount(0);
            txnId.current = newTxnId();
            setScanMsg(null);
            toast.ok(`Sale ${sale.receiptNo} completed`);
          }}
          onQuoteStale={() => setLines((l) => [...l])}
        />
      )}
      {done && <ReceiptModal sale={done} onClose={() => (setDone(null), focusScan())} />}
      {phoneOpen && <PhoneScannerModal onClose={() => (setPhoneOpen(false), focusScan())} />}
    </div>
  );
}

function LineDiscountModal({ line, onClose, onSave }: { line: Line & { promo: number }; onClose: () => void; onSave: (d: number) => void }) {
  const [v, setV] = useState(line.discountPaisa ? paisaToRupeesInput(line.discountPaisa) : '');
  const paisa = v ? parseRupees(v) : 0;
  const max = line.unitPricePaisa * line.quantity - line.promo;
  const bad = paisa === null || paisa > max;
  return (
    <Modal title={`Discount — ${line.name}`} onClose={onClose} footer={<><button className="btn" onClick={() => onSave(0)}>Remove discount</button><button className="btn primary" disabled={bad} onClick={() => onSave(paisa ?? 0)}>Apply</button></>}>
      <Field label="Discount amount (Rs.)" hint={`Line amount ${npr(max)}. Discounts are recorded in the audit log.`} error={bad ? 'Invalid or larger than the line amount' : null}>
        <MoneyInput value={v} onChange={setV} autoFocus invalid={bad} onEnter={() => !bad && onSave(paisa ?? 0)} />
      </Field>
    </Modal>
  );
}

function OrderDiscountModal({ current, due, onClose, onSave }: { current: number; due: number; onClose: () => void; onSave: (d: number) => void }) {
  const [mode, setMode] = useState<'amount' | 'percent'>('amount');
  const [v, setV] = useState(current ? paisaToRupeesInput(current) : '');
  const paisa = mode === 'amount' ? (v ? parseRupees(v) : 0) : Math.round((due * (Number(v) || 0)) / 100);
  const bad = paisa === null || paisa > due || (mode === 'percent' && Number(v) > 100);
  return (
    <Modal title="Order discount" onClose={onClose} footer={<><button className="btn" onClick={() => onSave(0)}>Remove</button><button className="btn primary" disabled={bad} onClick={() => onSave(paisa ?? 0)}>Apply</button></>}>
      <div className="col">
        <div className="seg">
          <button className={mode === 'amount' ? 'on' : ''} onClick={() => setMode('amount')}>Amount (Rs.)</button>
          <button className={mode === 'percent' ? 'on' : ''} onClick={() => setMode('percent')}>Percent</button>
        </div>
        <Field label={mode === 'amount' ? 'Discount (Rs.)' : 'Discount (%)'} hint={`Amount due before order discount: ${npr(due)}${paisa ? ` · discount = ${npr(paisa)}` : ''}`}>
          <MoneyInput value={v} onChange={setV} autoFocus invalid={bad} onEnter={() => !bad && onSave(paisa ?? 0)} />
        </Field>
      </div>
    </Modal>
  );
}

function PaymentModal({ quote, lines, orderDiscountPaisa, txnId, onClose, onDone, onQuoteStale }: {
  quote: SaleQuote; lines: Line[]; orderDiscountPaisa: number; txnId: string; onClose: () => void; onDone: (s: SaleDetail) => void; onQuoteStale: () => void;
}) {
  const { settings } = useSession();
  const methods = settings?.paymentMethods.filter((m) => m.enabled) ?? [{ code: 'cash', label: 'Cash', enabled: true, requiresReference: false }];
  const [method, setMethod] = useState(methods[0]!.code);
  const [tendered, setTendered] = useState(paisaToRupeesInput(quote.totalPaisa));
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState(false);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const qualifies = quote.qualifyingSchemes.length > 0;
  const custStarted = !!(custName.trim() || custPhone.trim());
  const custValid = !custStarted || (custName.trim().length >= 2 && /^\+?\d{7,15}$/.test(custPhone.replace(/[\s-]/g, '')) && consent);
  const m = methods.find((x) => x.code === method)!;
  const isCash = method === 'cash';
  const tPaisa = isCash ? parseRupees(tendered || '0') : quote.totalPaisa;
  const change = tPaisa !== null ? tPaisa - quote.totalPaisa : -1;
  const canPay = !busy && tPaisa !== null && change >= 0 && (!m.requiresReference || reference.trim().length > 0) && custValid;
  const quick = useMemo(() => {
    const t = quote.totalPaisa;
    const set = new Set<number>([t, Math.ceil(t / 10000) * 10000, Math.ceil(t / 50000) * 50000, Math.ceil(t / 100000) * 100000, 500000, 100000 * 10]);
    return [...set].filter((x) => x >= t).sort((a, b) => a - b).slice(0, 4);
  }, [quote.totalPaisa]);

  async function pay(override?: { username: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      const sale = await api('sales.complete', {
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, discountPaisa: l.discountPaisa })),
        orderDiscountPaisa,
        clientTxnId: txnId,
        expectedTotalPaisa: quote.totalPaisa,
        payment: { method, tenderedPaisa: tPaisa ?? 0, reference: reference || null },
        override: override ?? null,
        customer: custStarted ? { name: custName.trim(), phone: custPhone, consent: consent as true } : null,
      });
      onDone(sale);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setApproval(true);
      else {
        if (e instanceof ApiError && e.code === 'PRICE_CHANGED') onQuoteStale();
        setError(errMsg(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal title="Take payment" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Back to cart</button><button className="btn primary lg" disabled={!canPay} onClick={() => void pay()}>{busy ? 'Saving…' : `Complete sale (Enter)`}</button></>}>
        <div className="col gap-lg">
          <div className="row between"><span className="muted">Amount due</span><span style={{ fontSize: 30, fontWeight: 800 }}>{npr(quote.totalPaisa)}</span></div>
          {methods.length > 1 && (
            <div className="seg">
              {methods.map((x) => <button key={x.code} className={x.code === method ? 'on' : ''} onClick={() => setMethod(x.code)}>{x.label}</button>)}
            </div>
          )}
          {isCash ? (
            <>
              <Field label="Cash tendered (Rs.)">
                <input className="input lg num" style={{ fontSize: 22, height: 54 }} autoFocus value={tendered} inputMode="decimal" onFocus={(e) => e.target.select()} onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && canPay && void pay()} />
              </Field>
              <div className="tender-grid">
                {quick.map((q) => <button key={q} className="btn" onClick={() => setTendered(paisaToRupeesInput(q))}>{q === quote.totalPaisa ? 'Exact' : npr(q)}</button>)}
              </div>
              <div className="change-box"><span className="muted">Change due</span><span className="v">{change >= 0 ? npr(change) : '—'}</span></div>
            </>
          ) : (
            <>
              <Banner kind="info">{m.label}: confirm the payment on the external terminal/app first. This POS only records it — no card or wallet data is stored or processed.</Banner>
              <Field label="Reference / transaction ID"><input className="input" autoFocus value={reference} onChange={(e) => setReference(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canPay && void pay()} /></Field>
            </>
          )}
          {qualifies && (
            <div className="card card-pad col" style={{ boxShadow: 'none', borderColor: '#bde5cd', background: 'var(--ok-50)' }}>
              <div className="row"><Gift size={18} color="var(--ok)" /><b>Lucky draw: {quote.qualifyingSchemes.map((x) => `${x.name} (${x.coupons} coupon${x.coupons > 1 ? 's' : ''})`).join(', ')}</b></div>
              <div className="small muted">Optional. Leave empty if the customer does not want to take part.</div>
              <div className="grid g2">
                <Field label="Customer phone">
                  <input className="input" inputMode="tel" value={custPhone} onChange={(e) => setCustPhone(e.target.value)} onBlur={() => custPhone.trim() && !custName && void api('customers.lookup', { phone: custPhone }).then((c) => c && setCustName(c.name)).catch(() => undefined)} placeholder="98XXXXXXXX" />
                </Field>
                <Field label="Customer name"><input className="input" value={custName} onChange={(e) => setCustName(e.target.value)} /></Field>
              </div>
              <label className="check small"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Customer agrees that Nayaro Mart stores their name and phone for this lucky draw and may contact them if they win</label>
              {custStarted && !custValid && <div className="small" style={{ color: 'var(--danger)' }}>Enter a name, a valid phone (7–15 digits) and tick the customer's agreement — or clear both fields.</div>}
            </div>
          )}
          {error && <Banner kind="danger">{error}</Banner>}
        </div>
      </Modal>
      {approval && <ApprovalDialog purpose="This discount" onCancel={() => setApproval(false)} onApprove={(cred) => (setApproval(false), void pay(cred))} />}
    </>
  );
}

export function ReceiptModal({ sale, onClose, reprint }: { sale: SaleDetail; onClose: () => void; reprint?: boolean }) {
  const { settings } = useSession();
  const toast = useToast();
  const [html, setHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoPrinted = useRef(false);
  useEffect(() => {
    api('receipts.render', { saleId: sale.id }).then((r) => setHtml(r.html)).catch((e) => toast.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.id]);

  const print = useCallback(async (mode: 'dialog' | 'pdf' | 'silent') => {
    setBusy(true);
    try {
      const r = await api('receipts.print', { saleId: sale.id, mode });
      r.ok ? toast.ok(r.message) : toast.info(r.message);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }, [sale.id, toast]);

  useEffect(() => {
    if (!reprint && settings?.printers.autoPrintReceipt && !autoPrinted.current) {
      autoPrinted.current = true;
      void print(settings.printers.silentReceipt && settings.printers.receiptPrinter ? 'silent' : 'dialog');
    }
  }, [reprint, settings, print]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Enter' && !reprint && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, reprint]);

  const pay = sale.payments.find((p) => p.kind === 'payment');
  return (
    <Modal title={reprint ? `Receipt ${sale.receiptNo}` : 'Sale complete'} onClose={onClose} size="wide" footer={
      <>
        <button className="btn" disabled={busy} onClick={() => void print('pdf')}>Save PDF</button>
        {settings?.printers.receiptPrinter && <button className="btn" disabled={busy} onClick={() => void print('silent')}>Quick print → {settings.printers.receiptPrinter}</button>}
        <button className="btn" disabled={busy} onClick={() => void print('dialog')}><Printer /> Print…</button>
        {!reprint && <button className="btn primary" onClick={onClose}>New sale (Enter)</button>}
      </>
    }>
      <div className="grid g2" style={{ gridTemplateColumns: '1fr 340px' }}>
        <div className="col">
          {!reprint && pay && (
            <div className="change-box" style={{ flexDirection: 'column', gap: 4 }}>
              <span className="muted">Change to give</span>
              <span className="v" style={{ fontSize: 40 }}>{npr(pay.changePaisa ?? 0)}</span>
              <span className="small muted">Paid {npr(pay.tenderedPaisa ?? pay.amountPaisa)} by {pay.method} · total {npr(sale.totalPaisa)}</span>
            </div>
          )}
          <dl className="kv">
            <dt>Receipt no.</dt><dd className="mono">{sale.receiptNo}</dd>
            <dt>Fiscal year</dt><dd>{sale.fiscalYear}</dd>
            <dt>Date</dt><dd>{sale.businessDate} · {sale.bsDate} BS</dd>
            <dt>Items</dt><dd>{sale.itemCount}</dd>
            {sale.promoDiscountPaisa > 0 && (<><dt>Festival offers</dt><dd>−{npr(sale.promoDiscountPaisa)}</dd></>)}
          </dl>
          {sale.coupons.length > 0 && (
            <Banner kind="ok"><b>{sale.coupons.length} lucky-draw coupon{sale.coupons.length > 1 ? 's' : ''}</b> for {sale.customer?.name}: <span className="mono">{sale.coupons.map((c) => c.couponNo).join(', ')}</span> — printed on the receipt.</Banner>
          )}
          <Banner kind="info">Printing goes through the operating system's printer driver. Test your 80 mm printer on site; "Save PDF" always works as a fallback.</Banner>
        </div>
        {html ? <iframe key={html.length} className="preview" title="Receipt preview" sandbox="" srcDoc={html} style={{ height: 520 }} /> : <div className="spinner" />}
      </div>
    </Modal>
  );
}

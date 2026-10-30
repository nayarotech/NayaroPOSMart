import type { MobileSummary, Page, SaleDetail, SaleSummary, FiscalYearRow, SalesTotals } from '@srmart/shared';
import { formatNPR, toLocalISODate } from '@srmart/shared';
import { AlertTriangle, CalendarRange, ChevronLeft, Home, LogOut, Package, ReceiptText, RefreshCw, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const npr = (p: number) => formatNPR(p);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const TOKEN_KEY = 'srmart-admin-token';

function store(key: string, value?: string | null) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode) */
  }
  return null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, (body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

type Tab = 'home' | 'sales' | 'stock' | 'fy';

export function App() {
  const [token, setToken] = useState<string | null>(() => store(TOKEN_KEY));
  if (!token) return <Login onToken={(t) => (store(TOKEN_KEY, t), setToken(t))} />;
  return <Dashboard token={token} onLogout={() => {
    void fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    store(TOKEN_KEY, null);
    setToken(null);
  }} />;
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? 'Sign-in failed');
      onToken(body.token);
    } catch (err) {
      setError(err instanceof TypeError ? 'Cannot reach the shop computer. Are you on the shop network / VPN, and is the mobile server enabled?' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <div className="logo"><img src="./nayaro-mark.svg" alt="" /></div>
      <h1>Nayaro POS Admin</h1>
      <p className="muted">Read-only owner dashboard · Powered by Nayaro Tech</p>
      <form onSubmit={submit} className="stack">
        {error && <div className="alert danger">{error}</div>}
        <input className="input" placeholder="Admin username" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoComplete="username" />
        <input className="input" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <button className="btn primary" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="tiny muted">Administrator accounts only. Data comes live from the shop computer; nothing can be changed from this app.</p>
    </div>
  );
}

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  const [summary, setSummary] = useState<MobileSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saleId, setSaleId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await get<MobileSummary>('/api/summary', token));
      setError(null);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return onLogout();
      setError(e instanceof TypeError ? 'Offline — cannot reach the shop computer. Showing the last loaded figures.' : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, onLogout]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (saleId) return <SaleView id={saleId} token={token} onBack={() => setSaleId(null)} />;

  return (
    <div className="app">
      <header className="top">
        <img className="top-mark" src="./nayaro-mark.svg" alt="" />
        <div className="grow">
          <div className="store">{summary?.storeName ?? 'Nayaro Mart'}</div>
          {summary && (
            <div className="fy">
              <span className="dot" /> FY {summary.fiscal.code} running · day {summary.fiscal.dayNumber}/{summary.fiscal.totalDays}
            </div>
          )}
        </div>
        <div className="row">
          <button className="icon" onClick={() => void load()} aria-label="Refresh"><RefreshCw size={18} className={loading ? 'spin' : ''} /></button>
          <button className="icon" onClick={onLogout} aria-label="Sign out"><LogOut size={18} /></button>
        </div>
      </header>
      <main className="body">
        {error && <div className="alert warn"><WifiOff size={16} /> {error}</div>}
        {summary?.dataMode === 'demo' && <div className="alert demo">DEMO DATA — figures are fictional sample data</div>}
        {!summary ? <div className="center muted">{error ? '' : 'Loading…'}</div> : (
          <>
            {tab === 'home' && <HomeTab s={summary} onSale={setSaleId} />}
            {tab === 'sales' && <SalesTab token={token} onSale={setSaleId} />}
            {tab === 'stock' && <StockTab s={summary} />}
            {tab === 'fy' && <FyTab s={summary} token={token} />}
            <p className="tiny muted center">Updated {time(summary.generatedAt)} · {summary.fiscal.todayBsLong} BS</p>
          </>
        )}
      </main>
      <nav className="tabs">
        {([['home', Home, 'Today'], ['sales', ReceiptText, 'Sales'], ['stock', Package, 'Stock'], ['fy', CalendarRange, 'Fiscal year']] as const).map(([k, Icon, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={20} /><span>{label}</span></button>
        ))}
      </nav>
    </div>
  );
}

function Totals({ t, title }: { t: SalesTotals; title: string }) {
  return (
    <div className="card">
      <div className="label">{title}</div>
      <div className="big">{npr(t.netSalesPaisa)}</div>
      <p className="tiny muted">After returns and void reversals on their activity date · excludes tax</p>
      <div className="grid2">
        <div><div className="label">Transactions</div><b>{t.salesCount}</b></div>
        <div><div className="label">Discounts</div><b>{npr(t.discountPaisa)}</b></div>
        <div><div className="label">Refunds</div><b>{npr(t.refundsPaisa)}</b></div>
        <div><div className="label">Est. gross margin*</div><b>{npr(t.estimatedMarginPaisa)}</b></div>
      </div>
    </div>
  );
}

function HomeTab({ s, onSale }: { s: MobileSummary; onSale: (id: number) => void }) {
  const max = Math.max(1, ...s.last7Days.map((d) => Math.abs(d.netSalesPaisa)));
  return (
    <>
      <Totals t={s.today} title="Today's net sales" />
      <div className="card">
        <div className="label">Last 7 days</div>
        <div className="bars">
          {s.last7Days.map((d) => (
            <div key={d.date} className="barcol">
              <div className="bar" title={`${d.date}: ${npr(d.netSalesPaisa)}`} style={{ height: `${Math.max(2, (Math.abs(d.netSalesPaisa) / max) * 100)}%`, ...(d.netSalesPaisa < 0 ? { background: '#c62828' } : {}) }} />
              <span>{d.netSalesPaisa < 0 ? '− ' : ''}{d.date.slice(8)}</span>
            </div>
          ))}
        </div>
      </div>
      {s.lowStock.length > 0 && <div className="alert warn"><AlertTriangle size={16} /> {s.lowStock.length} products at or below minimum stock</div>}
      <div className="card">
        <div className="label">Recent receipts</div>
        <SaleList rows={s.recent} onSale={onSale} />
      </div>
      <p className="tiny muted">*Estimated from recorded cost prices. Not profit.</p>
    </>
  );
}

function SaleList({ rows, onSale }: { rows: SaleSummary[]; onSale: (id: number) => void }) {
  if (!rows.length) return <div className="muted">No sales.</div>;
  return (
    <div className="list">
      {rows.map((r) => (
        <button key={r.id} className="item" onClick={() => onSale(r.id)}>
          <div>
            <div className="mono">{r.receiptNo}</div>
            <div className="tiny muted">{r.businessDate} {time(r.createdAt)} · {r.cashierName}{r.status !== 'completed' ? ` · ${r.status.replace('_', ' ')}` : ''}</div>
          </div>
          <b className={r.status === 'voided' ? 'strike' : ''}>{npr(r.totalPaisa)}</b>
        </button>
      ))}
    </div>
  );
}

function SalesTab({ token, onSale }: { token: string; onSale: (id: number) => void }) {
  const [date, setDate] = useState(toLocalISODate(new Date()));
  const [data, setData] = useState<Page<SaleSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    get<Page<SaleSummary>>(`/api/sales?date=${date}`, token).then(setData).catch((e) => setError((e as Error).message));
  }, [date, token]);
  const total = data?.rows.filter((r) => r.status !== 'voided').reduce((a, r) => a + r.totalPaisa, 0) ?? 0;
  return (
    <div className="card">
      <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      {error && <div className="alert danger">{error}</div>}
      {data && <div className="row between" style={{ margin: '10px 0' }}><span className="muted">{data.total} receipts</span><b>{npr(total)}</b></div>}
      {data ? <SaleList rows={data.rows} onSale={onSale} /> : <div className="muted">Loading…</div>}
    </div>
  );
}

function StockTab({ s }: { s: MobileSummary }) {
  return (
    <div className="card">
      <div className="label">Low stock ({s.lowStock.length})</div>
      {s.lowStock.length === 0 ? <div className="muted">Nothing below minimum.</div> : (
        <div className="list">
          {s.lowStock.map((p) => (
            <div key={p.id} className="item">
              <div><div>{p.name}</div><div className="tiny muted">{p.sku} · min {p.minStock}</div></div>
              <span className={`pill ${p.qtyOnHand <= 0 ? 'red' : 'amber'}`}>{p.qtyOnHand} {p.unit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FyTab({ s, token }: { s: MobileSummary; token: string }) {
  const [fys, setFys] = useState<FiscalYearRow[] | null>(null);
  useEffect(() => {
    get<FiscalYearRow[]>('/api/fiscal-years', token).then(setFys).catch(() => setFys([]));
  }, [token]);
  const f = s.fiscal;
  return (
    <>
      <div className="card">
        <div className="label">Running fiscal year</div>
        <div className="big">FY {f.code}</div>
        <div className="muted tiny">{f.startDate} → {f.endDate} · BS {f.bsStart} → {f.bsEnd}</div>
        <div className="meter"><span style={{ width: `${f.percent}%` }} /></div>
        <div className="row between tiny"><span>Day {f.dayNumber} of {f.totalDays}</span><span>{f.daysLeft} days left</span></div>
      </div>
      <Totals t={s.fiscalYearToDate} title={`FY ${f.code} to date — net sales`} />
      <div className="card">
        <div className="label">All fiscal years</div>
        <div className="list">
          {fys?.map((x) => (
            <div key={x.code} className="item"><div><b>FY {x.code}</b>{x.isCurrent && <span className="pill green" style={{ marginLeft: 6 }}>running</span>}<div className="tiny muted">{x.startDate} → {x.endDate}</div></div><span className="muted">{x.saleCount} sales</span></div>
          ))}
        </div>
      </div>
    </>
  );
}

function SaleView({ id, token, onBack }: { id: number; token: string; onBack: () => void }) {
  const [s, setS] = useState<SaleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<SaleDetail>(`/api/sales/${id}`, token).then(setS).catch((e) => setError((e as Error).message));
  }, [id, token]);
  return (
    <div className="app">
      <header className="top"><button className="icon" onClick={onBack}><ChevronLeft /></button><div className="store mono">{s?.receiptNo ?? 'Receipt'}</div><span /></header>
      <main className="body">
        {error && <div className="alert danger">{error}</div>}
        {!s ? <div className="muted center">Loading…</div> : (
          <div className="card">
            <div className="row between"><span className="muted">{s.businessDate} {time(s.createdAt)} · {s.bsDate} BS</span><span className="pill">{s.status.replace('_', ' ')}</span></div>
            <div className="tiny muted">FY {s.fiscalYear} · cashier {s.cashierName}</div>
            <div className="list" style={{ marginTop: 10 }}>
              {s.items.map((i) => (
                <div key={i.id} className="item"><div><div>{i.name}</div><div className="tiny muted">{i.quantity} × {npr(i.unitPricePaisa)}{i.discountPaisa ? ` · −${npr(i.discountPaisa)}` : ''}{i.returnedQuantity ? ` · ${i.returnedQuantity} returned` : ''}</div></div><b>{npr(i.lineTotalPaisa)}</b></div>
              ))}
            </div>
            <div className="row between" style={{ marginTop: 10 }}><span>Total</span><span className="big" style={{ margin: 0 }}>{npr(s.totalPaisa)}</span></div>
            {s.voidReason && <div className="alert danger">Voided: {s.voidReason}</div>}
            {s.returns.map((r) => <div key={r.id} className="alert warn">Return {r.returnNo}: {npr(r.refundPaisa)} — {r.reason}</div>)}
          </div>
        )}
      </main>
    </div>
  );
}

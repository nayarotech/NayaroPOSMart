import { AlertTriangle, CalendarRange, Receipt, Tags, TrendingUp, Wallet } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Bars } from '../components/Bars';
import { Banner, DemoBadge, Empty, ErrorState, Loading, StockBadge, useAsync } from '../components/ui';
import { npr, pct, STATUS_LABEL, timeOnly } from '../lib/format';

export function Dashboard() {
  const { data, error, loading, reload } = useAsync(() => api('dashboard.summary'), []);
  const nav = useNavigate();
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorState error={error ?? 'No data'} onRetry={reload} />;
  const t = data.today;
  const fy = data.fiscal;
  const f = data.fiscalYearToDate;
  return (
    <div className="col gap-lg">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>{fy.todayBsLong} BS · {fy.todayAd} · Fiscal year {fy.code}</p>
        </div>
        <div className="row">
          <button className="btn" onClick={reload}>Refresh</button>
          <button className="btn primary" onClick={() => nav('/pos')}>Open checkout</button>
        </div>
      </div>

      {data.dataMode === 'demo' && (
        <Banner kind="warn">
          <b>Demo mode.</b> All figures below come from clearly-labelled fictional demo data ({t.demoSalesCount} demo sales today, {t.realSalesCount} real).
          When Nayaro Mart is ready, use <Link to="/settings">Settings → Data</Link> to remove demo data and start live operation.
        </Banner>
      )}

      <div className="card card-pad">
        <div className="row between wrap">
          <div className="row gap-lg">
            <CalendarRange size={28} color="var(--brand)" />
            <div>
              <div className="small muted">Running fiscal year</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>FY {fy.code}</div>
              <div className="small faint">{fy.startDate} → {fy.endDate} · BS {fy.bsStart} → {fy.bsEnd}</div>
            </div>
          </div>
          <div style={{ minWidth: 320 }}>
            <div className="row between small"><span>Day {fy.dayNumber} of {fy.totalDays}</span><span className="muted">{fy.daysLeft} days left</span></div>
            <div className="meter mt" style={{ marginTop: 6 }}><span style={{ width: `${fy.percent}%` }} /></div>
          </div>
          <div className="row gap-lg">
            <div><div className="small muted">FY net sales</div><div style={{ fontWeight: 750, fontSize: 18 }}>{npr(f.netSalesPaisa)}</div></div>
            <div><div className="small muted">FY transactions</div><div style={{ fontWeight: 750, fontSize: 18 }}>{f.salesCount}</div></div>
            <div><div className="small muted">FY est. gross margin</div><div style={{ fontWeight: 750, fontSize: 18 }}>{npr(f.estimatedMarginPaisa)}</div></div>
          </div>
        </div>
      </div>

      <div className="grid g4">
        <div className="card stat">
          <div className="stat-label"><Wallet size={15} /> Today's net sales {data.dataMode === 'demo' && <DemoBadge />}</div>
          <div className="stat-value">{npr(t.netSalesPaisa)}</div>
          <div className="stat-sub">After returns and void reversals · excludes tax</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><Receipt size={15} /> Transactions today</div>
          <div className="stat-value">{t.salesCount}</div>
          <div className="stat-sub">Sales made today · refunds may relate to earlier sales</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><TrendingUp size={15} /> Estimated gross margin</div>
          <div className="stat-value">{npr(t.estimatedMarginPaisa)}</div>
          <div className="stat-sub">{pct(t.estimatedMarginBp)} of net · estimate from recorded cost prices, not profit</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><AlertTriangle size={15} /> Attention</div>
          <div className="stat-value">{data.lowStockCount}</div>
          <div className="stat-sub">
            low-stock products · {data.expiringSoonCount} batches expiring ≤30 days · {data.outdatedLabelCount} outdated labels
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h2>Last 7 days</h2><span className="small muted">Net sales per day</span></div>
          <div className="card-body">
            <Bars data={data.last7Days.map((d) => ({ label: d.date.slice(5), value: d.netSalesPaisa, sub: `${d.salesCount} sales` }))} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Low stock</h2>
            <Link to="/inventory" className="small">View all</Link>
          </div>
          {data.lowStock.length === 0 ? <Empty title="All stocked up" /> : (
            <table className="table">
              <tbody>
                {data.lowStock.map((p) => (
                  <tr key={p.id}>
                    <td><div style={{ fontWeight: 600 }}>{p.name}</div><div className="sub">{p.sku} · min {p.minStock}</div></td>
                    <td className="right"><StockBadge qty={p.qtyOnHand} min={p.minStock} unit={p.unit} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {data.outdatedLabelCount > 0 && (
        <Banner kind="warn"><Tags size={14} /> {data.outdatedLabelCount} product(s) changed price after their labels were printed. <Link to="/labels?outdated=1">Reprint labels</Link></Banner>
      )}

      <div className="card">
        <div className="card-head"><h2>Recent transactions</h2><Link to="/sales" className="small">All sales</Link></div>
        {data.recent.length === 0 ? <Empty title="No sales yet" /> : (
          <table className="table">
            <thead><tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>FY</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {data.recent.map((s) => (
                <tr key={s.id} className="click" onClick={() => nav(`/sales?id=${s.id}`)}>
                  <td className="mono">{s.receiptNo} {s.isDemo && <DemoBadge />}</td>
                  <td>{s.businessDate} {timeOnly(s.createdAt)}</td>
                  <td>{s.cashierName}</td>
                  <td>{s.fiscalYear}</td>
                  <td><span className={`badge ${s.status === 'completed' ? 'green' : s.status === 'voided' ? 'red' : 'amber'}`}>{STATUS_LABEL[s.status]}</span></td>
                  <td className="num" style={{ fontWeight: 650 }}>{npr(s.totalPaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import type { SalesTotals } from '@srmart/shared';
import { fiscalYearFromBsYear, toBsDate, toLocalISODate } from '@srmart/shared';
import { Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { Bars } from '../components/Bars';
import { Banner, Empty, ErrorState, Loading, Seg, useAsync } from '../components/ui';
import { dateTime, npr, pct } from '../lib/format';
import { useSession } from '../session';

type Preset = 'today' | '7d' | 'month' | 'fy' | 'prevfy' | 'custom';

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function Reports() {
  const { info } = useSession();
  const today = new Date();
  const [preset, setPreset] = useState<Preset>('fy');
  const [custom, setCustom] = useState({ from: toLocalISODate(addDays(today, -30)), to: toLocalISODate(today) });
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('month');
  const range = useMemo(() => {
    const t = toLocalISODate(today);
    const fy = info?.fiscal;
    switch (preset) {
      case 'today': return { from: t, to: t };
      case '7d': return { from: toLocalISODate(addDays(today, -6)), to: t };
      case 'month': return { from: toLocalISODate(addDays(today, -(toBsDate(today).day - 1))), to: t };
      case 'fy': return { from: fy?.startDate ?? t, to: t };
      case 'prevfy': {
        const p = fiscalYearFromBsYear((fy?.bsStartYear ?? toBsDate(today).year) - 1);
        return { from: p.startDate, to: p.endDate };
      }
      default: return custom;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, custom, info]);

  const sales = useAsync(() => api('reports.sales', { ...range, groupBy }), [range.from, range.to, groupBy]);
  const stock = useAsync(() => api('reports.stockValuation'), []);
  const purchases = useAsync(() => api('reports.purchases', range), [range.from, range.to]);
  const returns = useAsync(() => api('reports.returns', range), [range.from, range.to]);
  const fys = useAsync(() => api('reports.fiscalYears'), []);
  const r = sales.data;

  return (
    <div className="col gap-lg">
      <div className="page-head">
        <div><h1>Reports</h1><p>{range.from} → {range.to} · grouped by {groupBy === 'month' ? 'Nepali (BS) month' : groupBy}</p></div>
      </div>
      <div className="card card-pad row wrap between">
        <Seg<Preset> value={preset} onChange={setPreset} options={[
          { value: 'today', label: 'Today' }, { value: '7d', label: 'Last 7 days' }, { value: 'month', label: 'This BS month' },
          { value: 'fy', label: `FY ${info?.fiscal.code ?? ''} (running)` }, { value: 'prevfy', label: 'Previous FY' }, { value: 'custom', label: 'Custom' },
        ]} />
        {preset === 'custom' && (
          <div className="row">
            <input className="input" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input className="input" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </div>
        )}
        <Seg value={groupBy} onChange={setGroupBy} options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly (BS)' }]} />
      </div>

      <Banner kind="info"><b>How to read these numbers:</b> Net sales exclude tax and include returns and void reversals on the day they happen. Refunds include tax. Transaction counts show sales made in the period. “Estimated gross margin” = net sales − recorded cost of goods; only restocked returns reverse cost. It is an estimate, <b>not profit</b> (it ignores rent, wages, wastage and other costs). Accuracy depends on cost prices being kept up to date.</Banner>

      {sales.error ? <ErrorState error={sales.error} onRetry={sales.reload} /> : !r ? <Loading /> : (
        <>
          <Totals t={r.totals} />
          <div className="card">
            <div className="card-head"><h2>Net sales by {groupBy === 'month' ? 'BS month' : groupBy}</h2></div>
            <div className="card-body">
              {r.buckets.length === 0 ? <Empty title="No sales in this period" /> : <Bars data={r.buckets.map((b) => ({ label: groupBy === 'day' ? b.key.slice(5) : b.label.replace('Week of ', ''), value: b.netSalesPaisa, sub: `${b.salesCount} sales` }))} />}
            </div>
            {r.buckets.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 340 }}>
                <table className="table">
                  <thead><tr><th>Period</th><th className="num">Sales</th><th className="num">Gross</th><th className="num">Discounts</th><th className="num">Tax</th><th className="num">Net</th><th className="num">Refunds</th><th className="num">Est. margin</th></tr></thead>
                  <tbody>
                    {r.buckets.map((b) => (
                      <tr key={b.key}><td>{b.label}</td><td className="num">{b.salesCount}</td><td className="num">{npr(b.grossSalesPaisa)}</td><td className="num">{npr(b.discountPaisa)}</td><td className="num">{npr(b.taxPaisa)}</td><td className="num" style={{ fontWeight: 650 }}>{npr(b.netSalesPaisa)}</td><td className="num">{npr(b.refundsPaisa)}</td><td className="num">{npr(b.estimatedMarginPaisa)} <span className="faint">({pct(b.estimatedMarginBp)})</span></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="grid g4">
            <div className="card">
              <div className="card-head"><h2>Payment totals</h2></div>
              {r.payments.length === 0 ? <Empty title="No payments" /> : (
                <table className="table"><tbody>
                  {r.payments.map((p) => <tr key={p.method + p.kind}><td><span className={`badge ${p.kind === 'payment' ? 'green' : 'red'}`}>{p.kind}</span> {p.method}</td><td className="num">{p.count}</td><td className="num">{p.kind === 'refund' ? '-' : ''}{npr(p.amountPaisa)}</td></tr>)}
                </tbody></table>
              )}
            </div>
            <div className="card">
              <div className="card-head"><h2>Top products</h2></div>
              {r.topProducts.length === 0 ? <Empty title="No sales" /> : (
                <table className="table"><tbody>
                  {r.topProducts.map((p) => <tr key={p.productId}><td className="small">{p.name}<div className="sub">{p.quantity} sold</div></td><td className="num">{npr(p.netPaisa)}</td></tr>)}
                </tbody></table>
              )}
            </div>
            <div className="card">
              <div className="card-head"><h2>Festival offers</h2></div>
              {r.promotions.length === 0 ? <Empty title="No offers applied" /> : (
                <table className="table"><tbody>
                  {r.promotions.map((p) => <tr key={p.name}><td className="small">{p.name}<div className="sub">{p.lines} lines</div></td><td className="num">−{npr(p.discountPaisa)}</td></tr>)}
                </tbody></table>
              )}
            </div>
            <div className="card">
              <div className="card-head"><h2>By category</h2></div>
              {r.byCategory.length === 0 ? <Empty title="No sales" /> : (
                <table className="table"><tbody>
                  {r.byCategory.map((c) => <tr key={c.category}><td>{c.category}<div className="sub">{c.quantity} units</div></td><td className="num">{npr(c.netPaisa)}</td></tr>)}
                </tbody></table>
              )}
            </div>
          </div>
        </>
      )}

      <div className="grid g3">
        <div className="card">
          <div className="card-head"><h2>Stock valuation (now)</h2></div>
          {!stock.data ? <Loading /> : (
            <div className="card-body col">
              <dl className="kv"><dt>Products in stock</dt><dd>{stock.data.products}</dd><dt>Units</dt><dd>{stock.data.units}</dd><dt>At cost</dt><dd><b>{npr(stock.data.costValuePaisa)}</b></dd><dt>At selling price</dt><dd>{npr(stock.data.retailValuePaisa)}</dd></dl>
              <table className="table"><tbody>{stock.data.byCategory.map((c) => <tr key={c.category}><td className="small">{c.category}</td><td className="num small">{npr(c.costValuePaisa)}</td></tr>)}</tbody></table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h2>Purchases</h2></div>
          {!purchases.data ? <Loading /> : (
            <div className="card-body col">
              <dl className="kv"><dt>Invoices</dt><dd>{purchases.data.count}</dd><dt>Total cost</dt><dd><b>{npr(purchases.data.totalPaisa)}</b></dd></dl>
              <table className="table"><tbody>{purchases.data.bySupplier.map((s) => <tr key={s.supplier}><td className="small">{s.supplier}</td><td className="num small">{npr(s.totalPaisa)}</td></tr>)}</tbody></table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h2>Returns & voids</h2></div>
          {!returns.data ? <Loading /> : (
            <div className="card-body col">
              <dl className="kv"><dt>Returns</dt><dd>{returns.data.count} · {npr(returns.data.refundPaisa)}</dd><dt>Voids</dt><dd>{returns.data.voidCount} · {npr(returns.data.voidPaisa)}</dd></dl>
              <table className="table"><tbody>{returns.data.rows.slice(0, 8).map((x) => <tr key={x.returnNo}><td className="small"><span className="mono">{x.returnNo}</span><div className="sub">{dateTime(x.createdAt)} · {x.reason}</div></td><td className="num small">{npr(x.refundPaisa)}</td></tr>)}</tbody></table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Fiscal years</h2><span className="small muted row"><Info size={14} /> Nepal fiscal year: 1 Shrawan – end of Ashadh (BS). Each sale is permanently tagged with its fiscal year.</span></div>
        {!fys.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Fiscal year</th><th>Start (AD)</th><th>End (AD)</th><th className="num">Sales recorded</th><th /></tr></thead>
            <tbody>{fys.data.map((f) => <tr key={f.code}><td><b>FY {f.code}</b></td><td>{f.startDate}</td><td>{f.endDate}</td><td className="num">{f.saleCount}</td><td>{f.isCurrent && <span className="badge green">running</span>}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Totals({ t }: { t: SalesTotals }) {
  const items: [string, string, string?][] = [
    ['Net sales', npr(t.netSalesPaisa), `${t.salesCount} transactions`],
    ['Gross (before discount)', npr(t.grossSalesPaisa)],
    ['Discounts', npr(t.discountPaisa)],
    ['Tax collected', npr(t.taxPaisa), t.taxPaisa ? undefined : 'tax not configured'],
    ['Refunds', npr(t.refundsPaisa)],
    ['Cost of goods (recorded)', npr(t.costOfGoodsPaisa)],
    ['Est. gross margin', npr(t.estimatedMarginPaisa), `${pct(t.estimatedMarginBp)} — estimate, not profit`],
  ];
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
      {items.map(([l, v, s]) => (
        <div key={l} className="card stat"><div className="stat-label">{l}</div><div className="stat-value" style={{ fontSize: 18 }}>{v}</div>{s && <div className="stat-sub">{s}</div>}</div>
      ))}
    </div>
  );
}


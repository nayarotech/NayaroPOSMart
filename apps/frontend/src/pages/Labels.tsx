import type { LabelSize, Product } from '@srmart/shared';
import { FileDown, Minus, Plus, Printer, Search, Tags, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Banner, Empty, Field, Loading, Seg, useAsync, useToast } from '../components/ui';
import { npr } from '../lib/format';
import { useSession } from '../session';

type Template = 'sticker' | 'shelf';

export function Labels() {
  const { settings, isAdmin, refreshSettings } = useSession();
  const toast = useToast();
  const [params] = useSearchParams();
  const [template, setTemplate] = useState<Template>('sticker');
  const [q, setQ] = useState('');
  const [onlyOutdated, setOnlyOutdated] = useState(params.get('outdated') === '1');
  const [selected, setSelected] = useState<Map<number, { product: Product; copies: number }>>(new Map());
  const [html, setHtml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState<LabelSize | null>(null);

  const list = useAsync(() => api('products.list', { q: q || undefined, pageSize: 100 }), [q]);
  const rows = useMemo(() => (list.data?.rows ?? []).filter((p) => !onlyOutdated || p.labelOutdated), [list.data, onlyOutdated]);

  // Preselect products passed in from the product editor (?products=1,2)
  useEffect(() => {
    const ids = params.get('products')?.split(',').map(Number).filter(Boolean) ?? [];
    if (!ids.length) return;
    void Promise.all(ids.map((id) => api('products.get', { id }))).then((ps) => setSelected(new Map(ps.map((p) => [p.id, { product: p, copies: 1 }]))));
  }, [params]);

  useEffect(() => {
    if (settings) setSize(settings.labels[template]);
  }, [settings, template]);

  const items = useMemo(() => [...selected.values()].map((s) => ({ productId: s.product.id, copies: s.copies })), [selected]);

  useEffect(() => {
    if (!items.length) {
      setHtml(null);
      setWarnings([]);
      setCount(0);
      return;
    }
    let live = true;
    api('labels.render', { template, items })
      .then((r) => live && (setHtml(r.html), setWarnings(r.warnings), setCount(r.labelCount)))
      .catch((e) => toast.error(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, template, settings]);

  const toggle = (p: Product) =>
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(p.id)) next.delete(p.id);
      else next.set(p.id, { product: p, copies: 1 });
      return next;
    });
  const setCopies = (id: number, c: number) =>
    setSelected((cur) => {
      const next = new Map(cur);
      const e = next.get(id);
      if (e) next.set(id, { ...e, copies: Math.max(1, Math.min(500, c)) });
      return next;
    });

  async function print(mode: 'dialog' | 'pdf' | 'silent') {
    setBusy(true);
    try {
      const r = await api('labels.print', { template, items, mode });
      if (r.ok) {
        toast.ok(r.message);
        list.reload();
      } else toast.info(r.message);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveSize() {
    if (!settings || !size) return;
    try {
      await api('settings.update', { ...settings, labels: { ...settings.labels, [template]: size } });
      await refreshSettings();
      toast.ok('Label size saved');
    } catch (e) {
      toast.error(e);
    }
  }

  const sizeField = (k: keyof LabelSize, label: string) => (
    <Field label={label}>
      <input className="input num" type="number" step="0.5" value={size?.[k] ?? 0} disabled={!isAdmin} onChange={(e) => size && setSize({ ...size, [k]: Number(e.target.value) })} />
    </Field>
  );

  return (
    <div className="col gap-lg">
      <div className="page-head">
        <div><h1>Label studio</h1><p>Print product price stickers and shelf labels. Prices come from the database at print time.</p></div>
        <Seg<Template> value={template} onChange={setTemplate} options={[{ value: 'sticker', label: 'Product sticker' }, { value: 'shelf', label: 'Shelf label' }]} />
      </div>
      <Banner kind="warn">
        Labels show the price at the moment of printing. After any price change, reprint the label (products are flagged “label outdated”).
        Label printer output, sizes and scan quality must be tested physically — use “Save PDF” if a printer is not set up.
      </Banner>
      <div className="grid" style={{ gridTemplateColumns: '360px 1fr', alignItems: 'start' }}>
        <div className="col">
          <div className="card">
            <div className="card-head"><h2>Choose products</h2><span className="small muted">{selected.size} selected</span></div>
            <div className="card-body col">
              <div className="search"><Search /><input className="input" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <div className="row between">
                <label className="check small"><input type="checkbox" checked={onlyOutdated} onChange={(e) => setOnlyOutdated(e.target.checked)} /> Only outdated labels</label>
                <button className="btn ghost sm" onClick={() => setSelected(new Map(rows.map((p) => [p.id, { product: p, copies: selected.get(p.id)?.copies ?? 1 }])))}>Select all shown</button>
              </div>
            </div>
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              {!list.data ? <Loading /> : rows.length === 0 ? <Empty title="No products" /> : (
                <table className="table">
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className={`click ${selected.has(p.id) ? 'sel' : ''}`} onClick={() => toggle(p)}>
                        <td style={{ width: 28 }}><input type="checkbox" readOnly checked={selected.has(p.id)} /></td>
                        <td><div style={{ fontWeight: 600 }}>{p.name}</div><div className="sub">{p.sku}{p.labelOutdated ? ' · label outdated' : ''}</div></td>
                        <td className="num">{npr(p.pricePaisa)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          {selected.size > 0 && (
            <div className="card">
              <div className="card-head"><h2>Copies</h2><button className="btn ghost sm" onClick={() => setSelected(new Map())}>Clear</button></div>
              <table className="table">
                <tbody>
                  {[...selected.values()].map(({ product, copies }) => (
                    <tr key={product.id}>
                      <td className="small">{product.name}</td>
                      <td className="right nowrap">
                        <div className="qty">
                          <button onClick={() => setCopies(product.id, copies - 1)}><Minus size={13} /></button>
                          <input value={copies} onChange={(e) => setCopies(product.id, Number(e.target.value.replace(/\D/g, '')) || 1)} />
                          <button onClick={() => setCopies(product.id, copies + 1)}><Plus size={13} /></button>
                        </div>
                        <button className="btn ghost sm icon" onClick={() => toggle(product)}><Trash2 /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h2>{template === 'sticker' ? 'Sticker' : 'Shelf label'} size (mm)</h2>{isAdmin && <button className="btn sm" onClick={() => void saveSize()}>Save size</button>}</div>
            <div className="card-body grid g3">
              {sizeField('widthMm', 'Width')}
              {sizeField('heightMm', 'Height')}
              {sizeField('marginMm', 'Margin')}
              {sizeField('columns', 'Columns')}
              {sizeField('gapMm', 'Gap')}
              {sizeField('pageWidthMm', 'Page width')}
            </div>
            <div className="card-body small muted" style={{ paddingTop: 0 }}>1 column = roll/label printer (one label per page). 2+ columns = sheet (e.g. A4 width 210 mm).</div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2 className="row"><Tags size={18} /> Preview {count ? <span className="badge gray">{count} labels</span> : null}</h2>
            <div className="row">
              <button className="btn" disabled={!count || busy} onClick={() => void print('pdf')}><FileDown /> Save PDF</button>
              {settings?.printers.labelPrinter && <button className="btn" disabled={!count || busy} onClick={() => void print('silent')}>Quick print → {settings.printers.labelPrinter}</button>}
              <button className="btn primary" disabled={!count || busy} onClick={() => void print('dialog')}><Printer /> Print…</button>
            </div>
          </div>
          <div className="card-body col">
            {warnings.map((w) => <Banner key={w} kind="warn">{w}</Banner>)}
            {html ? <iframe key={html.length + template + count} className="preview" title="Label preview" sandbox="" srcDoc={html} style={{ height: 620 }} /> : <Empty title="Select products to preview labels" icon={<Tags />}>Each label includes the product name, NPR price, SKU and a scannable barcode.</Empty>}
          </div>
        </div>
      </div>
    </div>
  );
}

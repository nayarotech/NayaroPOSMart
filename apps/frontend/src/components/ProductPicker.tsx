import type { Product } from '@srmart/shared';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { npr } from '../lib/format';

/** Search-or-scan product picker. Enter with an exact barcode/SKU picks immediately. */
export function ProductPicker({ onPick, placeholder = 'Scan barcode or search product…', autoFocus }: { onPick: (p: Product) => void; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Product[]>([]);
  const [hi, setHi] = useState(0);
  useEffect(() => {
    if (!q.trim()) return setRows([]);
    let live = true;
    const t = setTimeout(() => void api('products.search', { q, limit: 10 }).then((r) => live && (setRows(r), setHi(0))).catch(() => undefined), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const pick = (p: Product) => {
    onPick(p);
    setQ('');
    setRows([]);
  };
  return (
    <div className="search" style={{ position: 'relative' }}>
      <Search />
      <input
        className="input"
        placeholder={placeholder}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, rows.length - 1));
          if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
          if (e.key === 'Enter') {
            e.preventDefault();
            const exact = await api('products.lookupBarcode', { code: q }).catch(() => null);
            if (exact) pick(exact);
            else if (rows[hi]) pick(rows[hi]!);
          }
        }}
      />
      {rows.length > 0 && (
        <div className="results">
          {rows.map((p, i) => (
            <div key={p.id} className={`result ${i === hi ? 'hi' : ''}`} onMouseDown={() => pick(p)}>
              <div className="grow"><div style={{ fontWeight: 600 }}>{p.name}</div><div className="small faint">{p.sku} · stock {p.qtyOnHand} · cost {npr(p.costPaisa)}</div></div>
              <b className="num">{npr(p.pricePaisa)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

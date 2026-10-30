import { npr } from '../lib/format';

export function Bars({ data }: { data: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="bars" aria-label="Bar heights show magnitude; red bars with minus signs represent negative values.">
      {data.map((d) => (
        <div key={d.label} className="bar-col">
          <div className="bar" style={{ height: `${Math.max(1.5, (Math.abs(d.value) / max) * 100)}%`, ...(d.value < 0 ? { background: 'var(--danger)' } : {}) }} data-tip={`${d.label}: ${npr(d.value)}${d.sub ? ` · ${d.sub}` : ''}`} />
          <div className="bar-label">{d.value < 0 ? '− ' : ''}{d.label}</div>
        </div>
      ))}
    </div>
  );
}

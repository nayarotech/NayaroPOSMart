import { npr } from '../lib/format';

export function Bars({ data }: { data: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bars">
      {data.map((d) => (
        <div key={d.label} className="bar-col">
          <div className="bar" style={{ height: `${Math.max(1.5, (d.value / max) * 100)}%` }} data-tip={`${d.label}: ${npr(d.value)}${d.sub ? ` · ${d.sub}` : ''}`} />
          <div className="bar-label">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

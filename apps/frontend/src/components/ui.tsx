import { AlertTriangle, CheckCircle2, Info, PackageOpen, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, errMsg } from '../api';

// ---------------- toasts ----------------
type Toast = { id: number; kind: 'ok' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok' ? <CheckCircle2 /> : t.kind === 'error' ? <XCircle /> : <Info />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    ok: (t: string) => push('ok', t),
    info: (t: string) => push('info', t),
    error: (e: unknown) => push('error', errMsg(e)),
  };
}

// ---------------- data loading ----------------
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => my === seq.current && (setData(d), setError(null)))
      .catch((e) => my === seq.current && setError(errMsg(e)))
      .finally(() => my === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run, setData };
}

// ---------------- primitives ----------------
export function Modal({ title, onClose, children, footer, size }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'wide' | 'xwide' }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label>{label}</label>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'warn' | 'info' | 'danger' | 'ok'; children: ReactNode }) {
  const Icon = kind === 'ok' ? CheckCircle2 : kind === 'info' ? Info : AlertTriangle;
  return (
    <div className={`banner ${kind}`}>
      <Icon />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <PackageOpen />}
      <b>{title}</b>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="loading">
      <div className="spinner" /> {text}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="card-pad">
      <Banner kind="danger">
        <div className="row between">
          <span>{error}</span>
          {onRetry && (
            <button className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </Banner>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="pager">
      <span>
        {from}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="row gap-sm">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="small">
          Page {page} / {pages}
        </span>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rupee input that keeps a string while typing and reports paisa. */
export function MoneyInput({ value, onChange, autoFocus, invalid, onEnter, id }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; invalid?: boolean; onEnter?: () => void; id?: string }) {
  return (
    <input
      id={id}
      className={`input num ${invalid ? 'invalid' : ''}`}
      inputMode="decimal"
      value={value}
      autoFocus={autoFocus}
      placeholder="0.00"
      onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
      onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      onFocus={(e) => e.target.select()}
    />
  );
}

export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.fields ? e.fields : {};
}

/** Administrator approval prompt for restricted cashier actions (discount, void, refund). */
export function ApprovalDialog({ purpose, onApprove, onCancel }: { purpose: string; onApprove: (cred: { username: string; password: string }) => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Modal
      title="Administrator approval required"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!username || !password} onClick={() => onApprove({ username, password })}>
            Approve
          </button>
        </>
      }
    >
      <div className="col">
        <Banner kind="info">{purpose} needs an administrator to approve. The approval is recorded in the audit log.</Banner>
        <Field label="Admin username">
          <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Admin password">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && username && password && onApprove({ username, password })} />
        </Field>
      </div>
    </Modal>
  );
}

export function ConfirmText({ title, body, phrase, onConfirm, onCancel, busy, danger = true }: { title: string; body: ReactNode; phrase: string; onConfirm: (password: string) => void; onCancel: () => void; busy?: boolean; danger?: boolean }) {
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={typed !== phrase || !password || busy} onClick={() => onConfirm(password)}>
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </>
      }
    >
      <div className="col">
        {body}
        <Field label={<>Type <span className="mono">{phrase}</span> to confirm</>}>
          <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
        <Field label="Your password">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function StockBadge({ qty, min, unit }: { qty: number; min: number; unit?: string }) {
  if (qty <= 0) return <span className="badge red">Out · {qty}</span>;
  if (qty <= min) return <span className="badge amber">Low · {qty}</span>;
  return (
    <span className="badge gray">
      {qty} {unit}
    </span>
  );
}

export const DemoBadge = () => <span className="badge demo">DEMO</span>;

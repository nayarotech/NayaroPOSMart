import type { CashShift } from '@srmart/shared';
import { parseRupees } from '@srmart/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../api';
import { Banner, Empty, ErrorState, Field, Loading, Modal, MoneyInput, useAsync, useToast } from '../components/ui';
import { dateTime, npr } from '../lib/format';
import { useSession } from '../session';

export function Shifts() {
  const { user } = useSession();
  const toast = useToast();
  const data = useAsync(async () => {
    const [current, history] = await Promise.all([api('shifts.current'), api('shifts.list')]);
    return { current, history };
  }, []);
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState<'open' | 'in' | 'out' | 'close' | null>(null);
  useEffect(() => { const timer = setInterval(data.reload, 30_000); return () => clearInterval(timer); }, [data.reload]);
  const current = data.data?.current;
  const shift = selected ? data.data?.history.find((s) => s.id === selected) : current ?? data.data?.history[0];
  const canManage = shift && !shift.closedAt && (user?.role === 'admin' || user?.id === shift.openedBy);
  const print = async (mode: 'dialog' | 'pdf') => {
    if (!shift) return;
    try { const result = await api('shifts.print', { id: shift.id, mode }); result.ok ? toast.ok(result.message) : toast.info(result.message); }
    catch (e) { toast.error(e); }
  };
  return <div className="col gap-lg">
    <div className="page-head"><div><h1>Cash shifts & closing</h1><p>One shared till · close and count the drawer before cashier handover.</p></div><div className="row"><button className="btn" onClick={data.reload}>Refresh</button><Link className="btn" to="/pos">Checkout</Link>{!current && data.data && <button className="btn primary" onClick={() => setForm('open')}>Open shift</button>}</div></div>
    <Banner kind="info">Expected cash = opening float + cash sales − cash refunds + cash in − cash out. Card and wallet payments are listed separately. Transactions made without an open shift are excluded. Later refunds belong to the shift open when the refund is made.</Banner>
    {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.data ? <Loading /> : <>
      {current && <Banner kind="ok">Shift #{current.id} open · {current.openedByName} · since {dateTime(current.openedAt)} <button className="btn sm" onClick={() => setSelected(null)}>View current</button></Banner>}
      {!current && <Banner kind="warn">No shift is open. Open a shift before taking payments to include them in cash reconciliation.</Banner>}
      {shift ? <div className="card">
        <div className="card-head"><h2>Shift #{shift.id} · {shift.closedAt ? 'Closed' : 'Open'}</h2><div className="row"><button className="btn" onClick={() => void print('dialog')}>Print report</button><button className="btn" onClick={() => void print('pdf')}>Save PDF</button></div></div>
        <div className="card-body col gap-lg">
          <div className="muted">Opened by {shift.openedByName} · {dateTime(shift.openedAt)}{shift.closedAt && <> · Closed by {shift.closedByName} · {dateTime(shift.closedAt)}</>}</div>
          <div className="grid g4">{[['Opening float', shift.openingPaisa], ['Expected cash', shift.expectedPaisa], ['Counted cash', shift.countedPaisa], ['Variance', shift.variancePaisa]].map(([label, amount]) => <div className="stat" key={String(label)}><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 24 }}>{amount === null ? '—' : npr(amount as number)}</div></div>)}</div>
          {canManage && <div className="row"><button className="btn" onClick={() => setForm('in')}>Cash in</button><button className="btn" onClick={() => setForm('out')}>Cash out</button><button className="btn primary" onClick={() => setForm('close')}>Count & close shift</button></div>}
          {!shift.closedAt && !canManage && <Banner kind="info">The shift owner or an administrator can record cash movements and close this shift.</Banner>}
          <div className="grid g2"><div><h3>Payments</h3><table className="table"><thead><tr><th>Method</th><th className="num">Received</th><th className="num">Refunded</th></tr></thead><tbody>{shift.payments.map((p) => <tr key={p.method}><td>{p.method}</td><td className="num">{npr(p.receivedPaisa)}</td><td className="num">{npr(p.refundedPaisa)}</td></tr>)}</tbody></table></div>
          <div><h3>Cash movements</h3>{shift.movements.length ? <table className="table"><tbody>{shift.movements.map((m) => <tr key={m.id}><td>{m.kind === 'in' ? 'In' : 'Out'} · {m.reason}<div className="sub">{m.userName} · {dateTime(m.createdAt)}</div></td><td className="num">{m.kind === 'out' ? '−' : '+'}{npr(m.amountPaisa)}</td></tr>)}</tbody></table> : <p className="muted">No cash movements.</p>}</div></div>
          {shift.closingNote && <p>Closing note: {shift.closingNote}</p>}
        </div>
      </div> : <Empty title="Open a shift to start tracking the till" />}
      <div className="card"><div className="card-head"><h2>Recent shifts</h2><span className="small muted">Latest 50 · {user?.role === 'admin' ? 'all cashiers' : 'your shifts'}</span></div><table className="table"><thead><tr><th>Shift</th><th>Opened by</th><th>Opened</th><th>Status</th><th className="num">Expected</th><th className="num">Variance</th></tr></thead><tbody>{data.data.history.map((s) => <tr key={s.id} className="click" onClick={() => setSelected(s.id)}><td>#{s.id}</td><td>{s.openedByName}</td><td>{dateTime(s.openedAt)}</td><td>{s.closedAt ? 'Closed' : 'Open'}</td><td className="num">{npr(s.expectedPaisa)}</td><td className="num">{s.variancePaisa === null ? '—' : npr(s.variancePaisa)}</td></tr>)}</tbody></table></div>
    </>}
    {form && <ShiftForm kind={form} shift={shift ?? null} onClose={() => setForm(null)} onSaved={() => { setForm(null); setSelected(null); data.reload(); }} />}
  </div>;
}

function ShiftForm({ kind, shift, onClose, onSaved }: { kind: 'open' | 'in' | 'out' | 'close'; shift: CashShift | null; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txnId] = useState(() => crypto.randomUUID());
  // Freeze the reviewed total while counting; the backend rejects a stale closing amount.
  const [reviewedExpected] = useState(shift?.expectedPaisa ?? 0);
  const [reviewedShiftId] = useState(shift?.id);
  const paisa = amount.trim() ? parseRupees(amount) : null;
  const difference = paisa === null ? null : paisa - reviewedExpected;
  const valid = paisa !== null && paisa >= 0 && ((kind === 'in' || kind === 'out') ? paisa > 0 && reason.trim().length >= 3 : kind === 'close' ? difference === 0 || reason.trim().length >= 3 : true);
  async function save() {
    if (!valid || paisa === null || busy) return;
    setBusy(true); setError(null);
    try {
      if (kind === 'open') await api('shifts.open', { openingPaisa: paisa });
      else if (kind === 'close') await api('shifts.close', { shiftId: reviewedShiftId!, countedPaisa: paisa, expectedPaisa: reviewedExpected, note: reason });
      else await api('shifts.move', { shiftId: reviewedShiftId!, clientTxnId: txnId, kind, amountPaisa: paisa, reason });
      onSaved();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return <Modal title={kind === 'open' ? 'Open cash shift' : kind === 'close' ? 'Count & close shift' : `Cash ${kind}`} onClose={() => !busy && onClose()} footer={<><button className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Saving…' : kind === 'close' ? 'Confirm closing' : 'Save'}</button></>}>
    <div className="col">{kind === 'close' && <Banner kind="info">Expected cash: <b>{npr(reviewedExpected)}</b>. Count the actual drawer, including the opening float.</Banner>}
      <Field label={kind === 'open' ? 'Opening float (Rs.)' : kind === 'close' ? 'Counted cash (Rs.)' : 'Amount (Rs.)'}><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
      {kind !== 'open' && <Field label={kind === 'close' ? 'Closing note (required for a variance)' : 'Reason'}><textarea className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      {kind === 'close' && difference !== null && <Banner kind={difference === 0 ? 'ok' : 'warn'}>Variance: {npr(difference)} {difference < 0 ? 'short' : difference > 0 ? 'over' : 'balanced'}</Banner>}
      {error && <Banner kind="danger">{error} {kind === 'close' && 'If totals changed, cancel, refresh, and count again.'}</Banner>}
    </div>
  </Modal>;
}

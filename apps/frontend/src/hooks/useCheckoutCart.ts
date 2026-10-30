import type { CartSaveInput, SavedCart } from '@srmart/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../api';

export type CheckoutLine = SavedCart['lines'][number];
type Draft = { id: string; lines: CheckoutLine[]; orderDiscountPaisa: number };
const empty = (): Draft => ({ id: crypto.randomUUID(), lines: [], orderDiscountPaisa: 0 });
// Shared across route mounts: a reopened checkout waits for saves from the previous screen.
let pending: Promise<unknown> = Promise.resolve();
let saveFailure: unknown = null;
export function queueCartTask<T>(task: () => Promise<T>): Promise<T> {
  const result = pending.then(task);
  pending = result.catch(() => undefined);
  return result;
}
export async function flushCartOperations() {
  await pending;
  if (saveFailure) throw new Error(`Save the current cart before signing out: ${errMsg(saveFailure)}`);
}
const payloadFor = (draft: Draft): Omit<CartSaveInput, 'revision'> => ({
  id: draft.id, lines: draft.lines.map(({ productId, quantity, discountPaisa }) => ({ productId, quantity, discountPaisa })), orderDiscountPaisa: draft.orderDiscountPaisa,
});

export function useCheckoutCart() {
  const [draft, setDraft] = useState<Draft>(empty);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState('');
  const revisions = useRef(new Map<string, number>());
  const latest = useRef(draft);
  latest.current = draft;
  const key = JSON.stringify(payloadFor(draft));
  const apply = useCallback((cart: SavedCart | null) => {
    const next = cart ? { id: cart.id, lines: cart.lines, orderDiscountPaisa: cart.orderDiscountPaisa } : empty();
    if (cart) revisions.current.set(cart.id, cart.revision);
    latest.current = next;
    setDraft(next); setSavedKey(JSON.stringify(payloadFor(next))); setError(null);
  }, []);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    queueCartTask(() => api('carts.current')).then((cart) => { if (live) { apply(cart); setReady(true); } }).catch((e) => live && setError(errMsg(e)));
    return () => { live = false; };
  }, [apply, loadAttempt]);

  const save = useCallback((snapshot: Draft) => {
    const payload = payloadFor(snapshot);
    const snapshotKey = JSON.stringify(payload);
    return queueCartTask(async () => {
      if (!payload.lines.length && !revisions.current.has(payload.id)) return;
      try {
        const saved = await api('carts.save', { ...payload, revision: revisions.current.get(payload.id) ?? 0 });
        revisions.current.set(saved.id, saved.revision);
        saveFailure = null;
      } catch (e) { saveFailure = e; throw e; }
    }).then(() => {
      if (JSON.stringify(payloadFor(latest.current)) === snapshotKey) { setSavedKey(snapshotKey); setError(null); }
    }).catch((e) => { setError(errMsg(e)); throw e; });
  }, []);
  useEffect(() => {
    if (ready) void save(draft).catch(() => undefined);
  }, [draft, ready, save]);

  const setLines = useCallback((update: CheckoutLine[] | ((prev: CheckoutLine[]) => CheckoutLine[])) => {
    setDraft((prev) => ({ ...prev, lines: typeof update === 'function' ? update(prev.lines) : update }));
  }, []);
  const setOrderDiscount = useCallback((amount: number) => setDraft((prev) => ({ ...prev, orderDiscountPaisa: amount })), []);
  const clear = async () => {
    await save(latest.current);
    const id = latest.current.id;
    await queueCartTask(async () => {
      const revision = revisions.current.get(id);
      if (revision) await api('carts.discard', { id, revision });
    });
    apply(null);
  };
  const park = async (name: string) => {
    await save(latest.current);
    const id = latest.current.id;
    await queueCartTask(() => api('carts.park', { id, revision: revisions.current.get(id)!, name }));
    apply(null);
  };
  const resume = async (cart: SavedCart) => {
    await save(latest.current);
    const saved = await queueCartTask(() => api('carts.resume', { id: cart.id, revision: cart.revision }));
    apply(saved);
  };
  return { ...draft, ready, error, saved: ready && savedKey === key && !error, setLines, setOrderDiscount,
    clear, park, resume, completed: () => apply(null), retry: () => ready ? void save(latest.current).catch(() => undefined) : setLoadAttempt((n) => n + 1),
    flush: () => save(latest.current),
  };
}

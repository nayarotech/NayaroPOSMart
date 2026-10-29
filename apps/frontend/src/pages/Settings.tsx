import type { AppSettings } from '@srmart/shared';
import { Save, Smartphone } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../api';
import { Banner, ConfirmText, Field, Loading, useAsync, useToast } from '../components/ui';
import { useSession } from '../session';

type Tab = 'store' | 'receipt' | 'payments' | 'tax' | 'printers' | 'pos' | 'scanners' | 'fiscal' | 'mobile' | 'data';
const TABS: [Tab, string][] = [
  ['store', 'Store profile'], ['receipt', 'Receipt'], ['payments', 'Payment methods'], ['tax', 'Tax & compliance'], ['printers', 'Printers'],
  ['pos', 'Checkout rules'], ['scanners', 'Barcode scanners'], ['fiscal', 'Fiscal year'], ['mobile', 'Mobile admin app'], ['data', 'Demo / live data'],
];

function Section({ title, children, desc }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><div><h2>{title}</h2>{desc && <div className="small muted" style={{ marginTop: 3 }}>{desc}</div>}</div></div>
      <div className="card-body col">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const { refreshSettings, refreshInfo } = useSession();
  const toast = useToast();
  const loaded = useAsync(() => api('settings.get'), []);
  const [s, setS] = useState<AppSettings | null>(null);
  const [tab, setTab] = useState<Tab>('store');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (loaded.data) setS(structuredClone(loaded.data));
  }, [loaded.data]);
  if (!s) return <Loading />;
  const dirty = JSON.stringify(s) !== JSON.stringify(loaded.data);
  const up = <K extends keyof AppSettings>(k: K, v: Partial<AppSettings[K]>) => setS({ ...s, [k]: { ...(s[k] as object), ...v } } as AppSettings);

  async function save() {
    if (!s) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api('settings.update', s);
      loaded.setData(saved);
      setS(structuredClone(saved));
      await refreshSettings();
      await refreshInfo();
      toast.ok('Settings saved');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>Settings</h1><p>Store profile, receipts, payments, tax configuration, printers and data.</p></div>
        <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}><Save /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
      </div>
      {error && <div className="mb"><Banner kind="danger">{error}</Banner></div>}
      <div className="grid" style={{ gridTemplateColumns: '210px 1fr', alignItems: 'start' }}>
        <div className="card" style={{ padding: 6 }}>
          {TABS.map(([t, l]) => (
            <button key={t} className={`btn ghost ${tab === t ? 'primary' : ''}`} style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 2, ...(tab === t ? { background: 'var(--brand-50)', color: 'var(--brand-600)', borderColor: 'transparent' } : {}) }} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
        <div className="col">
          {tab === 'store' && (
            <Section title="Store profile" desc="Shown on receipts and the app header. Enter Nayaro Mart's real details — nothing here is pre-filled with real business data.">
              <div className="grid g2">
                <Field label="Store name"><input className="input" value={s.store.name} onChange={(e) => up('store', { name: e.target.value })} /></Field>
                <Field label="Tagline"><input className="input" value={s.store.tagline} onChange={(e) => up('store', { tagline: e.target.value })} /></Field>
                <Field label="Address"><input className="input" value={s.store.address} onChange={(e) => up('store', { address: e.target.value })} /></Field>
                <Field label="Phone"><input className="input" value={s.store.phone} onChange={(e) => up('store', { phone: e.target.value })} /></Field>
                <Field label="Email"><input className="input" value={s.store.email} onChange={(e) => up('store', { email: e.target.value })} /></Field>
                <Field label="PAN / VAT registration no." hint="Leave blank until Nayaro Mart provides its actual registration number. It is printed on receipts only when filled."><input className="input" value={s.store.panVat} onChange={(e) => up('store', { panVat: e.target.value })} /></Field>
              </div>
              <Field label="Currency" hint="Amounts are stored in paisa (1/100 rupee)."><input className="input" disabled value={`${s.currency.code} — ${s.currency.symbol}`} /></Field>
            </Section>
          )}
          {tab === 'receipt' && (
            <Section title="Receipt">
              <div className="grid g2">
                <Field label="Header message"><textarea className="input" value={s.receipt.header} onChange={(e) => up('receipt', { header: e.target.value })} /></Field>
                <Field label="Footer message"><textarea className="input" value={s.receipt.footer} onChange={(e) => up('receipt', { footer: e.target.value })} /></Field>
                <Field label="Paper width"><select className="select" value={s.receipt.paperWidthMm} onChange={(e) => up('receipt', { paperWidthMm: Number(e.target.value) as 80 | 58 })}><option value={80}>80 mm</option><option value={58}>58 mm</option></select></Field>
                <Field label="Receipt number prefix" hint="e.g. NYM → NYM/83-84/000001. Numbering restarts every fiscal year."><input className="input mono" value={s.receipt.prefix} onChange={(e) => up('receipt', { prefix: e.target.value.toUpperCase() })} /></Field>
              </div>
              <label className="check"><input type="checkbox" checked={s.receipt.showBsDate} onChange={(e) => up('receipt', { showBsDate: e.target.checked })} /> Print Bikram Sambat (BS) date on receipts</label>
              <Banner kind="info">The receipt prints “Not a tax invoice. Billing format pending IRD verification.” until tax is configured and marked verified. Invoice fields and numbering must be confirmed with IRD — see docs/NEPAL_COMPLIANCE.md.</Banner>
            </Section>
          )}
          {tab === 'payments' && (
            <Section title="Payment methods" desc="Cash is processed in the app (tendered & change). Other methods are only recorded with a reference — no card or wallet data is stored, and no payment gateway is integrated.">
              <table className="table">
                <thead><tr><th>Code</th><th>Label</th><th>Requires reference</th><th>Enabled</th></tr></thead>
                <tbody>
                  {s.paymentMethods.map((m, i) => (
                    <tr key={m.code}>
                      <td className="mono">{m.code}</td>
                      <td><input className="input" value={m.label} onChange={(e) => setS({ ...s, paymentMethods: s.paymentMethods.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /></td>
                      <td><input type="checkbox" checked={m.requiresReference} disabled={m.code === 'cash'} onChange={(e) => setS({ ...s, paymentMethods: s.paymentMethods.map((x, j) => (j === i ? { ...x, requiresReference: e.target.checked } : x)) })} /></td>
                      <td><input type="checkbox" checked={m.enabled} onChange={(e) => setS({ ...s, paymentMethods: s.paymentMethods.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)) })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          {tab === 'tax' && (
            <Section title="Tax configuration — compliance gate" desc="Disabled by default. This app does not contain any Nepal tax rates or rules.">
              <Banner kind="warn">
                <b>Do not enable tax until it is verified.</b> Confirm with the Inland Revenue Department (IRD) or a qualified tax adviser: whether Nayaro Mart must charge VAT, the rate, whether prices are tax-inclusive, the required invoice format/numbering, and any electronic billing / CBMS obligations or software approval. This software has <b>not</b> been approved or certified by IRD. See <span className="mono">docs/NEPAL_COMPLIANCE.md</span>.
              </Banner>
              <label className="check"><input type="checkbox" checked={s.tax.verified} onChange={(e) => up('tax', { verified: e.target.checked, enabled: e.target.checked ? s.tax.enabled : false })} /> Tax configuration has been verified with IRD / a qualified adviser</label>
              <Field label="Verification note (who confirmed, when, reference)" hint="Required before tax can be enabled. Recorded in the audit log."><textarea className="input" value={s.tax.verificationNote} onChange={(e) => up('tax', { verificationNote: e.target.value })} disabled={!s.tax.verified} /></Field>
              <div className="grid g3">
                <Field label="Tax label (as verified)"><input className="input" value={s.tax.label} onChange={(e) => up('tax', { label: e.target.value })} disabled={!s.tax.verified} placeholder="e.g. as advised" /></Field>
                <Field label="Rate (%)" hint="Enter only the verified rate"><input className="input num" type="number" step="0.01" min={0} value={s.tax.rateBp / 100} onChange={(e) => up('tax', { rateBp: Math.round(Number(e.target.value) * 100) })} disabled={!s.tax.verified} /></Field>
                <Field label="Prices are"><select className="select" value={s.tax.inclusive ? 'incl' : 'excl'} onChange={(e) => up('tax', { inclusive: e.target.value === 'incl' })} disabled={!s.tax.verified}><option value="excl">Tax-exclusive (tax added)</option><option value="incl">Tax-inclusive</option></select></Field>
              </div>
              <label className="check"><input type="checkbox" checked={s.tax.enabled} disabled={!s.tax.verified} onChange={(e) => up('tax', { enabled: e.target.checked })} /> Apply tax at checkout</label>
            </Section>
          )}
          {tab === 'printers' && <PrinterSection s={s} up={up} />}
          {tab === 'pos' && (
            <Section title="Checkout rules">
              <div className="grid g3">
                <Field label="Duplicate-scan window (ms)" hint="Identical barcode reads within this window are ignored (scanner double-reads). Re-scanning after it adds +1."><input className="input num" type="number" value={s.pos.scanDebounceMs} onChange={(e) => up('pos', { scanDebounceMs: Number(e.target.value) })} /></Field>
                <Field label="Cashier max discount (%)" hint="Above this, an administrator must approve."><input className="input num" type="number" step="0.5" value={s.pos.cashierMaxDiscountBp / 100} onChange={(e) => up('pos', { cashierMaxDiscountBp: Math.round(Number(e.target.value) * 100) })} /></Field>
              </div>
              <label className="check"><input type="checkbox" checked={s.pos.allowNegativeStock} onChange={(e) => up('pos', { allowNegativeStock: e.target.checked })} /> Allow selling more than recorded stock (not recommended)</label>
            </Section>
          )}
          {tab === 'scanners' && (
            <Section title="Barcode scanners" desc="Choose how products are scanned at the counter. Both can be on at the same time.">
              <label className="check"><input type="checkbox" checked={s.scanner.usbEnabled} onChange={(e) => up('scanner', { usbEnabled: e.target.checked })} /> <b>USB / Bluetooth barcode scanner</b> (acts like a keyboard; the checkout scan box captures it)</label>
              <label className="check"><input type="checkbox" checked={s.scanner.phoneEnabled} onChange={(e) => up('scanner', { phoneEnabled: e.target.checked })} /> <b>Phone camera scanner</b> — pair a phone by QR code over the shop Wi-Fi (no internet, no app install)</label>
              <Field label="Phone scanner port (HTTPS)" hint="Default 8788. Must differ from the mobile admin port."><input className="input num" style={{ maxWidth: 140 }} type="number" value={s.scanner.phonePort} disabled={!s.scanner.phoneEnabled} onChange={(e) => up('scanner', { phonePort: Number(e.target.value) })} /></Field>
              <Banner kind="info">
                After saving, open <b>Checkout → Phone scanner</b> to show the pairing QR code. Phone browsers only allow the camera on secure pages, so this computer creates its own offline HTTPS certificate — the phone shows a one-time warning; choose “Advanced → Proceed”. On Windows, allow the firewall prompt for <b>private</b> networks.
              </Banner>
              <Banner kind="warn">Phone-camera scanning is slower than a dedicated scanner and depends on light and focus. It is fine for trying the system now; a USB scanner is recommended for daily billing. Physical testing is still required (docs/HARDWARE_TESTS.md).</Banner>
            </Section>
          )}
          {tab === 'fiscal' && <FiscalSection />}
          {tab === 'mobile' && <MobileSection s={s} up={up} dirty={dirty} />}
          {tab === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  );
}

function PrinterSection({ s, up }: { s: AppSettings; up: <K extends keyof AppSettings>(k: K, v: Partial<AppSettings[K]>) => void }) {
  const printers = useAsync(() => api('printers.list'), []);
  return (
    <Section title="Printers" desc="Printing uses the operating-system driver. Nothing is vendor-specific; physical output must be tested on site.">
      {printers.data && printers.data.length === 0 && <Banner kind="warn">No printers were detected. Install the printer driver, then click refresh. Until then use “Save PDF”.</Banner>}
      <div className="grid g2">
        <Field label="Receipt printer (80 mm thermal)">
          <select className="select" value={s.printers.receiptPrinter ?? ''} onChange={(e) => up('printers', { receiptPrinter: e.target.value || null })}>
            <option value="">— choose in print dialog each time —</option>
            {printers.data?.map((p) => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Label printer">
          <select className="select" value={s.printers.labelPrinter ?? ''} onChange={(e) => up('printers', { labelPrinter: e.target.value || null })}>
            <option value="">— choose in print dialog each time —</option>
            {printers.data?.map((p) => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>)}
          </select>
        </Field>
      </div>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={printers.reload}>Refresh printer list</button>
      <label className="check"><input type="checkbox" checked={s.printers.autoPrintReceipt} onChange={(e) => up('printers', { autoPrintReceipt: e.target.checked })} /> Print the receipt automatically after each sale</label>
      <label className="check"><input type="checkbox" checked={s.printers.silentReceipt} disabled={!s.printers.receiptPrinter} onChange={(e) => up('printers', { silentReceipt: e.target.checked })} /> Auto-print silently to the selected receipt printer (no dialog) — enable only after a successful physical test</label>
      <Banner kind="info">Label sizes are configured in <Link to="/labels">Label studio</Link>. Test procedure: docs/HARDWARE_TESTS.md.</Banner>
    </Section>
  );
}

function FiscalSection() {
  const { info } = useSession();
  const fys = useAsync(() => api('reports.fiscalYears'), []);
  const f = info?.fiscal;
  return (
    <Section title="Fiscal year" desc="Nepal's fiscal year runs from 1 Shrawan to the last day of Ashadh (Bikram Sambat). Boundaries are computed from the BS calendar.">
      {f && (
        <div className="card card-pad" style={{ boxShadow: 'none', background: 'var(--brand-50)' }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>FY {f.code} is running</div>
          <div className="muted">{f.startDate} → {f.endDate} (BS {f.bsStart} → {f.bsEnd}) · day {f.dayNumber} of {f.totalDays} · {f.daysLeft} days left</div>
        </div>
      )}
      <div className="small muted">Every sale, return and purchase is stamped with its fiscal year at the moment it is recorded. Receipt numbers restart at 000001 each fiscal year (format to be confirmed with IRD).</div>
      {fys.data && (
        <table className="table">
          <thead><tr><th>Fiscal year</th><th>Start</th><th>End</th><th>Source</th><th className="num">Sales</th></tr></thead>
          <tbody>{fys.data.map((x) => <tr key={x.code}><td><b>{x.code}</b> {x.isCurrent && <span className="badge green">running</span>}</td><td>{x.startDate}</td><td>{x.endDate}</td><td>{x.source}</td><td className="num">{x.saleCount}</td></tr>)}</tbody>
        </table>
      )}
    </Section>
  );
}

function MobileSection({ s, up, dirty }: { s: AppSettings; up: <K extends keyof AppSettings>(k: K, v: Partial<AppSettings[K]>) => void; dirty: boolean }) {
  const status = useAsync(() => api('mobile.status'), [s.mobile.enabled, s.mobile.port, dirty]);
  return (
    <Section title="Mobile admin app" desc="A read-only dashboard for the owner's phone: today's sales, fiscal-year totals, low stock and recent receipts.">
      <label className="check"><input type="checkbox" checked={s.mobile.enabled} onChange={(e) => up('mobile', { enabled: e.target.checked })} /> Serve the mobile admin dashboard on the shop network</label>
      <Field label="Port"><input className="input num" style={{ maxWidth: 140 }} type="number" value={s.mobile.port} onChange={(e) => up('mobile', { port: Number(e.target.value) })} /></Field>
      {dirty && <Banner kind="info">Save settings to apply.</Banner>}
      {status.data && (
        <div className="card card-pad" style={{ boxShadow: 'none' }}>
          <div className="row"><Smartphone size={18} /><b>{status.data.message}</b></div>
          {status.data.urls.map((u) => <div key={u} className="mono" style={{ marginTop: 6, fontSize: 15 }}>{u}</div>)}
          {status.data.running && <div className="small muted mt">Open this address on a phone connected to the shop Wi-Fi, sign in with an administrator account, then “Add to Home Screen”.</div>}
        </div>
      )}
      <Banner kind="warn">
        Read-only and administrator-only, but it uses plain HTTP on the local network. Away from the shop, do <b>not</b> expose the port to the internet — use a private VPN (e.g. Tailscale/WireGuard) to reach the shop computer. Details: docs/MOBILE_ADMIN.md. Checkout never depends on this.
      </Banner>
    </Section>
  );
}

function DataSection() {
  const { info, refreshInfo } = useSession();
  const toast = useToast();
  const [dlg, setDlg] = useState<'reset' | 'live' | null>(null);
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState('RESET DEMO');
  async function run(kind: 'reset' | 'live', password: string) {
    setBusy(true);
    try {
      const r = kind === 'reset' ? await api('demo.reset', { confirmText: phrase, password }) : await api('demo.goLive', { confirmText: 'START LIVE', password });
      toast.ok(`${kind === 'reset' ? 'Demo data reset' : 'Live mode started'} · safety backup ${r.backup}`);
      setDlg(null);
      await refreshInfo();
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      const m = errMsg(e);
      if (m.includes('DELETE REAL DATA')) setPhrase('DELETE REAL DATA');
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Demo and live data" desc={`Current mode: ${info?.dataMode === 'demo' ? 'DEMO — all records are fictional' : 'LIVE — real operational data'}`}>
      {info?.dataMode === 'demo' ? (
        <>
          <Banner kind="warn">All products, suppliers and transactions are fictional demo records (brands are marked “(Demo)”, suppliers are marked “fictional”, barcodes use the GS1 in-store prefix 20). Sales made in demo mode are also flagged as demo.</Banner>
          <div className="row">
            <button className="btn" onClick={() => setDlg('reset')}>Reset demo data</button>
            <button className="btn primary" onClick={() => setDlg('live')}>Remove demo data & start live operation</button>
          </div>
        </>
      ) : (
        <>
          <Banner kind="ok">Live mode. Demo reset is protected: if any real records exist it requires typing <span className="mono">DELETE REAL DATA</span> and your password, and a backup is taken first.</Banner>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setDlg('reset')}>Load demo data…</button>
        </>
      )}
      <div className="small muted">Every reset or go-live first creates a verified backup. Users, settings and the audit log are kept.</div>
      {dlg === 'reset' && (
        <ConfirmText title="Reset demo data" phrase={phrase} busy={busy} onCancel={() => setDlg(null)} onConfirm={(pw) => void run('reset', pw)}
          body={<Banner kind="danger">This deletes all products, sales, purchases and stock records and reloads fresh demo data. A backup is taken automatically first.{phrase === 'DELETE REAL DATA' && <b> Real (non-demo) records exist and will be erased.</b>}</Banner>} />
      )}
      {dlg === 'live' && (
        <ConfirmText title="Start live operation" phrase="START LIVE" busy={busy} danger={false} onCancel={() => setDlg(null)} onConfirm={(pw) => void run('live', pw)}
          body={<Banner kind="warn">All demo products, sales, purchases and suppliers will be removed so Nayaro Mart can enter its real catalogue. Demo accounts will be required to change their passwords. A backup is taken first.</Banner>} />
      )}
    </Section>
  );
}

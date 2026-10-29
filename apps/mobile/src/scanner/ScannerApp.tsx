import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { formatNPR } from '@srmart/shared';
import { Camera, CameraOff, CheckCircle2, Keyboard, RotateCcw, ScanLine, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'srmart-scanner-token';
const COOLDOWN_MS = 1500;

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked; pairing then lasts for this page only */
  }
  return null;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const m = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(ua);
  return m?.[1]?.trim() || (/Android/.test(ua) ? 'Android phone' : 'Phone');
}

function feedback(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1250 : 240;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.07 : 0.25));
    o.onended = () => void ctx.close();
  } catch {
    /* optional */
  }
}

interface ScanLog {
  id: number;
  code: string;
  kind: 'ok' | 'warn' | 'error';
  title: string;
  detail: string;
}

export function ScannerApp() {
  const [token, setToken] = useState<string | null>(() => store(TOKEN_KEY));
  const [store_, setStoreName] = useState('Nayaro Mart');
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [log, setLog] = useState<ScanLog[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const last = useRef({ code: '', at: 0 });
  const seq = useRef(0);

  // Pair from the QR code link: https://<pos>/scanner.html#pair=<token>
  useEffect(() => {
    const m = /pair=([\w-]+)/.exec(location.hash);
    if (!m) return;
    setPairing(true);
    fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairToken: m[1], deviceName: deviceName() }) })
      .then(async (r) => {
        const b = (await r.json().catch(() => ({}))) as { deviceToken?: string; storeName?: string; error?: string };
        if (!r.ok || !b.deviceToken) throw new Error(b.error ?? 'Pairing failed');
        store(TOKEN_KEY, b.deviceToken);
        setToken(b.deviceToken);
        setStoreName(b.storeName ?? 'Nayaro Mart');
        setPairError(null);
      })
      .catch((e: Error) => setPairError(e.message))
      .finally(() => {
        setPairing(false);
        history.replaceState(null, '', location.pathname); // never leave the token in the address bar
      });
  }, []);

  useEffect(() => {
    if (!token) return;
    fetch('/api/ping', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (r.status === 401) {
          store(TOKEN_KEY, null);
          setToken(null);
          setPairError('This phone is no longer paired (the POS was restarted or unpaired it). Scan a new pairing QR code.');
          return;
        }
        const b = (await r.json()) as { storeName?: string };
        if (b.storeName) setStoreName(b.storeName);
      })
      .catch(() => undefined);
  }, [token]);

  const push = (entry: Omit<ScanLog, 'id'>) => setLog((l) => [{ id: ++seq.current, ...entry }, ...l].slice(0, 15));

  const send = useCallback(
    async (code: string) => {
      if (!token) return;
      try {
        const r = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean; delivered?: boolean; message?: string; error?: string; product?: { name: string; pricePaisa: number } | null };
        if (r.status === 401) {
          store(TOKEN_KEY, null);
          setToken(null);
          setPairError(b.error ?? 'Not paired');
          return;
        }
        if (!r.ok) {
          feedback(false);
          return push({ code, kind: 'error', title: b.error ?? 'Rejected', detail: code });
        }
        const good = !!b.ok && !!b.delivered;
        feedback(good);
        push({
          code,
          kind: good ? 'ok' : b.ok ? 'warn' : 'error',
          title: b.product ? `${b.product.name} — ${formatNPR(b.product.pricePaisa)}` : 'Unknown barcode',
          detail: `${code} · ${b.message ?? ''}`,
        });
      } catch {
        feedback(false);
        push({ code, kind: 'error', title: 'Cannot reach the POS', detail: 'Check that this phone is on the shop Wi-Fi and the POS is running.' });
      }
    },
    [token],
  );

  const onDecoded = useCallback(
    (code: string) => {
      const now = Date.now();
      // The camera sees the same barcode many times per second: accept it once per cooldown.
      if (code === last.current.code && now - last.current.at < COOLDOWN_MS) return;
      last.current = { code, at: now };
      void send(code);
    },
    [send],
  );

  async function startCamera() {
    setCameraError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera needs a secure (https) page. Open the link from the POS QR code and accept the certificate warning.');
      return;
    }
    try {
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
      controls.current = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        videoRef.current!,
        (result) => {
          if (result) onDecoded(result.getText());
        },
      );
      setCameraOn(true);
    } catch (e) {
      setCameraError((e as Error).name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access for this site in the browser settings.' : `Could not start the camera: ${(e as Error).message}`);
    }
  }

  function stopCamera() {
    controls.current?.stop();
    controls.current = null;
    setCameraOn(false);
  }

  useEffect(() => () => controls.current?.stop(), []);

  if (!token) {
    return (
      <div className="pair">
        <div className="logo"><ScanLine size={30} /></div>
        <h1>Phone scanner</h1>
        {pairing ? <p>Pairing with the POS…</p> : (
          <>
            {pairError && <div className="msg error">{pairError}</div>}
            <ol>
              <li>On the POS computer open <b>Checkout → Phone scanner</b>.</li>
              <li>Scan the QR code shown there with this phone's camera.</li>
              <li>If the browser warns about the certificate, choose <b>Advanced → Proceed</b>. It is the shop computer's own offline certificate.</li>
            </ol>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="scanner">
      <header>
        <div><b>{store_}</b><span>Phone scanner · paired</span></div>
        <button className="ghost" onClick={() => (store(TOKEN_KEY, null), setToken(null), stopCamera())} title="Forget pairing"><RotateCcw size={18} /></button>
      </header>
      <div className={`viewport ${cameraOn ? 'on' : ''}`}>
        <video ref={videoRef} muted playsInline />
        {cameraOn ? <div className="aim" /> : (
          <button className="start" onClick={() => void startCamera()}><Camera size={28} /> Start camera</button>
        )}
      </div>
      {cameraError && <div className="msg error">{cameraError}</div>}
      <div className="bar">
        {cameraOn && <button onClick={stopCamera}><CameraOff size={18} /> Stop</button>}
        {log[0] && <button onClick={() => void send(log[0]!.code)}>+1 again ({log[0].code})</button>}
      </div>
      <form className="manual" onSubmit={(e) => (e.preventDefault(), manual.trim() && void send(manual.trim()), setManual(''))}>
        <Keyboard size={18} />
        <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Type a barcode / SKU" inputMode="text" autoCapitalize="characters" />
        <button disabled={!manual.trim()}>Send</button>
      </form>
      <div className="log">
        {log.length === 0 && <p className="hint">Point the camera at a barcode. Each product is sent once; to add another of the same item, move away and scan again or tap “+1 again”.</p>}
        {log.map((l) => (
          <div key={l.id} className={`entry ${l.kind}`}>
            {l.kind === 'ok' ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
            <div><b>{l.title}</b><span>{l.detail}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

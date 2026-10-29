import { contextBridge, ipcRenderer } from 'electron';
import { API_CHANNELS, type ApiEnvelope } from '@srmart/shared';

/**
 * The renderer's ONLY door to the system: one method, allow-listed channel names, and the
 * main process validates every payload and checks the signed-in user's role.
 * No Node, filesystem, database or Electron objects are exposed.
 */
const allowed = new Set<string>(API_CHANNELS);

contextBridge.exposeInMainWorld('srmart', {
  platform: process.platform,
  /** Codes scanned by a paired phone. Only the plain event data crosses the bridge. */
  onScannerCode(cb: (e: { code: string; device: string; at: string }) => void) {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_e: unknown, data: { code: string; device: string; at: string }) => cb({ code: String(data.code), device: String(data.device), at: String(data.at) });
    ipcRenderer.on('scanner:code', listener);
    ipcRenderer.send('scanner:listen', true);
    return () => {
      ipcRenderer.removeListener('scanner:code', listener);
      ipcRenderer.send('scanner:listen', false);
    };
  },
  invoke(channel: string, payload?: unknown): Promise<ApiEnvelope<unknown>> {
    if (typeof channel !== 'string' || !allowed.has(channel)) {
      return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: `Unknown channel ${String(channel)}` } });
    }
    return ipcRenderer.invoke('srmart:invoke', channel, payload ?? null);
  },
});

import type { ApiChannel, ApiEnvelope, ApiIn, ApiOut, ScannerEvent } from '@srmart/shared';

export class ApiError extends Error {
  constructor(public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<ApiEnvelope<unknown>>;
  onScannerCode?(cb: (e: ScannerEvent) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    srmart?: Bridge;
  }
}

export const hasBridge = () => typeof window !== 'undefined' && !!window.srmart;

/** Typed call into the Electron main process. Throws ApiError with a user-presentable message. */
export async function api<K extends ApiChannel>(channel: K, payload?: ApiIn<K>): Promise<ApiOut<K>> {
  if (!window.srmart) throw new ApiError('NO_BRIDGE', 'This screen must run inside the Nayaro Mart desktop app.');
  const res = await window.srmart.invoke(channel, payload);
  if (res.ok) return res.data as ApiOut<K>;
  throw new ApiError(res.error.code, res.error.message, res.error.fields);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

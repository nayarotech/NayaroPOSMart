import type { AppInfo, AppSettings, SessionUser } from '@srmart/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

interface SessionValue {
  user: SessionUser | null;
  info: AppInfo | null;
  settings: AppSettings | null;
  ready: boolean;
  setUser: (u: SessionUser | null) => void;
  refreshInfo: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [ready, setReady] = useState(false);

  const refreshInfo = useCallback(async () => setInfo(await api('app.info')), []);
  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api('settings.get'));
    } catch {
      setSettings(null);
    }
  }, []);

  useEffect(() => {
    Promise.all([api('auth.session').then(setUser), refreshInfo()])
      .catch(() => undefined)
      .finally(() => setReady(true));
    // Keep the fiscal-year/day indicator current if the app stays open past midnight.
    const t = setInterval(() => void refreshInfo().catch(() => undefined), 5 * 60_000);
    return () => clearInterval(t);
  }, [refreshInfo]);

  useEffect(() => {
    if (user && !user.mustChangePassword) {
      void refreshSettings();
      void refreshInfo();
    }
  }, [user, refreshSettings, refreshInfo]);

  const logout = useCallback(async () => {
    await api('auth.logout').catch(() => undefined);
    setUser(null);
    setSettings(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, info, settings, ready, setUser, refreshInfo, refreshSettings, logout, isAdmin: user?.role === 'admin' }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}

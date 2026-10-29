import type { ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { hasBridge } from './api';
import { Layout } from './components/Layout';
import { Banner, Loading, ToastProvider } from './components/ui';
import { SessionProvider, useSession } from './session';
import { BackupPage } from './pages/Backup';
import { ChangePassword } from './pages/ChangePassword';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { Labels } from './pages/Labels';
import { Login } from './pages/Login';
import { Offers } from './pages/Offers';
import { Pos } from './pages/Pos';
import { Products } from './pages/Products';
import { Purchases } from './pages/Purchases';
import { Reports } from './pages/Reports';
import { Sales } from './pages/Sales';
import { SettingsPage } from './pages/Settings';
import { Users } from './pages/Users';

function Routed() {
  const { user, ready, isAdmin } = useSession();
  if (!ready) return <Loading text="Opening local database…" />;
  if (!user) return <Login />;
  if (user.mustChangePassword) return <ChangePassword forced />;
  const admin = (el: ReactElement) => (isAdmin ? el : <Navigate to="/pos" replace />);
  return (
    <Layout>
      <Routes>
        <Route path="/pos" element={<Pos />} />
        <Route path="/dashboard" element={admin(<Dashboard />)} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/products" element={<Products />} />
        <Route path="/labels" element={<Labels />} />
        <Route path="/offers" element={admin(<Offers />)} />
        <Route path="/purchases" element={admin(<Purchases />)} />
        <Route path="/inventory" element={admin(<Inventory />)} />
        <Route path="/reports" element={admin(<Reports />)} />
        <Route path="/users" element={admin(<Users />)} />
        <Route path="/settings" element={admin(<SettingsPage />)} />
        <Route path="/backup" element={admin(<BackupPage />)} />
        <Route path="/account" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to={isAdmin ? '/dashboard' : '/pos'} replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  if (!hasBridge()) {
    return (
      <div style={{ padding: 40, maxWidth: 640 }}>
        <Banner kind="warn">
          This interface runs inside the Nayaro Mart desktop app, which provides the local database. Start it with <code>npm run dev</code> or <code>npm start</code> from the project root.
        </Banner>
      </div>
    );
  }
  return (
    <ToastProvider>
      <SessionProvider>
        <HashRouter>
          <Routed />
        </HashRouter>
      </SessionProvider>
    </ToastProvider>
  );
}

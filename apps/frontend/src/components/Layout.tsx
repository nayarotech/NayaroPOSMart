import {
  BarChart3, Boxes, Gift, ClipboardList, DatabaseBackup, LayoutDashboard, LogOut, Package, ReceiptText, Settings, ShieldCheck, ShoppingCart, Tags, Truck,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import nayaroMark from '../assets/nayaro-mark.svg';
import { useSession } from '../session';

const NAV: { to: string; label: string; icon: typeof Package; admin?: boolean; key?: string }[] = [
  { to: '/pos', label: 'Checkout', icon: ShoppingCart, key: 'F1' },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, admin: true },
  { to: '/sales', label: 'Sales & receipts', icon: ReceiptText },
  { to: '/products', label: 'Products & barcodes', icon: Package },
  { to: '/labels', label: 'Label studio', icon: Tags },
  { to: '/offers', label: 'Offers & lucky draw', icon: Gift, admin: true },
  { to: '/purchases', label: 'Purchases', icon: Truck, admin: true },
  { to: '/inventory', label: 'Inventory', icon: Boxes, admin: true },
  { to: '/reports', label: 'Reports', icon: BarChart3, admin: true },
  { to: '/users', label: 'Users & audit', icon: ShieldCheck, admin: true },
  { to: '/settings', label: 'Settings', icon: Settings, admin: true },
  { to: '/backup', label: 'Backup', icon: DatabaseBackup, admin: true },
];

export function Brand({ sub }: { sub?: string }) {
  const { info } = useSession();
  return (
    <div className="brand">
      <img className="brand-mark" src={nayaroMark} alt="" />
      <div>
        <div className="brand-word">
          NAYARO <span className="brand-tag">POS</span>
        </div>
        <div className="brand-sub">{sub ?? info?.storeName ?? 'Nayaro Mart'}</div>
      </div>
    </div>
  );
}

export function FiscalChip() {
  const { info } = useSession();
  if (!info) return null;
  const f = info.fiscal;
  return (
    <div className="fy-chip" title={`Fiscal year ${f.code}: ${f.startDate} → ${f.endDate} (BS ${f.bsStart} → ${f.bsEnd}). Day ${f.dayNumber} of ${f.totalDays}, ${f.daysLeft} days left.`}>
      <span className="dot" />
      <span className="small">
        <b>FY {f.code}</b> running
      </span>
      <div className="fy-bar">
        <span style={{ width: `${f.percent}%` }} />
      </div>
      <span className="small muted">
        Day {f.dayNumber}/{f.totalDays}
      </span>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, info, logout, isAdmin } = useSession();
  const nav = useNavigate();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        nav('/pos');
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [nav]);
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <n.icon />
            {n.label}
            {n.key && <span className="nav-kbd">{n.key}</span>}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          <div>Powered by <b style={{ color: '#a9b8d6' }}>Nayaro Tech</b></div>
          <div>v{info?.version} · offline-first · local database</div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <FiscalChip />
          {info && (
            <span className="small muted" title="Today in Bikram Sambat">
              {info.fiscal.todayBsLong} BS · {info.fiscal.todayAd}
            </span>
          )}
          <div className="grow" />
          {info?.dataMode === 'demo' && <span className="demo-pill" title="All records are fictional demo data. Go live from Settings → Data.">DEMO DATA</span>}
          {info?.demoCredentialsActive && isAdmin && (
            <NavLink to="/users" className="badge amber" title="Demo passwords are still active">
              <ClipboardList size={13} /> Change demo passwords
            </NavLink>
          )}
          <div className="user-chip">
            <div className="avatar">{user?.fullName.slice(0, 1)}</div>
            <div className="small">
              <div style={{ fontWeight: 650 }}>{user?.fullName}</div>
              <div className="faint" style={{ fontSize: 11 }}>{user?.role === 'admin' ? 'Administrator' : 'Cashier'}</div>
            </div>
            <button className="btn ghost sm icon" title="Sign out" onClick={() => void logout()}>
              <LogOut />
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

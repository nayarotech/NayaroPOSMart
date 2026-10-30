import type { Ctx } from '../context';
import { AuditRepo } from '../repositories/auditRepo';
import { AuthService } from './auth';
import { DemoService } from './demo';
import { FiscalService } from './fiscal';
import { InventoryService } from './inventory';
import { ProductService } from './products';
import { PromotionService } from './promotions';
import { PurchaseService } from './purchases';
import { ReportService } from './reports';
import { SalesService } from './sales';
import { SettingsService } from './settings';
import { ShiftService } from './shifts';
import { CartService } from './carts';
import { UserService } from './users';

export function createServices(ctx: Ctx) {
  const auth = new AuthService(ctx);
  return {
    ctx,
    shifts: new ShiftService(ctx),
    carts: new CartService(ctx),
    auth,
    fiscal: new FiscalService(ctx),
    products: new ProductService(ctx),
    sales: new SalesService(ctx, auth),
    purchases: new PurchaseService(ctx),
    inventory: new InventoryService(ctx),
    reports: new ReportService(ctx),
    users: new UserService(ctx),
    settings: new SettingsService(ctx),
    audit: new AuditRepo(ctx),
    demo: new DemoService(ctx, auth),
    promotions: new PromotionService(ctx),
  };
}

export type Services = ReturnType<typeof createServices>;

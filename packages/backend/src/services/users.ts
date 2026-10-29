import type { SessionUser, UserRow } from '@srmart/shared';
import { userInputSchema, userUpdateSchema } from '@srmart/shared';
import { z } from 'zod';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { conflict, invalid, notFound } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { publicUser, UserRepo } from '../repositories/userRepo';
import { hashPassword, requireRole } from './auth';

export class UserService {
  readonly repo: UserRepo;
  private audit: AuditRepo;

  constructor(private ctx: Ctx) {
    this.repo = new UserRepo(ctx);
    this.audit = new AuditRepo(ctx);
  }

  list(user: SessionUser): UserRow[] {
    requireRole(user, 'admin');
    return this.repo.list().map(publicUser);
  }

  create(user: SessionUser, input: unknown): UserRow {
    requireRole(user, 'admin');
    const u = userInputSchema.parse(input);
    if (this.repo.byUsername(u.username)) throw conflict(`Username "${u.username}" is taken`);
    const id = this.repo.insert({ username: u.username, fullName: u.fullName, role: u.role, passwordHash: hashPassword(u.password), mustChangePassword: true });
    this.audit.log({ action: 'user.created', entityType: 'user', entityId: id, userId: user.id, details: { username: u.username, role: u.role } });
    return publicUser(this.repo.byId(id)!);
  }

  update(user: SessionUser, input: unknown): UserRow {
    requireRole(user, 'admin');
    const u = userUpdateSchema.parse(input);
    return tx(this.ctx.db, () => {
      const before = this.repo.byId(u.id);
      if (!before) throw notFound('User');
      if (before.role === 'admin' && before.active && (u.role !== 'admin' || !u.active) && this.repo.countActiveAdmins() <= 1) {
        throw invalid('At least one active administrator is required');
      }
      if (u.id === user.id && !u.active) throw invalid('You cannot disable your own account');
      this.repo.update(u.id, u);
      this.audit.log({ action: 'user.updated', entityType: 'user', entityId: u.id, userId: user.id, details: { role: u.role, active: u.active, previousRole: before.role, previousActive: before.active } });
      return publicUser(this.repo.byId(u.id)!);
    });
  }

  resetPassword(user: SessionUser, id: number, newPassword: string) {
    requireRole(user, 'admin');
    const pw = z.string().min(8, 'Password must be at least 8 characters').max(200).parse(newPassword);
    if (!this.repo.byId(id)) throw notFound('User');
    this.repo.setPassword(id, hashPassword(pw), id !== user.id);
    this.audit.log({ action: 'user.password_reset', entityType: 'user', entityId: id, userId: user.id });
    return { ok: true as const };
  }
}

import type { Role, UserRow } from '@srmart/shared';
import type { Ctx } from '../context';
import { bool } from '../db/database';

export interface UserRecord extends UserRow {
  passwordHash: string;
  defaultPassword: boolean;
}

function map(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as number,
    username: r.username as string,
    fullName: r.full_name as string,
    role: r.role as Role,
    active: bool(r.active),
    isDemo: bool(r.is_demo),
    mustChangePassword: bool(r.must_change_password),
    defaultPassword: bool(r.default_password),
    lastLoginAt: (r.last_login_at as string) ?? null,
    createdAt: r.created_at as string,
    passwordHash: r.password_hash as string,
  };
}

export function publicUser(u: UserRecord): UserRow {
  const { passwordHash: _p, defaultPassword: _d, ...rest } = u;
  return rest;
}

export class UserRepo {
  constructor(private ctx: Ctx) {}

  byUsername(username: string): UserRecord | null {
    const r = this.ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
    return r ? map(r) : null;
  }

  byId(id: number): UserRecord | null {
    const r = this.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? map(r) : null;
  }

  list(): UserRecord[] {
    return (this.ctx.db.prepare('SELECT * FROM users ORDER BY role, username').all() as Record<string, unknown>[]).map(map);
  }

  insert(u: { username: string; fullName: string; role: Role; passwordHash: string; isDemo?: boolean; defaultPassword?: boolean; mustChangePassword?: boolean }): number {
    const now = this.ctx.clock.now().toISOString();
    const res = this.ctx.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_demo, default_password, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.username, u.fullName, u.role, u.passwordHash, u.isDemo ? 1 : 0, u.defaultPassword ? 1 : 0, u.mustChangePassword ? 1 : 0, now, now);
    return Number(res.lastInsertRowid);
  }

  update(id: number, fields: { fullName: string; role: Role; active: boolean }) {
    this.ctx.db
      .prepare('UPDATE users SET full_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(fields.fullName, fields.role, fields.active ? 1 : 0, this.ctx.clock.now().toISOString(), id);
  }

  setPassword(id: number, hash: string, mustChange: boolean) {
    this.ctx.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = ?, default_password = 0, updated_at = ? WHERE id = ?')
      .run(hash, mustChange ? 1 : 0, this.ctx.clock.now().toISOString(), id);
  }

  touchLogin(id: number) {
    this.ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.ctx.clock.now().toISOString(), id);
  }

  countActiveAdmins(): number {
    return (this.ctx.db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get() as { n: number }).n;
  }

  anyDefaultPasswords(): boolean {
    return !!this.ctx.db.prepare('SELECT 1 FROM users WHERE default_password = 1 AND active = 1 LIMIT 1').get();
  }
}

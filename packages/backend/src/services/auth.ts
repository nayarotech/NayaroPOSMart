import crypto from 'node:crypto';
import type { Role, SessionUser } from '@srmart/shared';
import { credentialsSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { AppError, forbidden } from '../errors';
import { UserRepo, type UserRecord } from '../repositories/userRepo';
import { AuditRepo } from '../repositories/auditRepo';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

export const toSession = (u: UserRecord): SessionUser => ({
  id: u.id,
  username: u.username,
  fullName: u.fullName,
  role: u.role,
  mustChangePassword: u.mustChangePassword,
});

export function requireRole(user: SessionUser | null, ...roles: Role[]): SessionUser {
  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in first');
  if (!roles.includes(user.role)) throw forbidden(`This action requires ${roles.join(' or ')} permission`);
  return user;
}

// A dummy hash so failed lookups take the same time as wrong passwords.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

export class AuthService {
  private users: UserRepo;
  private audit: AuditRepo;
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private ctx: Ctx) {
    this.users = new UserRepo(ctx);
    this.audit = new AuditRepo(ctx);
  }

  private checkLock(key: string) {
    const f = this.failures.get(key);
    if (f && f.until > Date.now()) {
      throw new AppError('RATE_LIMITED', `Too many failed attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} seconds.`);
    }
  }

  private recordFailure(key: string) {
    const f = this.failures.get(key) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) {
      f.until = Date.now() + 60_000;
      f.count = 0;
    }
    this.failures.set(key, f);
  }

  /** Verifies credentials without creating a session. Used for login and supervisor overrides. */
  verify(input: unknown, opts: { audit?: string } = {}): UserRecord {
    const { username, password } = credentialsSchema.parse(input);
    const key = username.toLowerCase();
    this.checkLock(key);
    const user = this.users.byUsername(username);
    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH) && !!user;
    if (!ok || !user) {
      this.recordFailure(key);
      this.audit.log({ action: 'auth.failed', entityType: 'user', entityId: username, details: { context: opts.audit ?? 'login' } });
      throw new AppError('UNAUTHENTICATED', 'Incorrect username or password');
    }
    if (!user.active) throw new AppError('FORBIDDEN', 'This account is disabled');
    this.failures.delete(key);
    return user;
  }

  login(input: unknown): SessionUser {
    const user = this.verify(input);
    this.users.touchLogin(user.id);
    this.audit.log({ action: 'auth.login', entityType: 'user', entityId: user.id, userId: user.id });
    return toSession(user);
  }

  /** Supervisor override: an active admin re-enters credentials to approve a restricted action. */
  verifyOverride(input: unknown, purpose: string): UserRecord {
    const approver = this.verify(input, { audit: `override:${purpose}` });
    if (approver.role !== 'admin') throw forbidden('Approval must come from an administrator account');
    return approver;
  }

  changePassword(user: SessionUser, currentPassword: string, newPassword: string) {
    const rec = this.verify({ username: user.username, password: currentPassword });
    if (currentPassword === newPassword) throw new AppError('VALIDATION', 'Choose a password different from the current one');
    this.users.setPassword(rec.id, hashPassword(newPassword), false);
    this.audit.log({ action: 'user.password_changed', entityType: 'user', entityId: rec.id, userId: rec.id });
  }

  refresh(id: number): SessionUser | null {
    const u = this.users.byId(id);
    return u && u.active ? toSession(u) : null;
  }
}

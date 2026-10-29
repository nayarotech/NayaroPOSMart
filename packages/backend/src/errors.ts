import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'APPROVAL_REQUIRED'
  | 'PRICE_CHANGED'
  | 'INSUFFICIENT_STOCK'
  | 'RATE_LIMITED'
  | 'DATABASE'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} was not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError('FORBIDDEN', msg);
export const conflict = (msg: string) => new AppError('CONFLICT', msg);
export const invalid = (msg: string, fields?: Record<string, string>) => new AppError('VALIDATION', msg, fields);

/** Normalises any thrown value into a safe, user-presentable error (never leaks SQL or stack traces). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    const first = err.issues[0];
    const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
    return new AppError('VALIDATION', `${where}${first?.message ?? 'Invalid input'}`, fields);
  }
  const e = err as { code?: string; message?: string };
  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_')) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return new AppError('CONFLICT', 'This record already exists (duplicate value).');
    }
    if (e.code === 'SQLITE_CONSTRAINT_TRIGGER') {
      return new AppError('FORBIDDEN', e.message ?? 'Operation blocked by a data-protection rule.');
    }
    if (e.code.startsWith('SQLITE_CONSTRAINT')) {
      return new AppError('VALIDATION', 'The data violates a database rule and was not saved.');
    }
    if (e.code === 'SQLITE_BUSY') return new AppError('DATABASE', 'The database is busy. Please try again.');
    return new AppError('DATABASE', 'A database error occurred. The operation was not saved.');
  }
  return new AppError('INTERNAL', 'Unexpected error. The operation was not completed.');
}

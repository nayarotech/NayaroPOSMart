import type { DB } from './db/database';
import type { Clock } from './clock';

export interface Ctx {
  db: DB;
  clock: Clock;
}

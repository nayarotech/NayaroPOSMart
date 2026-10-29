import { toLocalISODate } from '@srmart/shared';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Mutable clock used by tests and the demo seeder to place records on past dates. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date) {
    this.current = d;
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const isoNow = (clock: Clock) => clock.now().toISOString();
export const businessDate = (clock: Clock) => toLocalISODate(clock.now());

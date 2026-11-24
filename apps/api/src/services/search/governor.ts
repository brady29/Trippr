/**
 * Keeps search cheap and fair. Two limits per member:
 *  - a rate limit on every search (a burst per minute), answered with 429 so a runaway client stops;
 *  - a daily allowance of searches that call the hosted embedder (the only ones that cost anything),
 *    after which searches still work on words alone.
 * Counts live in this process: with several API instances each has its own, so the real daily ceiling per member is
 * the allowance times the instances (the app runs one to a few). Cached questions do not use the allowance.
 */
export interface GovernorOptions {
  perMinute: number;
  dailyEmbeds: number;
  now?: () => number;
}

const MINUTE = 60_000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class SearchGovernor {
  private readonly recent = new Map<string, number[]>();
  private readonly embeds = new Map<string, { day: string; count: number }>();
  private readonly now: () => number;

  constructor(private readonly options: GovernorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Count a search; returns the seconds to wait when the member searched too often, else null. */
  hit(userId: string): number | null {
    const now = this.now();
    const times = (this.recent.get(userId) ?? []).filter((t) => now - t < MINUTE);
    if (times.length >= this.options.perMinute) {
      this.recent.set(userId, times);
      return Math.max(1, Math.ceil((times[0]! + MINUTE - now) / 1000));
    }
    times.push(now);
    this.recent.set(userId, times);
    if (this.recent.size > 5000) this.sweep(now);
    return null;
  }

  /** Searches left today that may call the embedder. */
  embedsLeft(userId: string): number {
    const today = utcDay(this.now());
    const entry = this.embeds.get(userId);
    return Math.max(0, this.options.dailyEmbeds - (entry && entry.day === today ? entry.count : 0));
  }

  /** Record one call to the embedder. */
  countEmbed(userId: string) {
    const today = utcDay(this.now());
    const entry = this.embeds.get(userId);
    if (entry && entry.day === today) entry.count++;
    else this.embeds.set(userId, { day: today, count: 1 });
  }

  get dailyLimit(): number {
    return this.options.dailyEmbeds;
  }

  private sweep(now: number) {
    for (const [id, times] of this.recent) if (!times.some((t) => now - t < MINUTE)) this.recent.delete(id);
  }
}

/**
 * Remembers recent failures so a down embedder is skipped instead of making every search wait for the timeout.
 * Closed -> after `threshold` failures in a row open for `coolOffMs` -> one try -> closed again on success.
 */
export class Breaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold = 3,
    private readonly coolOffMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get open(): boolean {
    return this.now() < this.openUntil;
  }

  success() {
    this.failures = 0;
    this.openUntil = 0;
  }

  failure() {
    this.failures++;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.coolOffMs;
  }
}

/** A small cache of question -> vector, so a repeated question costs nothing and does not use the allowance. */
export class QueryCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max = 300) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

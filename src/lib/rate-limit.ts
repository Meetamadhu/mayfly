/**
 * A small in-memory limiter for sign-in and sign-up, so nobody can guess passwords or flood sign-ups.
 * Counts events per key in a sliding window. Memory only: a restart forgets, which is fine for this.
 */
type Limits = Map<string, number[]>;

function store(): Limits {
  const holder = globalThis as unknown as { __mayflyLimits?: Limits };
  holder.__mayflyLimits ??= new Map();
  return holder.__mayflyLimits;
}

function recent(key: string, windowMs: number, now: number) {
  const kept = (store().get(key) ?? []).filter((at) => now - at < windowMs);
  if (kept.length) store().set(key, kept);
  else store().delete(key);
  return kept;
}

/** True when `key` has already had `max` events in the window. */
export function isLimited(key: string, max: number, windowMs: number, now = Date.now()) {
  return recent(key, windowMs, now).length >= max;
}

export function countEvent(key: string, now = Date.now()) {
  const list = store().get(key) ?? [];
  list.push(now);
  store().set(key, list.slice(-100));
  // Don't grow forever on a server that runs for months.
  if (store().size > 5000) {
    for (const [k, times] of store()) if (now - (times.at(-1) ?? 0) > 60 * 60 * 1000) store().delete(k);
  }
}

export function clearEvents(key: string) {
  store().delete(key);
}

/** Tests only. */
export function resetLimitsForTests() {
  store().clear();
}

/**
 * Fixed-window counter per key (a client address): `allow(key)` is false once `limit` requests landed in the window.
 * ponytail: one process's memory — a restart forgets, several replicas each count alone. A shared store is the upgrade.
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>();
  return (key) => {
    const at = now();
    // Old windows go before the map can grow without bound.
    if (windows.size > 10_000) for (const [stored, window] of windows) if (at - window.start >= windowMs) windows.delete(stored);
    const window = windows.get(key);
    if (!window || at - window.start >= windowMs) {
      windows.set(key, { start: at, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  };
}

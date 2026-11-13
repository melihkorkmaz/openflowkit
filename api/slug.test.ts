// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mintPublicSlug, PUBLIC_SLUG_PATTERN } from './slug';
import { createRateLimiter } from './rateLimit';

describe('mintPublicSlug', () => {
  it('mints 256-bit url-safe slugs that do not repeat', () => {
    const slugs = Array.from({ length: 2_000 }, mintPublicSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(PUBLIC_SLUG_PATTERN);
    expect(Buffer.from(slugs[0]!, 'base64url')).toHaveLength(32);
    // Every base64url character shows up: the bytes are spread, not a narrow alphabet.
    expect(new Set(slugs.join('')).size).toBe(64);
  });
});

describe('createRateLimiter', () => {
  it('allows `limit` per window per key, then resets with the next window', () => {
    let now = 0;
    const allow = createRateLimiter(2, 1_000, () => now);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    now = 1_000;
    expect(allow('a')).toBe(true);
  });
});

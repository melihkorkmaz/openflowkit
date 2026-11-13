import { describe, expect, it } from 'vitest';
import { formatSource } from './formatSource';

describe('formatSource', () => {
  it('rewrites messy source to canonical text, keeping comments, and is stable', async () => {
    const result = await formatSource('flowchart\n  A   ->B\n\n\n// keep me\nB->C [diamond]   \n');
    expect(result).toEqual({ ok: true, text: '%% ofk 1\nflowchart\n\nC [diamond]\nA -> B\n// keep me\nB -> C\n' });
    if (result.ok) expect(await formatSource(result.text)).toEqual(result);
  });

  it('refuses, with the line, when a line would be skipped', async () => {
    const result = await formatSource('flowchart\nA -> B\nBroken [oops');
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/^Fix line 3/);
  });

  it('refuses an empty source', async () => {
    expect((await formatSource('  \n')).ok).toBe(false);
  });
});

import { randomBytes } from 'node:crypto';

/** 32 random bytes, base64url: 43 characters, 256 bits. Guessing one is as hard as guessing an AES-256 key. */
export function mintPublicSlug(): string {
  return randomBytes(32).toString('base64url');
}

/** Only something `mintPublicSlug` could have made reaches the database. */
export const PUBLIC_SLUG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

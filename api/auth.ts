// Verifies Clerk session tokens (RS256 JWTs) against the instance's JWKS with WebCrypto.
// The identity is the token's `sub`, never anything the client sends beside it.

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface PublicJwk extends JsonWebKey {
  readonly kid?: string;
}

export type JwksSource = () => Promise<readonly PublicJwk[]>;

export interface VerifierOptions {
  readonly jwks: JwksSource;
  readonly now?: () => number;
  /** Origins allowed in the token's `azp`; empty accepts any (Clerk sets it to the page that asked for the token). */
  readonly authorizedParties?: readonly string[];
  readonly clockSkewSeconds?: number;
}

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
/** An unknown `kid` refetches the keys (Clerk rotated them), at most this often: a junk token can't make us hammer Clerk. */
const REFRESH_MIN_MS = 30_000;

function decodeSegment(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new AuthError('Malformed token.');
  return new Uint8Array(Buffer.from(segment, 'base64url'));
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* falls through */ }
  throw new AuthError('Malformed token.');
}

/** Returns `verify(token) → { sub }`; throws `AuthError` for any token that is not a live one from this Clerk instance. */
export function createJwtVerifier(options: VerifierOptions): (token: string) => Promise<{ readonly sub: string }> {
  const now = options.now ?? Date.now;
  const skew = options.clockSkewSeconds ?? 5;
  const parties = options.authorizedParties ?? [];
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;

  async function refresh(): Promise<void> {
    fetchedAt = now();
    const next = new Map<string, CryptoKey>();
    for (const jwk of await options.jwks()) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      const { kid, kty, n, e } = jwk;
      next.set(kid, await crypto.subtle.importKey('jwk', { kty, n, e }, ALGORITHM, false, ['verify']));
    }
    keys = next;
  }

  async function keyFor(kid: string): Promise<CryptoKey> {
    if (!keys.has(kid) && now() - fetchedAt >= REFRESH_MIN_MS) await refresh();
    const key = keys.get(kid);
    if (!key) throw new AuthError('Token signed by an unknown key.');
    return key;
  }

  return async (token) => {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('Malformed token.');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('Unsupported token algorithm.');
    const key = await keyFor(header.kid);
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = decodeSegment(signaturePart);
    if (!(await crypto.subtle.verify(ALGORITHM, key, signature as BufferSource, signed as BufferSource))) throw new AuthError('Bad token signature.');
    const claims = decodeJson(payloadPart);
    const seconds = now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp <= seconds - skew) throw new AuthError('Token expired.');
    if (typeof claims.nbf === 'number' && claims.nbf > seconds + skew) throw new AuthError('Token not yet valid.');
    if (parties.length && typeof claims.azp === 'string' && !parties.includes(claims.azp)) throw new AuthError('Token issued for another site.');
    if (typeof claims.sub !== 'string' || claims.sub === '') throw new AuthError('Token has no subject.');
    return { sub: claims.sub };
  };
}

/** The instance's public keys from Clerk's Backend API, authenticated with the secret key (which never leaves the server). */
export function clerkJwks(secretKey: string, fetchImpl: typeof fetch = fetch): JwksSource {
  return async () => {
    const response = await fetchImpl('https://api.clerk.com/v1/jwks', { headers: { Authorization: `Bearer ${secretKey}` } });
    if (!response.ok) throw new Error(`Clerk JWKS request failed: ${response.status}`);
    const body = (await response.json()) as { keys?: PublicJwk[] };
    return Array.isArray(body.keys) ? body.keys : [];
  };
}

import type { PublicJwk } from './auth';

/** A locally generated RS256 key standing in for Clerk's: signs tokens and serves its own JWKS. Tests only. */
export async function createTestSigner(kid = `kid-${Math.random().toString(36).slice(2)}`) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' } as PublicJwk;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    kid,
    jwks: async (): Promise<readonly PublicJwk[]> => [publicJwk],
    async sign(claims: Record<string, unknown>): Promise<string> {
      const body = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(claims)}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(body));
      return `${body}.${Buffer.from(signature).toString('base64url')}`;
    },
  };
}

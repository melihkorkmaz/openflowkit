// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createJwtVerifier, type PublicJwk } from './auth';
import { createTestSigner } from './testSigner';

const NOW = 1_700_000_000_000;

describe('createJwtVerifier', () => {
  it('accepts a live token and returns its subject', async () => {
    const signer = await createTestSigner();
    const verify = createJwtVerifier({ jwks: signer.jwks, now: () => NOW });
    await expect(verify(await signer.sign({ sub: 'user_1', exp: NOW / 1000 + 60 }))).resolves.toEqual({ sub: 'user_1' });
  });

  it.each([
    ['expired', { sub: 'user_1', exp: NOW / 1000 - 60 }, /expired/],
    ['not yet valid', { sub: 'user_1', exp: NOW / 1000 + 60, nbf: NOW / 1000 + 60 }, /not yet valid/],
    ['without exp', { sub: 'user_1' }, /expired/],
    ['without sub', { exp: NOW / 1000 + 60 }, /subject/],
    ['for another site', { sub: 'user_1', exp: NOW / 1000 + 60, azp: 'https://evil.example' }, /another site/],
  ])('rejects a token %s', async (_name, claims, message) => {
    const signer = await createTestSigner();
    const verify = createJwtVerifier({ jwks: signer.jwks, now: () => NOW, authorizedParties: ['https://app.example'] });
    await expect(verify(await signer.sign(claims))).rejects.toThrow(message);
  });

  it('rejects a token signed by a key outside the JWKS, and a tampered payload', async () => {
    const trusted = await createTestSigner();
    const stranger = await createTestSigner(trusted.kid);
    const verify = createJwtVerifier({ jwks: trusted.jwks, now: () => NOW });
    await expect(verify(await stranger.sign({ sub: 'user_1', exp: NOW / 1000 + 60 }))).rejects.toThrow(/signature/);
    const [header, , signature] = (await trusted.sign({ sub: 'user_1', exp: NOW / 1000 + 60 })).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: NOW / 1000 + 60 })).toString('base64url');
    await expect(verify(`${header}.${forged}.${signature}`)).rejects.toThrow(/signature/);
  });

  it('rejects alg none and garbage', async () => {
    const signer = await createTestSigner();
    const verify = createJwtVerifier({ jwks: signer.jwks, now: () => NOW });
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: signer.kid })).toString('base64url')}.${Buffer.from('{"sub":"x","exp":9999999999}').toString('base64url')}.`;
    await expect(verify(none)).rejects.toThrow(/algorithm/);
    await expect(verify('not-a-jwt')).rejects.toThrow(/Malformed/);
  });

  it('refetches the keys for an unknown kid at most once per 30 s', async () => {
    const signer = await createTestSigner();
    let fetches = 0;
    let keys: readonly PublicJwk[] = [];
    let now = NOW;
    const verify = createJwtVerifier({ jwks: async () => { fetches += 1; return keys; }, now: () => now });
    const token = await signer.sign({ sub: 'user_1', exp: NOW / 1000 + 600 });
    await expect(verify(token)).rejects.toThrow(/unknown key/);
    keys = await signer.jwks();
    await expect(verify(token)).rejects.toThrow(/unknown key/);
    expect(fetches).toBe(1);
    now += 30_000;
    await expect(verify(token)).resolves.toEqual({ sub: 'user_1' });
    expect(fetches).toBe(2);
  });
});

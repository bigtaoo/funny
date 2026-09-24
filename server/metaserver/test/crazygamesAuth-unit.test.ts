// Unit coverage for src/crazygamesAuth.ts — RS256 verification of the CrazyGames SDK user token
// (RETENTION_LAUNCH_PLAN.md §1.1/§3.1). No network: a real RSA keypair is generated in-process and
// injected via __setPublicKeyForTest, so every case (valid / expired / wrong key / wrong gameId /
// missing userId) is driven directly against jsonwebtoken, matching the exact verify call the
// production code makes (RS256, no other algorithm accepted).
import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyCrazyGamesToken, CrazyGamesAuthError, __setPublicKeyForTest } from '../src/crazygamesAuth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const OTHER_KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function sign(payload: Record<string, unknown>, opts: jwt.SignOptions = {}, key = privateKey): string {
  return jwt.sign(payload, key, { algorithm: 'RS256', ...opts });
}

const CFG = { gameId: 'nw-crazygames-prod' };

describe('verifyCrazyGamesToken', () => {
  beforeEach(() => {
    __setPublicKeyForTest(publicKey); // pre-warm the module cache with the real key for most cases
  });

  it('valid token, matching gameId → returns the decoded payload', async () => {
    const token = sign({ userId: 'cg-user-1', gameId: CFG.gameId, username: 'Ola' });
    const payload = await verifyCrazyGamesToken(token, CFG);
    expect(payload.userId).toBe('cg-user-1');
    expect(payload.gameId).toBe(CFG.gameId);
    expect(payload.username).toBe('Ola');
  });

  it('gameId mismatch (token minted for a different game on the portal) → rejected', async () => {
    const token = sign({ userId: 'cg-user-1', gameId: 'some-other-game' });
    await expect(verifyCrazyGamesToken(token, CFG)).rejects.toThrow(CrazyGamesAuthError);
  });

  it('missing userId → rejected', async () => {
    const token = sign({ gameId: CFG.gameId });
    await expect(verifyCrazyGamesToken(token, CFG)).rejects.toThrow(CrazyGamesAuthError);
  });

  it('expired token → rejected', async () => {
    const token = sign({ userId: 'cg-user-1', gameId: CFG.gameId }, { expiresIn: -10 });
    await expect(verifyCrazyGamesToken(token, CFG)).rejects.toThrow(CrazyGamesAuthError);
  });

  it('signed with a different key (not the real CrazyGames one) → rejected, not silently accepted', async () => {
    const token = sign({ userId: 'cg-user-1', gameId: CFG.gameId }, {}, OTHER_KEYS.privateKey);
    await expect(verifyCrazyGamesToken(token, CFG)).rejects.toThrow(CrazyGamesAuthError);
  });

  it('garbage string → rejected (not a thrown TypeError leaking past the handler)', async () => {
    await expect(verifyCrazyGamesToken('not-a-jwt', CFG)).rejects.toThrow(CrazyGamesAuthError);
  });

  it('stale cached key that no longer verifies → one retry with a fresh fetch succeeds', async () => {
    // Simulate "the module cached a stale/wrong key from before a rotation": seed it with the WRONG
    // key, then have the retry's fetch return the RIGHT one. This exercises the one-retry path
    // without a real network call.
    __setPublicKeyForTest(OTHER_KEYS.publicKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ publicKey }), { status: 200 })) as typeof fetch;
    try {
      const token = sign({ userId: 'cg-user-1', gameId: CFG.gameId });
      const payload = await verifyCrazyGamesToken(token, CFG);
      expect(payload.userId).toBe('cg-user-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('public key fetch fails on both the cold-start attempt and the retry → rejected, not thrown raw', async () => {
    __setPublicKeyForTest(undefined); // force a cold-start fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
    try {
      const token = sign({ userId: 'cg-user-1', gameId: CFG.gameId });
      await expect(verifyCrazyGamesToken(token, CFG)).rejects.toThrow(CrazyGamesAuthError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

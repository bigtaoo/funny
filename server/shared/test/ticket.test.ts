// Unit tests for ticket.ts's signTicket/verifyTicket (match ticket HMAC-JWT).
import { describe, it, expect } from 'vitest';
import jwtLib from 'jsonwebtoken';
import { signTicket, verifyTicket, type TicketClaims } from '../src/ticket';

const cfg = { key: 'test-internal-key' };

const baseClaims: TicketClaims = {
  roomId: 'room-1',
  seed: 42,
  side: 0,
  mode: 'ranked',
  opponent: 'Bob',
  opponentPublicId: '000000001',
  gameUrl: 'wss://game.example.com',
  accountId: 'acc-1',
};

describe('signTicket / verifyTicket', () => {
  it('round-trips all required claim fields', () => {
    const token = signTicket(baseClaims, cfg);
    const decoded = verifyTicket(token, cfg);
    expect(decoded.roomId).toBe('room-1');
    expect(decoded.seed).toBe(42);
    expect(decoded.side).toBe(0);
    expect(decoded.mode).toBe('ranked');
    expect(decoded.opponent).toBe('Bob');
    expect(decoded.opponentPublicId).toBe('000000001');
    expect(decoded.gameUrl).toBe('wss://game.example.com');
    expect(decoded.accountId).toBe('acc-1');
  });

  it('round-trips optional fields when present (opponentTitle/opponentAvatarId/opponentSkins/decks)', () => {
    const claims: TicketClaims = {
      ...baseClaims,
      side: 1,
      opponentTitle: 'champion',
      opponentAvatarId: 'hero:1',
      opponentSkins: ['skin1', 'skin2'],
      decks: { top: ['c1', 'c2'], bottom: ['c3', 'c4'] },
    };
    const token = signTicket(claims, cfg);
    const decoded = verifyTicket(token, cfg);
    expect(decoded.side).toBe(1);
    expect(decoded.opponentTitle).toBe('champion');
    expect(decoded.opponentAvatarId).toBe('hero:1');
    expect(decoded.opponentSkins).toEqual(['skin1', 'skin2']);
    expect(decoded.decks).toEqual({ top: ['c1', 'c2'], bottom: ['c3', 'c4'] });
  });

  it('verify with a different key throws', () => {
    const token = signTicket(baseClaims, cfg);
    expect(() => verifyTicket(token, { key: 'wrong-key' })).toThrow();
  });

  it('default ttlSec is 30s (token includes an exp roughly 30s out)', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signTicket(baseClaims, cfg);
    const decoded = jwtLib.decode(token) as { exp: number };
    expect(decoded.exp).toBeGreaterThanOrEqual(before + 29);
    expect(decoded.exp).toBeLessThanOrEqual(before + 31);
  });

  it('ignoreExpiration:false (default) rejects an expired-but-validly-signed token', () => {
    const expired = jwtLib.sign({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 10 }, cfg.key);
    expect(() => verifyTicket(expired, cfg)).toThrow();
  });

  it('ignoreExpiration:true accepts an expired-but-validly-signed token', () => {
    const expired = jwtLib.sign({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 10 }, cfg.key);
    const decoded = verifyTicket(expired, cfg, { ignoreExpiration: true });
    expect(decoded.roomId).toBe('room-1');
  });

  it('throws "invalid ticket payload" when roomId is not a string', () => {
    const bad = jwtLib.sign({ ...baseClaims, roomId: 12345 }, cfg.key, { expiresIn: 30 });
    expect(() => verifyTicket(bad, cfg)).toThrow('invalid ticket payload');
  });

  it('throws "invalid ticket payload" when seed is not a number', () => {
    const bad = jwtLib.sign({ ...baseClaims, seed: 'not-a-number' }, cfg.key, { expiresIn: 30 });
    expect(() => verifyTicket(bad, cfg)).toThrow('invalid ticket payload');
  });

  it('throws "invalid ticket payload" when side is neither 0 nor 1', () => {
    const bad = jwtLib.sign({ ...baseClaims, side: 2 }, cfg.key, { expiresIn: 30 });
    expect(() => verifyTicket(bad, cfg)).toThrow('invalid ticket payload');
  });

  it('throws "invalid ticket payload" when the decoded payload is a plain string', () => {
    const bad = jwtLib.sign('just-a-string', cfg.key);
    expect(() => verifyTicket(bad, cfg)).toThrow('invalid ticket payload');
  });
});

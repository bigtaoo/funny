import { describe, it, expect } from 'vitest';
import { BotApiError, envelopeError, hasCode } from '../src/apiError';

describe('envelopeError', () => {
  it('{code, message} keeps both', () => {
    const e = envelopeError({ code: 'FAMILY_FULL', message: 'family is full' }, 'fallback');
    expect(e).toBeInstanceOf(BotApiError);
    expect(e.code).toBe('FAMILY_FULL');
    expect(e.message).toBe('FAMILY_FULL: family is full');
  });

  it('the older bare-string form becomes the code', () => {
    expect(envelopeError('NOT_FOUND', 'fallback').code).toBe('NOT_FOUND');
  });

  it('a code without a message repeats the code; a message without a code is UNKNOWN', () => {
    expect(envelopeError({ code: 'SECT_FULL' }, 'fallback').message).toBe('SECT_FULL: SECT_FULL');
    const e = envelopeError({ message: 'boom' }, 'fallback');
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('UNKNOWN: boom');
  });

  it('no error at all falls back to the caller description', () => {
    const e = envelopeError(undefined, 'GET /social/family/mine failed');
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('UNKNOWN: GET /social/family/mine failed');
  });
});

describe('hasCode', () => {
  it('matches any of the given codes on a BotApiError', () => {
    const e = new BotApiError('ALREADY_REQUESTED', 'x');
    expect(hasCode(e, 'FAMILY_FULL', 'ALREADY_REQUESTED')).toBe(true);
    expect(hasCode(e, 'FAMILY_FULL')).toBe(false);
  });

  it('never matches a plain Error, even one whose message is the code', () => {
    expect(hasCode(new Error('FAMILY_FULL'), 'FAMILY_FULL')).toBe(false);
    expect(hasCode(undefined, 'FAMILY_FULL')).toBe(false);
  });
});

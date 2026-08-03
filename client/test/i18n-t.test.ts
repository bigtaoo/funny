// Regression coverage for t()'s param interpolation (client/src/i18n/index.ts).
//
// 2026-08-03 fix: the previous implementation substituted params sequentially via
// `s.split('{k}').join(String(v))`, one param at a time. If an earlier param's *value* happened to
// contain the literal text of a later param's placeholder (e.g. a player-chosen display name
// containing "{secs}"), the later substitution pass would re-match and overwrite that literal text
// inside the already-substituted value — corrupting player-controlled data that just happened to
// collide with the template's own placeholder syntax. t() now does a single regex pass so a
// substituted value is never rescanned.
import { describe, it, expect, beforeEach } from 'vitest';
import { initI18n, setLocale, t } from '../src/i18n';

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
};

describe('t() param interpolation', () => {
  beforeEach(() => {
    initI18n('en', memStore(), ['zh', 'en', 'de']);
    setLocale('en');
  });

  it('substitutes a single param', () => {
    expect(t('net.reconnecting')).toBeTypeOf('string');
    // Use a real templated key with a known param name.
    expect(t('event.rewards.coins', { n: 5 })).toBe('+5 coins');
  });

  it('regression: a param value containing another placeholder\'s literal text is inserted verbatim, not re-substituted', () => {
    // friends.duelInviteBanner is '{name} challenged you to a duel ({secs}s)' in en — a real
    // two-param template where `name` is player-controlled (display names allow '{'/'}', only
    // length-capped).
    const msg = t('friends.duelInviteBanner', { name: '{secs}', secs: 42 });
    // The crafted name should survive intact; only the real `{secs}` placeholder should become 42.
    expect(msg).toBe('{secs} challenged you to a duel (42s)');
  });

  it('regression: a param value containing its OWN placeholder syntax does not cause infinite/re-substitution', () => {
    const msg = t('event.rewards.coins', { n: '{n}' as unknown as number });
    // The literal string "{n}" is inserted once verbatim, not recursively re-expanded.
    expect(msg).toBe('+{n} coins');
  });

  it('leaves an unhandled placeholder (no matching param) untouched, for callers that chain manual .replace() afterward', () => {
    const s = t('equip.confirmReforge', { coins: 100 });
    // {target}/{material} are not in params — must remain literal so a caller's .replace() still works.
    expect(s).toContain('{target}');
    expect(s).toContain('{material}');
    expect(s).toContain('100');
  });

  it('order of params in the object does not matter', () => {
    const a = t('friends.duelInviteBanner', { name: 'Alice', secs: 10 });
    const b = t('friends.duelInviteBanner', { secs: 10, name: 'Alice' });
    expect(a).toBe(b);
  });
});

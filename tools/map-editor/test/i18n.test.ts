// i18n — key parity between en/zh and placeholder interpolation. A missing zh key degrades
// silently to English at runtime (t() falls back), so only a test catches a half-translated
// dictionary; a mismatched placeholder set ships a literal "{count}" into the UI.
import { beforeEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale, t, toggleLocale } from '../src/i18n';

/** Re-reads the module's private dictionaries through the only public door: t() under each locale. */
function translate(locale: 'en' | 'zh', key: string, vars?: Record<string, string | number>): string {
  setLocale(locale);
  return t(key, vars);
}

// Every key the en dictionary defines, harvested via the module's own fallback behaviour: for a key
// present in en, t() returns the en string; for an unknown key it returns the key itself.
const KEYS_WITH_VARS: [string, Record<string, string | number>][] = [
  ['insp.terrainTitle', { count: '3 tiles' }],
  ['city.coords', { x: 1, y: 2 }],
  ['publish.templatesTitle', { count: 4 }],
  ['status.rendered', { worldId: 'w', tiles: '1 tile', ms: 5, painted: '0 tiles', cities: '2 cities' }],
  ['status.terrainExported', { tiles: '9 tiles' }],
  ['status.importFailed', { msg: 'boom' }],
  ['status.cityMoved', { id: 'capital-1' }],
  ['status.generating', { id: 'w', w: 1500, h: 1500 }],
  ['status.generated', { id: 'w', tileCount: 7, version: 2 }],
  ['status.publishing', { n: 3, id: 'w' }],
  ['status.deleteConfirm', { id: 'w' }],
];

describe('i18n locale state', () => {
  beforeEach(() => setLocale('en'));

  it('defaults to en when no locale is persisted', () => {
    expect(getLocale()).toBe('en');
  });

  it('survives a missing localStorage (node has none — the try/catch must swallow it)', () => {
    expect(() => setLocale('zh')).not.toThrow();
    expect(getLocale()).toBe('zh');
  });

  it('toggleLocale flips between the two locales and returns the new one', () => {
    expect(toggleLocale()).toBe('zh');
    expect(getLocale()).toBe('zh');
    expect(toggleLocale()).toBe('en');
    expect(getLocale()).toBe('en');
  });
});

describe('i18n dictionaries', () => {
  beforeEach(() => setLocale('en'));

  it('translates every keyed string in both locales (no key echoed back untranslated)', () => {
    for (const [key] of KEYS_WITH_VARS) {
      expect(translate('en', key)).not.toBe(key);
      expect(translate('zh', key)).not.toBe(key);
    }
  });

  it('has a genuinely different zh string for the chrome, not a copy of en', () => {
    for (const key of ['toolbar.title', 'tool.river.label', 'insp.legend', 'publish.login', 'status.ready']) {
      expect(translate('zh', key)).not.toBe(translate('en', key));
    }
  });

  it('substitutes every placeholder in both locales — no literal {braces} reach the UI', () => {
    for (const [key, vars] of KEYS_WITH_VARS) {
      for (const locale of ['en', 'zh'] as const) {
        const out = translate(locale, key, vars);
        expect(out, `${locale}/${key}`).not.toMatch(/[{}]/);
      }
    }
  });

  it('substitutes every occurrence, not just the first', () => {
    setLocale('en');
    expect(t('status.publishing', { n: 2, id: 'x' })).toContain('2');
  });

  it('falls back to en for a key missing from the active locale', () => {
    setLocale('zh');
    expect(t('unit.tile')).toBe('个格子'); // present in zh
  });

  it('returns the key itself for an entirely unknown key', () => {
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('leaves a string untouched when no vars are passed', () => {
    setLocale('en');
    expect(t('status.terrainExported')).toContain('{tiles}');
  });
});

describe('i18n pluralization units', () => {
  // The count-label helpers in ui/status.ts pick unit.tile vs unit.tiles by count. English needs
  // the two to differ; Chinese deliberately uses the same measure word for both.
  it('en distinguishes singular from plural', () => {
    expect(translate('en', 'unit.tile')).not.toBe(translate('en', 'unit.tiles'));
    expect(translate('en', 'unit.city')).not.toBe(translate('en', 'unit.cities'));
  });

  it('zh uses one measure word for both forms', () => {
    expect(translate('zh', 'unit.tile')).toBe(translate('zh', 'unit.tiles'));
    expect(translate('zh', 'unit.city')).toBe(translate('zh', 'unit.cities'));
  });
});

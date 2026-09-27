// SettingsScene's two toggle rows in the "General" section: the data saver (ASSET_PACKAGING §14) and
// the analytics consent (COMPLIANCE_GLOBAL §3.3, GDPR Art 7(3)).
//
// Until the flow-layout rewrite (UI_DESIGN_LOG_2026-09 §65) the interesting question was whether the
// rows FIT — every section sat at a hand-tuned fraction of h, and the two toggles had to share one
// row split in half. That question is gone; what is left worth asserting is that each toggle
// renders its state, flips it through its REAL hit rect (a toggle wired to a rect that is never
// registered looks completely correct in a screenshot), and lines up with the other controls.
import { describe, it, expect, afterEach } from 'vitest';
import { initI18n, t, setLocale } from '../../src/i18n';
import { installPrefetchPolicy, resetPrefetchPolicyForTest, isDataSaverEnabled } from '../../src/assets/prefetchPolicy';
import type { IStorage } from '../../src/platform/IPlatform';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import { buildSettings, collectTexts, controlHit, ONLINE } from '../harness/settingsScene';

initI18n('en');

function memStorage(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

function fresh(storage: IStorage = memStorage()): IStorage {
  resetPrefetchPolicyForTest();
  installPrefetchPolicy({ storage });
  return storage;
}

const texts = (s: ReturnType<typeof buildSettings>): string[] => collectTexts(s.container).map((n) => n.text);

afterEach(() => { resetPrefetchPolicyForTest(); setLocale('en'); });

describe('SettingsScene — data-saver row', () => {
  it('renders the label, the toggle state and the explanation', () => {
    fresh();
    const all = texts(buildSettings(800, 1280));
    expect(all).toContain(t('settings.dataSaver'));
    expect(all).toContain(t('settings.dataSaverOff')); // default: not enabled
    expect(all).toContain(t('settings.dataSaverHint'));
  });

  it('reads the toggle state back out of storage', () => {
    const storage = memStorage();
    storage.setItem('nw_data_saver', '1');
    fresh(storage);
    expect(isDataSaverEnabled()).toBe(true);
    expect(texts(buildSettings(800, 1280))).toContain(t('settings.dataSaverOn'));
  });

  it.each([[800, 1280], [1280, 800], [360, 640]])('turns the setting on through the real hit rect, and redraws showing it (%ix%i)', (w, h) => {
    const storage = fresh();
    const s = buildSettings(w, h);
    controlHit(s, t('settings.dataSaver')).fn();
    expect(isDataSaverEnabled()).toBe(true);
    expect(storage.getItem('nw_data_saver')).toBe('1');
    // The tap re-renders, so the label must now read "On" — a toggle that flips state but keeps
    // showing the old one reads as broken and gets tapped again.
    expect(texts(s)).toContain(t('settings.dataSaverOn'));
  });

  it('turns it back off, clearing the key rather than storing a falsy string', () => {
    const storage = fresh();
    const s = buildSettings(800, 1280);
    controlHit(s, t('settings.dataSaver')).fn();
    controlHit(s, t('settings.dataSaver')).fn();
    expect(isDataSaverEnabled()).toBe(false);
    // Not `'0'`: a key left behind is one more thing to reason about, and setDataSaverEnabled
    // documents removal.
    expect(storage.getItem('nw_data_saver')).toBeNull();
    expect(texts(s)).toContain(t('settings.dataSaverOff'));
  });

  it('survives a round trip through a fresh policy install (it is persisted, not in-memory)', () => {
    const storage = fresh();
    controlHit(buildSettings(800, 1280), t('settings.dataSaver')).fn();
    fresh(storage); // new session, same storage
    expect(isDataSaverEnabled()).toBe(true);
  });
});

describe('SettingsScene — analytics-consent row', () => {
  const withConsent = (get: () => boolean, set: (v: boolean) => void = () => {}): Partial<SettingsSceneCallbacks> =>
    ({ ...ONLINE, getAnalyticsConsent: get, onSetAnalyticsConsent: set });

  it('is absent when the host supplies no consent callbacks (the headless harnesses)', () => {
    fresh();
    expect(texts(buildSettings(800, 1280))).not.toContain(t('settings.analytics'));
  });

  it.each([[true, 'settings.analyticsOn'], [false, 'settings.analyticsOff']] as const)(
    'shows the state the host reports (%s)', (on, key) => {
      fresh();
      const all = texts(buildSettings(800, 1280, withConsent(() => on)));
      expect(all).toContain(t('settings.analytics'));
      expect(all).toContain(t(key));
    },
  );

  it('flips the value through the real hit rect, and redraws showing it', () => {
    fresh();
    let granted = false;
    const s = buildSettings(800, 1280, withConsent(() => granted, (v) => { granted = v; }));
    controlHit(s, t('settings.analytics')).fn();
    expect(granted).toBe(true);
    expect(texts(s)).toContain(t('settings.analyticsOn'));
  });

  // The row layout's promise: every control is flush with ONE right edge, whatever the locale or
  // shape. This is what the old half-and-half row could not keep (its two toggles ended at 0.46w
  // and 0.94w), and it is the alignment the whole screen reads by.
  it.each([[800, 1280], [1920, 855], [360, 640]])('keeps both toggles on one right edge, and inside the design rect (%ix%i)', (w, h) => {
    for (const locale of ['zh', 'en', 'de'] as const) {
      setLocale(locale);
      fresh();
      const s = buildSettings(w, h, withConsent(() => false));
      const [a, b] = [t('settings.dataSaver'), t('settings.analytics')].map((label) => controlHit(s, label).rect);
      expect(Math.abs((a!.x + a!.w) - (b!.x + b!.w)), `${locale}: the toggles end at different x`).toBeLessThanOrEqual(1);
      expect(a!.x + a!.w, `${locale}: the toggle runs off the page`).toBeLessThanOrEqual(s.w);
    }
  });
});

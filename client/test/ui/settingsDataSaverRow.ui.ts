// SettingsScene's data-saver toggle (ASSET_PACKAGING §14) — the player-owned "don't prefetch"
// switch, and specifically whether it FITS.
//
// This scene positions every section at a hand-tuned fraction of h (profile at the top, language at
// 0.48, Help/Account at 0.73) with no scrolling and no flow layout, so a new section does not get
// pushed out of the way when it collides — it silently draws on top of its neighbours. The row was
// squeezed into the gap between the language buttons and the Help/Account labels, which is why the
// interesting assertion is geometric rather than "does the label exist".
//
// Screenshots were not available while this was written (the Browser pane was not displaying), and
// this is the better check anyway: it covers several viewport shapes at once, and it keeps covering
// them every CI run instead of once.
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t, setLocale, type Locale } from '../../src/i18n';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import { installPrefetchPolicy, resetPrefetchPolicyForTest, isDataSaverEnabled } from '../../src/assets/prefetchPolicy';
import type { IStorage } from '../../src/platform/IPlatform';
import { createFakeTextInput } from '../harness/fakeTextInput';
import type { Hit } from '../../src/ui/hits';

initI18n('en');

function memStorage(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

interface Node { text: string; top: number; bottom: number; left: number; right: number }

function collect(root: PIXI.Container): Node[] {
  const out: Node[] = [];
  // No `children ?? []` fallback on purpose: handed the wrong object this must throw, not quietly
  // return an empty tree that every assertion then reads as "the row is missing".
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) {
        const b = ch.getBounds();
        out.push({ text: ch.text, top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width });
        continue;
      }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function find(nodes: Node[], text: string): Node {
  const hit = nodes.find((n) => n.text === text);
  if (!hit) throw new Error(`no text node "${text}" (have: ${nodes.map((n) => n.text).join(' | ')})`);
  return hit;
}

/**
 * The scene's rendered container — collect() walks a PIXI tree, not the scene wrapper.
 *
 * `analytics` supplies the consent pair that makes the second toggle appear. Left out by default
 * so the pre-existing data-saver assertions keep measuring the row on its own.
 */
function build(w: number, h: number, analytics?: boolean): PIXI.Container {
  return new SettingsScene(createLayout(w, h), new InputManager(), {
    onBack() {},
    ...(analytics === undefined ? {} : {
      getAnalyticsConsent: () => analytics,
      onSetAnalyticsConsent: () => {},
    }),
    playerName: 'Tester',
    publicId: '123456789',
    pvp: { rank: 'bronze', elo: 1000 },
    renameCost: 500,
    getCoins: () => 0,
    onRename: async (name: string) => ({ ok: true, name }),
    onReplayTutorial() {},
    onLogout() {},
    openTextInput: createFakeTextInput().openTextInput,
  }).container;
}

describe('SettingsScene — data-saver row', () => {
  it('renders the label, the toggle state and the explanation', () => {
    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage: memStorage() });
    const texts = collect(build(800, 1280)).map((n) => n.text);
    expect(texts).toContain(t('settings.dataSaver'));
    expect(texts).toContain(t('settings.dataSaverOff')); // default: not enabled
    expect(texts).toContain(t('settings.dataSaverHint'));
    resetPrefetchPolicyForTest();
  });

  it('reads the toggle state back out of storage', () => {
    resetPrefetchPolicyForTest();
    const storage = memStorage();
    storage.setItem('nw_data_saver', '1');
    installPrefetchPolicy({ storage });
    expect(isDataSaverEnabled()).toBe(true);
    expect(collect(build(800, 1280)).map((n) => n.text)).toContain(t('settings.dataSaverOn'));
    resetPrefetchPolicyForTest();
  });

  // The one that actually guards the layout. Runs the shapes the game really sees: tall portrait
  // phone, short landscape, and a squat desktop window — the last is the worst case, because every
  // section's y is a fraction of h and the gaps shrink with it.
  it.each([[800, 1280], [1280, 800], [1024, 640], [412, 915]])(
    'sits between the language buttons and Help/Account without overlapping either (%ix%i)',
    (w, h) => {
      resetPrefetchPolicyForTest();
      installPrefetchPolicy({ storage: memStorage() });
      const nodes = collect(build(w, h));

      const localeButton = find(nodes, 'English');   // the language row's own buttons
      const saverLabel   = find(nodes, t('settings.dataSaver'));
      const saverToggle  = find(nodes, t('settings.dataSaverOff'));
      const saverHint    = find(nodes, t('settings.dataSaverHint'));
      const help         = find(nodes, t('settings.help'));
      const account      = find(nodes, t('settings.account'));

      const rowTop = Math.min(saverLabel.top, saverToggle.top);
      const rowBottom = Math.max(saverHint.bottom, saverToggle.bottom);

      expect(rowTop, 'data-saver row overlaps the language buttons above it')
        .toBeGreaterThan(localeButton.bottom);
      expect(rowBottom, 'data-saver row overlaps the Help/Account labels below it')
        .toBeLessThan(Math.min(help.top, account.top));
      resetPrefetchPolicyForTest();
    },
  );

  // The hint is a full sentence and the row is width-constrained by the toggle sitting beside it,
  // so it is the piece most likely to grow past its space when a locale is wordier than English.
  it.each<Locale>(['zh', 'en', 'de'])('keeps the row inside its gap in %s', (locale) => {
    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage: memStorage() });
    setLocale(locale);
    try {
      const nodes = collect(build(800, 1280));
      const rowBottom = Math.max(
        find(nodes, t('settings.dataSaverHint')).bottom,
        find(nodes, t('settings.dataSaverOff')).bottom,
      );
      expect(rowBottom).toBeLessThan(Math.min(find(nodes, t('settings.help')).top, find(nodes, t('settings.account')).top));
    } finally {
      setLocale('en');
      resetPrefetchPolicyForTest();
    }
  });
});

/**
 * The toggle's click path. The row above only proves it RENDERS the current state; nothing so far
 * proves tapping it changes anything — and a toggle wired to a hit rect that is never registered,
 * or registered at the wrong coordinates, looks completely correct in a screenshot.
 *
 * Driven through the scene's real `hits` list rather than by calling `setDataSaverEnabled`
 * directly, so the rect's position is part of what is asserted.
 */
describe('SettingsScene — data-saver toggle click', () => {
  /** Build a scene (not just its container) plus the storage its toggle writes to. */
  function scene(): { s: SettingsScene; storage: IStorage } {
    const storage = memStorage();
    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage });
    const s = new SettingsScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, playerName: 'Tester', publicId: '1', pvp: { rank: 'bronze', elo: 1 },
      renameCost: 500, getCoins: () => 0, onRename: async (n: string) => ({ ok: true, name: n }),
      onReplayTutorial() {}, onLogout() {},
      openTextInput: createFakeTextInput().openTextInput,
    });
    return { s, storage };
  }

  /** The hit whose rect covers the toggle button, found the way a tap would find it. */
  function toggleHit(s: SettingsScene): () => void {
    const label = collect(s.container).find((n) => n.text === t('settings.dataSaver'));
    expect(label, 'data-saver label missing').toBeDefined();
    const midY = (label!.top + label!.bottom) / 2;
    // The toggle sits to the RIGHT of the label but still in the row's LEFT HALF: since 2026-09-21
    // the analytics toggle shares this row and owns everything past 0.56w, so an unbounded
    // "further right than the label" search would find that one instead the moment it is drawn.
    const hit = s.hits.find((h) => h.rect.y <= midY && midY <= h.rect.y + h.rect.h
      && h.rect.x > label!.right && h.rect.x < 800 * 0.5);
    expect(hit, `no hit rect on the data-saver row (rects: ${JSON.stringify(s.hits.map((x) => x.rect))})`).toBeDefined();
    return hit!.fn;
  }

  afterEach(() => resetPrefetchPolicyForTest());

  it('turns the setting on, and the row redraws showing it', () => {
    const { s, storage } = scene();
    expect(isDataSaverEnabled()).toBe(false);

    toggleHit(s)();

    expect(isDataSaverEnabled()).toBe(true);
    expect(storage.getItem('nw_data_saver')).toBe('1');
    // The tap re-renders, so the label must now read "On" — a toggle that flips state but keeps
    // showing the old one reads as broken and gets tapped again.
    expect(collect(s.container).map((n) => n.text)).toContain(t('settings.dataSaverOn'));
  });

  it('turns it back off, clearing the key rather than storing a falsy string', () => {
    const { s, storage } = scene();
    toggleHit(s)();
    toggleHit(s)();

    expect(isDataSaverEnabled()).toBe(false);
    // Not `'0'`: isDataSaverEnabled() compares against '1', so a stored '0' would read as off too
    // and this would pass either way — but a key left behind is one more thing to reason about,
    // and setDataSaverEnabled documents removal.
    expect(storage.getItem('nw_data_saver')).toBeNull();
    expect(collect(s.container).map((n) => n.text)).toContain(t('settings.dataSaverOff'));
  });

  it('survives a round trip through a fresh policy install (it is persisted, not in-memory)', () => {
    const { s, storage } = scene();
    toggleHit(s)();

    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage }); // new session, same storage
    expect(isDataSaverEnabled()).toBe(true);
  });
});

/**
 * The analytics-consent toggle that shares this row (COMPLIANCE_GLOBAL §3.3, GDPR Art 7(3)).
 *
 * Why it is here and not on a row of its own: there is no row of its own left. Everything from the
 * profile card down to the viewport readout is pinned to a fraction of h, the language buttons run
 * to 0.84w (so "the right column" does not exist at that height), and the first attempt — a
 * separate row at 0.56h — drew the label straight through the "Deutsch" button. Sharing the
 * data-saver row was the only placement that did not push another section around, and it splits
 * the width in half, which is exactly the geometry a longer locale breaks.
 */
describe('SettingsScene — analytics-consent toggle', () => {
  afterEach(() => resetPrefetchPolicyForTest());

  /** A rendered scene with the analytics pair supplied, plus its text nodes. */
  function built(w: number, h: number, on: boolean): { s: SettingsScene; ns: Node[] } {
    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage: memStorage() });
    const s = new SettingsScene(createLayout(w, h), new InputManager(), {
      onBack() {}, playerName: 'Tester', publicId: '1', pvp: { rank: 'bronze', elo: 1 },
      onReplayTutorial() {}, onLogout() {},
      getAnalyticsConsent: () => on,
      onSetAnalyticsConsent: () => {},
      openTextInput: createFakeTextInput().openTextInput,
    });
    return { s, ns: collect(s.container) };
  }

  /**
   * The two toggle BOXES on the shared row, left one first.
   *
   * Found through the scene's hit rects rather than by their labels, because the labels are not
   * unique: zh renders both as 已关闭 / 已开启, so a text lookup silently returns the data saver's
   * node for both halves and the overlap assertion below compares a node with itself.
   */
  function rowToggles(s: SettingsScene, ns: Node[]): [Hit['rect'], Hit['rect']] {
    const label = find(ns, t('settings.analytics'));
    const midY = (label.top + label.bottom) / 2;
    const onRow = s.hits.filter((hh) => hh.rect.y <= midY && midY <= hh.rect.y + hh.rect.h)
      .map((hh) => hh.rect).sort((a, b) => a.x - b.x);
    expect(onRow.length, `expected both toggles on the shared row, got ${onRow.length}`).toBe(2);
    return [onRow[0], onRow[1]];
  }

  it('is absent when the host supplies no consent callbacks (the headless harnesses)', () => {
    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage: memStorage() });
    expect(collect(build(800, 1280)).map((n) => n.text)).not.toContain(t('settings.analytics'));
  });

  it.each([[true, 'settings.analyticsOn'], [false, 'settings.analyticsOff']] as const)(
    'shows the state the host reports (%s)', (on, key) => {
      const texts = built(800, 1280, on).ns.map((n) => n.text);
      expect(texts).toContain(t('settings.analytics'));
      expect(texts).toContain(t(key));
    },
  );

  // The halves are 0.12…0.46w and 0.56…0.94w. Each holds a label, a right-flushed toggle and a
  // wrapped hint, and every one of those is locale-sized — so the pair is checked on the shapes
  // the game really sees, in the wordiest locale as well as English.
  it.each([[800, 1280], [1280, 800], [1024, 640], [412, 915]])(
    'never lets the two halves run into each other (%ix%i)',
    (w, h) => {
      for (const locale of ['zh', 'en', 'de'] as const) {
        setLocale(locale);
        try {
          const { s, ns } = built(w, h, false);
          const [leftBox, rightBox] = rowToggles(s, ns);
          const leftRight = Math.max(
            find(ns, t('settings.dataSaver')).right,
            find(ns, t('settings.dataSaverHint')).right,
            leftBox.x + leftBox.w,
          );
          const rightLeft = Math.min(
            find(ns, t('settings.analytics')).left,
            find(ns, t('settings.analyticsHint')).left,
            rightBox.x,
          );
          expect(leftRight, `${locale}: the data-saver half runs into the analytics half`)
            .toBeLessThanOrEqual(rightLeft);
        } finally {
          setLocale('en');
        }
      }
    },
  );

  it('keeps the analytics half clear of Help/Account below it, in every locale', () => {
    for (const locale of ['zh', 'en', 'de'] as const) {
      setLocale(locale);
      try {
        const { s, ns } = built(800, 1280, false);
        const [, rightBox] = rowToggles(s, ns);
        const bottom = Math.max(find(ns, t('settings.analyticsHint')).bottom, rightBox.y + rightBox.h);
        expect(bottom, `${locale}: the analytics hint overruns the section below`)
          .toBeLessThan(Math.min(find(ns, t('settings.help')).top, find(ns, t('settings.account')).top));
      } finally {
        setLocale('en');
      }
    }
  });

  it('flips the value through the real hit rect, and redraws showing it', () => {
    resetPrefetchPolicyForTest();
    installPrefetchPolicy({ storage: memStorage() });
    let granted = false;
    const s = new SettingsScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, playerName: 'Tester', publicId: '1', pvp: { rank: 'bronze', elo: 1 },
      onReplayTutorial() {}, onLogout() {},
      getAnalyticsConsent: () => granted,
      onSetAnalyticsConsent: (v: boolean) => { granted = v; },
      openTextInput: createFakeTextInput().openTextInput,
    });

    const label = find(collect(s.container), t('settings.analytics'));
    const midY = (label.top + label.bottom) / 2;
    const hit = s.hits.find((hh) => hh.rect.y <= midY && midY <= hh.rect.y + hh.rect.h && hh.rect.x > label.right);
    expect(hit, 'no hit rect to the right of the analytics label').toBeDefined();

    hit!.fn();

    expect(granted).toBe(true);
    expect(collect(s.container).map((n) => n.text)).toContain(t('settings.analyticsOn'));
  });
});

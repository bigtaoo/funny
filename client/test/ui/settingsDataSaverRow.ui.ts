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

initI18n('en');

function memStorage(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

interface Node { text: string; top: number; bottom: number }

function collect(root: PIXI.Container): Node[] {
  const out: Node[] = [];
  // No `children ?? []` fallback on purpose: handed the wrong object this must throw, not quietly
  // return an empty tree that every assertion then reads as "the row is missing".
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) {
        const b = ch.getBounds();
        out.push({ text: ch.text, top: b.y, bottom: b.y + b.height });
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

/** The scene's rendered container — collect() walks a PIXI tree, not the scene wrapper. */
function build(w: number, h: number): PIXI.Container {
  return new SettingsScene(createLayout(w, h), new InputManager(), {
    onBack() {},
    playerName: 'Tester',
    publicId: '123456789',
    pvp: { rank: 'bronze', elo: 1000 },
    renameCost: 500,
    getCoins: () => 0,
    onRename: async (name: string) => ({ ok: true, name }),
    onReplayTutorial() {},
    onLogout() {},
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
    });
    return { s, storage };
  }

  /** The hit whose rect covers the toggle button, found the way a tap would find it. */
  function toggleHit(s: SettingsScene): () => void {
    const label = collect(s.container).find((n) => n.text === t('settings.dataSaver'));
    expect(label, 'data-saver label missing').toBeDefined();
    const midY = (label!.top + label!.bottom) / 2;
    // The toggle sits to the RIGHT of the label on the same row (see drawDataSaver) — anything at
    // this y further left would be the label itself, which is not clickable.
    const hit = s.hits.find((h) => h.rect.y <= midY && midY <= h.rect.y + h.rect.h && h.rect.x > 800 * 0.5);
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

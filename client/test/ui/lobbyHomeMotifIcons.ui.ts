// Regression test for the lobby home-screen motifs moved onto AI raster art (batch 6, 17.08.2026):
// the hero button's crossed-pencils watermark, both pillar cards, and the rank chip.
//
// Same failure mode as lobbyBottomNavIconInk.ui.ts, one screen up: a raster icon's ink is baked at
// PACK time into three variants (white / paper-grey / ink-dark), so `buildIcon(kind, size, color)`
// can't tint — `color` only picks a variant via `tabIconVariant()`, and every one of these four call
// sites passes a colour that resolves to the WRONG variant on its own (the hero's accent blue and the
// rank chip's tier gold both read "dark" by luma but sit on a near-black fill; the world card's
// `C.light` locked accent reads "light" but sits on paper). All four therefore pass `variant`
// explicitly, and this file pins that — dropping the option is invisible in review and shows up as an
// icon that has quietly vanished into its own background.
//
// The second half pins WHICH kind each site draws, so the "reuse instead of new art" decisions don't
// silently rot back into the procedural glyphs they replaced: the rank chip is deliberately the
// leaderboard podium (the chip's tap target IS the leaderboard) rather than a 4th trophy-ish glyph,
// and the campaign/world cards must not fall back to `book`/`castle`, which are still live elsewhere
// (CityScene academy/wall, ResultScene, world-map HUD) and so can't be deleted to force the issue.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { buildIcon, type IconKind, type RasterIconVariant } from '../../src/render/icons';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene/core';

// Wrap-don't-replace, as in lobbyBottomNavIconInk.ui.ts: the real icon is still built, we only need
// to read back the arguments — the UI harness resolves every asset import to the same stubbed 1×1
// PNG, so the built sprite can't tell the three variants apart.
vi.mock('../../src/render/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/icons')>();
  return { ...actual, buildIcon: vi.fn(actual.buildIcon) };
});

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** An online lobby: offline hides both the world pillar and the rank chip. */
function buildLobby(extra: Partial<LobbySceneCallbacks> = {}): void {
  new LobbyScene(createLayout(800, 1280), new InputManager(), {
    onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
    onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
    onOpenWorld() {}, onOpenLeaderboard() {},
    pvp: { rank: 'gold', elo: 1425 },
    playerName: 'Tester',
    ...extra,
  });
}

/** The variant each of the four sites asked for, keyed by icon kind. */
function variantsByKind(): Map<IconKind, RasterIconVariant | undefined> {
  const calls = vi.mocked(buildIcon).mock.calls;
  const out = new Map<IconKind, RasterIconVariant | undefined>();
  for (const [kind, , , opts] of calls) out.set(kind, opts?.variant);
  return out;
}

function kindsDrawn(): IconKind[] {
  return vi.mocked(buildIcon).mock.calls.map(([kind]) => kind);
}

describe('lobby home-screen motifs (AI raster art, batch 6)', () => {
  it('forces the white ink for the two motifs on near-black fills', () => {
    vi.mocked(buildIcon).mockClear();
    buildLobby();
    const v = variantsByKind();
    // Hero button watermark + rank chip: both sit on `C.cover`, and neither call site's natural
    // colour argument (accent blue / tier gold) would pick the white art on its own.
    expect(v.get('duelTabIcon')).toBe('active');
    expect(v.get('leaderboardTabIcon')).toBe('active');
  });

  it('forces the full-strength ink for both pillar cards on paper', () => {
    vi.mocked(buildIcon).mockClear();
    buildLobby();
    const v = variantsByKind();
    // 'content', not the de-emphasised 'inactive' grey a paper-coloured hint would select: these are
    // the primary art on their card, not a dimmed inactive tab.
    expect(v.get('campaignTabIcon')).toBe('content');
    expect(v.get('worldTabIcon')).toBe('content');
  });

  it('drops the soft-gated world card to the de-emphasised ink', () => {
    vi.mocked(buildIcon).mockClear();
    buildLobby({ worldLocked: true });
    const v = variantsByKind();
    expect(v.get('worldTabIcon')).toBe('inactive');
    // The card next to it is unaffected — the gate is per-card, not a whole-row wash.
    expect(v.get('campaignTabIcon')).toBe('content');
  });

  it('keeps the reuse/dedupe decisions: no trophy, no book, no castle, no pencils', () => {
    vi.mocked(buildIcon).mockClear();
    buildLobby();
    const kinds = kindsDrawn();
    expect(kinds).toContain('duelTabIcon');
    expect(kinds).toContain('campaignTabIcon');
    expect(kinds).toContain('worldTabIcon');
    expect(kinds).toContain('leaderboardTabIcon');
    for (const replaced of ['trophy', 'book', 'castle', 'pencils'] as IconKind[]) {
      expect(kinds).not.toContain(replaced);
    }
  });
});

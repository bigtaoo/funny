// The non-blocking Terms/Privacy notice + analytics prompt on the lobby (IPlatform.entryNoticeOnly —
// the CrazyGames build, COMPLIANCE_GLOBAL §3.3, ui/dialogs/EntryNoticeStrip.ts).
//
// What is pinned here is the "non-blocking" half of the contract, which no screenshot shows:
//   * it fits above the bottom nav in every locale and on the portal's short landscape canvas;
//   * a tap anywhere OUTSIDE the strip still reaches the lobby — that is the whole difference from
//     the consent wall it replaces on that build;
//   * a tap INSIDE it never falls through to a lobby button drawn underneath;
//   * Allow / No thanks / OK answer and take the strip down; a layout rebuild keeps it up.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, type Locale } from '../../src/i18n';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import type { EntryNoticeSpec } from '../../src/ui/dialogs/EntryNoticeStrip';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

interface Rect { x: number; y: number; w: number; h: number }
interface CoreView {
  w: number;
  h: number;
  noticeRect: Rect | null;
  noticeHits: Array<{ rect: Rect }>;
  profileChipRect: Rect;
  rebuild(): void;
}

interface Built {
  scene: LobbyScene;
  core: CoreView;
  answers: boolean[];
  closed: number;
  lobbyTaps: string[];
}

function build(spec: Partial<EntryNoticeSpec>, w = 800, h = 1280): Built {
  const lobbyTaps: string[] = [];
  const note = (name: string) => () => { lobbyTaps.push(name); };
  const scene = new LobbyScene(createLayout(w, h), new InputManager(), {
    onStartGame: note('start'), onOpenCampaign: note('campaign'), onOpenRoom: note('room'), onOpenShop: note('shop'),
    onOpenCards: note('cards'), onOpenStats: note('stats'), onOpenProfile: note('profile'),
    playerName: 'Tester',
  });
  const out: Built = { scene, core: (scene as unknown as { core: CoreView }).core, answers: [], closed: 0, lobbyTaps };
  scene.showEntryNotice({
    terms: spec.terms ?? true,
    consent: spec.consent ?? false,
    onAnswer: (g) => { out.answers.push(g); },
    onClose: () => { out.closed++; },
  });
  return out;
}

const tap = (scene: LobbyScene, x: number, y: number): void => {
  (scene as unknown as { build: { handleDown(x: number, y: number): void } }).build.handleDown(x, y);
};
const centre = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

/** Text nodes inside the strip's layer. */
function stripTexts(scene: LobbyScene): PIXI.Rectangle[] {
  const layer = scene.container.children.find((c) => c.name === 'overlay:entryNotice') as PIXI.Container | undefined;
  if (!layer) throw new Error('no entry notice layer');
  return layer.children.filter((c): c is PIXI.Text => c instanceof PIXI.Text).map((t) => t.getBounds());
}

describe('the entry notice strip fits', () => {
  const sizes: [number, number][] = [[800, 1280], [1170, 2532], [1568, 744], [375, 812], [722, 406]];
  for (const loc of ['zh', 'en', 'de'] as Locale[]) {
    for (const [vw, vh] of sizes) {
      it(`[${loc}] ${vw}x${vh}: inside the screen, above the bottom nav, every label inside the strip`, () => {
        setLocale(loc);
        try {
          const { scene, core } = build({ terms: true, consent: true }, vw, vh);
          const r = core.noticeRect!;
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(core.w);
          expect(r.y + r.h, 'the strip must not cover the bottom nav').toBeLessThanOrEqual(core.h - Math.round(core.h * 0.105));
          for (const b of stripTexts(scene)) {
            expect(b.x).toBeGreaterThanOrEqual(r.x);
            expect(b.y).toBeGreaterThanOrEqual(r.y);
            expect(b.x + b.width).toBeLessThanOrEqual(r.x + r.w + 0.5);
            expect(b.y + b.height).toBeLessThanOrEqual(r.y + r.h + 0.5);
          }
          // Two links + two answers, each its own rect.
          expect(core.noticeHits).toHaveLength(4);
        } finally {
          setLocale('en');
        }
      });
    }
  }
});

describe('the entry notice strip does not block the lobby', () => {
  it('a tap outside it still reaches the lobby', () => {
    const { scene, core, lobbyTaps, answers } = build({ terms: true, consent: true });
    tap(scene, ...centre(core.profileChipRect));
    expect(lobbyTaps).toEqual(['profile']);
    expect(answers).toEqual([]);
    expect(core.noticeRect, 'tapping elsewhere is not an answer and leaves the strip up').not.toBeNull();
  });

  it('a tap on the strip itself never reaches a lobby button underneath', () => {
    const { scene, core, lobbyTaps } = build({ terms: true, consent: true });
    const r = core.noticeRect!;
    tap(scene, r.x + 3, r.y + 3); // the strip's padding, no control of its own there
    expect(lobbyTaps).toEqual([]);
  });

  it('Allow answers true and takes the strip down', () => {
    const { scene, core, answers } = build({ terms: true, consent: true });
    const allow = core.noticeHits[2]!.rect; // links first, then Allow, then No thanks
    tap(scene, ...centre(allow));
    expect(answers).toEqual([true]);
    expect(core.noticeRect).toBeNull();
  });

  it('No thanks answers false', () => {
    const { scene, core, answers } = build({ terms: false, consent: true });
    tap(scene, ...centre(core.noticeHits[3]!.rect));
    expect(answers).toEqual([false]);
    expect(core.noticeRect).toBeNull();
  });

  it('the terms-only strip has a single OK that closes it', () => {
    const b = build({ terms: true, consent: false });
    expect(b.core.noticeHits).toHaveLength(3);
    tap(b.scene, ...centre(b.core.noticeHits[2]!.rect));
    expect(b.answers).toEqual([]);
    expect(b.closed).toBe(1);
    expect(b.core.noticeRect).toBeNull();
  });

  it('survives a layout rebuild of the lobby (tab-icon art, adopted save)', () => {
    const { scene, core } = build({ terms: true, consent: true });
    core.rebuild();
    expect(core.noticeRect).not.toBeNull();
    expect(scene.container.children.some((c) => c.name === 'overlay:entryNotice')).toBe(true);
  });
});

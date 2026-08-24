// Regression coverage for the 2026-08-24 header-row overlap fix (design/game/LOBBY_IA_REDESIGN.md
// §21). `drawSceneHeader` reserved a flat 20% of the bar's width for the currency cluster scenes
// draw on top of it, but the cluster's width depends on the caller's data — digit count, whether
// there is a capacity readout, how many material chips. On a 430pt-wide portrait viewport the
// roster's coin balance plus `73/500` measured ~27% of the bar, so the centred "Hero Roster" ran
// straight under the coin number (measured in Chrome: title right edge 346.9px, coin text starting
// at 325.3px).
//
// The fix is a measured reserve (`headerCurrencyWidth` → `opts.rightReserve`) plus a runtime
// backstop (`drawHeaderCurrency(..., leftBound)`) for the case where a balance gains a digit after
// the title was baked. What is pinned here:
//   1. the measurement and the drawing agree — they must, or the reserve is a fresh guess;
//   2. a measured reserve actually keeps the title out of it, and the default path is untouched;
//   3. the leftBound backstop shrinks the cluster instead of letting it overlap;
//   4. end-to-end on a portrait CardScene: title right edge <= cluster left edge.
//
// CAVEAT, and it is a real one: the headless harness's `measureText` is a flat 7px/char and
// font-size-independent (claudedocs/client-testing.md), so under this mock the roster's cluster
// measures ~171px against a 216px 20%-reserve — i.e. **the original bug does not reproduce here at
// all**, and a test asserting "no overlap on the portrait roster" would have been green before the
// fix too. Verified: that case was written first and had to be thrown away.
//
// So the mechanism is tested where the mock cannot lie about it: case (2) drives the cluster wide
// with an explicit `scale` and shows the title colliding without a measured reserve and clearing it
// with one — the mock supplies both widths, and only their relationship is asserted. Case (4) keeps
// the end-to-end scene assertion as a *plumbing* guard (a future change that drops `rightReserve`
// or `leftBound` from CardScene's calls trips it), NOT as proof of the pixel outcome. The pixel
// proof is the browser measurement recorded in design/game/LOBBY_IA_REDESIGN_LOG.md §26.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import {
  drawSceneHeader, drawHeaderCurrency, headerCurrencyWidth, sceneHeaderHeight, HEADER_ACCENT,
} from '../../src/ui/widgets/SceneHeader';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** The cluster drawHeaderCurrency added — it appends exactly one container. */
function clusterOf(host: PIXI.Container): PIXI.Container {
  const last = host.children[host.children.length - 1];
  expect(last).toBeInstanceOf(PIXI.Container);
  return last as PIXI.Container;
}

/** Screen-space left/right edges of a node, in design px (the harness runs the stage unscaled). */
function edges(node: PIXI.DisplayObject): { left: number; right: number } {
  const b = node.getBounds();
  return { left: b.x, right: b.x + b.width };
}

const CAP = { text: '73/500', color: 0x686868 };

describe('headerCurrencyWidth — measurement and drawing share one layout (2026-08-24)', () => {
  it('reports the width the cluster actually occupies', () => {
    const headerH = 280;
    const w = 1080;
    const measured = headerCurrencyWidth(headerH, 95946835, [], CAP, 100 / headerH);

    const host = new PIXI.Container();
    drawHeaderCurrency(host, w, headerH, 95946835, [], CAP, 100 / headerH);
    const drawn = clusterOf(host);

    // Exact on the layout cursor — this is the invariant that matters, because `rightReserve` is
    // that same number: right-aligned with a 10px inset, so the origin sits at w - 10 - measured.
    expect(drawn.x).toBe(w - 10 - measured);
    // Loose on the rendered union: a Text's bounds and the cursor's `+= width` step disagree by a
    // pixel or two of glyph overhang, which is fine for a reserve and not worth pinning exactly.
    expect(edges(drawn).right).toBeGreaterThan(w - 20);
    expect(edges(drawn).right).toBeLessThan(w + 5);
  });

  it('grows with the data it is given — that is the whole reason a fixed ratio could not work', () => {
    const headerH = 280;
    const scale = 100 / headerH;
    const small = headerCurrencyWidth(headerH, 1234, [], undefined, scale);
    const bigNumber = headerCurrencyWidth(headerH, 95946835, [], undefined, scale);
    const withCapacity = headerCurrencyWidth(headerH, 95946835, [], CAP, scale);
    expect(bigNumber).toBeGreaterThan(small);
    expect(withCapacity).toBeGreaterThan(bigNumber);
  });
});

describe('drawSceneHeader — a measured reserve keeps the title out of the cluster (2026-08-24)', () => {
  // The bug needs the title AND the cluster to be wide *relative to the bar*, and the headless font
  // mock (a flat 7px/char, size-independent) makes both narrower than Chrome does — "Hero Roster"
  // measures 77px here against 124 in the browser, the roster's cluster 171px against ~296. So two
  // knobs restore that ratio, and both are ratio restoration rather than invented measurements:
  //   - a long title (what a German localization actually does to a portrait bar);
  //   - a cluster `scale` of WIDE, standing in for the absolute size the real font gives it.
  // Nothing below compares against a hard-coded pixel; every assertion is measurement vs measurement.
  const LONG_TITLE = 'Ausrustungswerkstatt Uebersicht';
  const W = 1080;
  const H = 2341;   // 430x932 portrait, scaled into the 1080-wide design space
  const HEADER_H = sceneHeaderHeight(H);
  const WIDE = 1.6;
  /** Cluster scale so far past fitting that the title cannot yield enough — for the backstop case. */
  const WIDE_EXTREME = 3;

  function header(host: PIXI.Container, rightReserve?: number): { titleRight: number } {
    return drawSceneHeader(host, W, H, LONG_TITLE, {
      variant: 'paper', accent: HEADER_ACCENT.spend, icon: 'rosterIcon',
      ...(rightReserve === undefined ? {} : { rightReserve }),
    });
  }

  it('a title with no measured reserve runs into the cluster — the shape of the original bug', () => {
    const host = new PIXI.Container();
    const hdr = header(host);
    drawHeaderCurrency(host, W, HEADER_H, 95946835, [], CAP, WIDE);

    expect(hdr.titleRight).toBeGreaterThan(clusterOf(host).x);
  });

  it('...and clears it once the reserve is measured from that same cluster', () => {
    const host = new PIXI.Container();
    const hdr = header(host, headerCurrencyWidth(HEADER_H, 95946835, [], CAP, WIDE));
    drawHeaderCurrency(host, W, HEADER_H, 95946835, [], CAP, WIDE, hdr.titleRight);
    const cluster = clusterOf(host);

    expect(hdr.titleRight).toBeLessThanOrEqual(cluster.x);
    // titleRight really is the title's edge, not a stand-in the caller has to trust blindly.
    // Compared against `x + width` rather than getBounds(): a Text's bounds include pixiText's
    // transparent CJK anti-clip padding (~11px at this font size), which is not ink and must not be
    // treated as layout — see render/pixiText.ts.
    const title = host.children.find(
      (c): c is PIXI.Text => c instanceof PIXI.Text && c.text === LONG_TITLE,
    );
    expect(title).toBeDefined();
    expect(title!.x + title!.width).toBeCloseTo(hdr.titleRight, 3);
    // And the TITLE is what yielded, not the data readout: that priority is the point — the balance
    // is live data the player reads, the title is a label they already know. Asserted as a
    // comparison of the two fits rather than "cluster === 1" because at a bar width this tight the
    // backstop can still shave a percent off the cluster; what must not happen is the reverse.
    expect(title!.scale.x).toBeLessThan(0.9);
    expect(cluster.scale.x).toBeGreaterThan(0.95);
  });

  it('reserves only what the cluster needs — a shorter balance leaves the title wider', () => {
    const wide = new PIXI.Container();
    const narrow = new PIXI.Container();
    const withBig = header(wide, headerCurrencyWidth(HEADER_H, 95946835, [], CAP, WIDE));
    const withSmall = header(narrow, headerCurrencyWidth(HEADER_H, 12, [], CAP, WIDE));
    expect(withSmall.titleRight).toBeGreaterThan(withBig.titleRight);
  });

  it('falls back to shrinking the cluster when even an honest reserve cannot fit', () => {
    // Past the point where the bar can hold both: the reserve is wider than the band left after the
    // back pill, so the title cannot give up enough and drawHeaderCurrency's leftBound backstop takes
    // over. Asserted because the alternative — going back to overlapping — is the bug.
    const host = new PIXI.Container();
    const hdr = header(host, headerCurrencyWidth(HEADER_H, 95946835, [], CAP, WIDE_EXTREME));
    drawHeaderCurrency(host, W, HEADER_H, 95946835, [], CAP, WIDE_EXTREME, hdr.titleRight);
    const cluster = clusterOf(host);

    expect(cluster.scale.x).toBeLessThan(1);
    expect(cluster.x).toBeGreaterThanOrEqual(hdr.titleRight - 0.5);
  });

  it('leaves the no-reserve default path exactly as it was', () => {
    const a = new PIXI.Container();
    const b = new PIXI.Container();
    const noOpts = header(a);
    const explicitDefault = header(b, Math.round(W * 0.2));
    // Same reserve VALUE, but the explicit path adds the back-pill gap on top — so the two are only
    // allowed to differ in that direction. A regression that silently changed the default would move
    // `noOpts` instead.
    expect(noOpts.titleRight).toBeGreaterThanOrEqual(explicitDefault.titleRight);
    expect(drawSceneHeader(new PIXI.Container(), W, H, LONG_TITLE, {}).headerH).toBe(HEADER_H);
  });

  it('reports the back pill edge as titleRight when there is no title at all', () => {
    const host = new PIXI.Container();
    const hdr = drawSceneHeader(host, W, H, null, { variant: 'paper' });
    expect(hdr.titleRight).toBeGreaterThan(0);
    expect(hdr.titleRight).toBeLessThan(W);
  });
});

describe('drawHeaderCurrency — leftBound backstop (2026-08-24)', () => {
  it('scales the cluster down to the space left, anchored on its right edge', () => {
    const w = 1080, headerH = 280;
    const full = headerCurrencyWidth(headerH, 95946835, [], CAP, 100 / headerH);
    // Pretend the reserve went stale: only half the room the cluster needs is left.
    const leftBound = w - 10 - Math.round(full / 2);

    const host = new PIXI.Container();
    drawHeaderCurrency(host, w, headerH, 95946835, [], CAP, 100 / headerH, leftBound);
    const drawn = clusterOf(host);

    expect(drawn.scale.x).toBeLessThan(1);
    // Right edge pinned to the same 10px inset, left edge exactly on the bound it was given.
    expect(drawn.x + full * drawn.scale.x).toBeCloseTo(w - 10, 5);
    expect(drawn.x).toBeGreaterThanOrEqual(leftBound - 0.5);
  });

  it('does not touch a cluster that already fits', () => {
    const w = 1080, headerH = 280;
    const host = new PIXI.Container();
    drawHeaderCurrency(host, w, headerH, 1234, [], undefined, 100 / headerH, 100);
    expect(clusterOf(host).scale.x).toBe(1);
  });
});

function buildPortraitRoster(coins: number): CardScene {
  const save = makeNewSave();
  save.wallet.coins = coins;
  const cards: CardInstance[] = Array.from({ length: 73 }, (_, i) => ({
    id: `c${String(i).padStart(3, '0')}`, defId: 'lichuang', level: 1, gear: {}, locked: false,
  }));
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  // PortraitLayout pegs designWidth to a fixed 1080 regardless of the screen size passed in.
  return new CardScene(createLayout(1080, 1920), new InputManager(), cb);
}

interface RosterInternals {
  core: { headerOverlayLayer: PIXI.Container; container: PIXI.Container; headerH: number; titleRight: number };
}

describe('CardScene portrait header — title and coin readout do not overlap (2026-08-24)', () => {
  it('keeps the title clear of the currency cluster with an 8-digit balance', () => {
    const scene = buildPortraitRoster(95946835);
    const { core } = scene as unknown as RosterInternals;

    const title = core.container.children.find(
      (c): c is PIXI.Text => c instanceof PIXI.Text && c.text === t('roster.title'),
    );
    expect(title, 'header title not found').toBeDefined();
    const cluster = clusterOf(core.headerOverlayLayer);

    expect(edges(title!).right).toBeLessThanOrEqual(edges(cluster).left);

    scene.destroy();
  });

  it('passes a leftBound through, so the cluster is never left unbounded', () => {
    // The plumbing half of the fix. Under the font mock the cluster comfortably fits, so this cannot
    // assert a shrink — what it can assert is that CardScene reports a title edge at all, which is
    // the value it forwards as `leftBound`; a build() that stopped storing hdr.titleRight leaves 0.
    const scene = buildPortraitRoster(95946835);
    const { core } = scene as unknown as RosterInternals;
    expect(core.titleRight).toBeGreaterThan(0);
    expect(core.titleRight).toBeLessThan(1080);
    scene.destroy();
  });
});

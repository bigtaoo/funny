// Regression coverage for the SectScene incremental-repaint pass (sect-incremental-repaint,
// 2026-08-25) — the sect page felt like it "still refreshes everything" next to the rest of the
// social hub, because three things each rebuilt the whole body (rail, header, roster rows, chat
// column, hand-drawn sketchPanel borders and all) to move exactly one thing:
//
//   - a drag/wheel scroll, once per rendered frame for the whole gesture;
//   - the focused field's caret, twice a second;
//   - every keystroke in the create-form / channel input.
//
// FriendsScene had already been through this (social-tab-switch-cost, 2026-08-20; see
// scrollDragThrottle.ui.ts's FriendsScene cases). SectScene is the two-column variant: the landscape
// split view scrolls the family roster and the sect channel independently, so the cheap-scroll state
// is per column ("band") and a drag must move only its own column.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { SectScene } from '../../src/scenes/SectScene';
import { ROW_H } from '../../src/scenes/SectScene/core';
import { ui as C } from '../../src/render/sketchUi';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { openDomTextInput } from '../../src/platform/web/domTextInput';

// Minimal DOM stub for the hidden-input fields, recording each element's listeners so a test can
// fire a real 'input' event the way a keystroke does (mirrors caretRegression.ui.ts's stub, which
// only needed the no-op version).
interface FakeInput {
  value: string;
  listeners: Record<string, Array<() => void>>;
}
const created: FakeInput[] = [];
const gDoc = globalThis as unknown as { document?: unknown };
if (!gDoc.document) {
  gDoc.document = {
    body: { appendChild(): void {} },
    createElement(): Record<string, unknown> {
      const el: Record<string, unknown> = {
        type: '', value: '', maxLength: 0, placeholder: '', style: { cssText: '' },
        listeners: {} as Record<string, Array<() => void>>,
        focus(): void {},
        remove(): void {},
        setAttribute(): void {},
        addEventListener(type: string, fn: () => void): void {
          const map = el.listeners as Record<string, Array<() => void>>;
          (map[type] ??= []).push(fn);
        },
      };
      created.push(el as unknown as FakeInput);
      return el;
    },
  };
}
/** Fire the recorded 'input' listeners of the most recently created hidden input. */
function typeInto(text: string): void {
  const el = created[created.length - 1]!;
  el.value = text;
  for (const fn of el.listeners.input ?? []) fn();
}

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const ME = 'acc_test';
const FAMILIES = 40;
const MESSAGES = 40;

/** My family leads nothing — so every row but the sect's leader family carries a vote button, which
 *  is the only tap target inside the scrolling roster and therefore what the hit-test cases use. */
const FAM = {
  familyId: 'fam_mine', name: 'Mine', tag: 'MINE', sectId: 'sect_1', leaderId: ME,
  members: [{ accountId: ME, role: 'leader', joinedAt: 0 }],
};

const SECT = {
  sectId: 'sect_1', name: 'Sect', tag: 'SCT', leaderId: 'someone_else', leaderFamilyId: 'fam_0',
  memberFamilyCount: FAMILIES, prosperity: 42, allySectIds: [],
  memberFamilies: Array.from({ length: FAMILIES }, (_, i) => ({
    familyId: `fam_${i}`, name: `Family${i}`, tag: `F${i}`, memberCount: 5, territoryCount: 3,
  })),
};

const MSGS = Array.from({ length: MESSAGES }, (_, i) => ({
  id: `m${i}`, senderId: `acc_${i}`, senderName: `Sender${i}`, body: `message ${i}`, ts: 1000 + i,
}));

function stubWorldApi(): WorldApiClient {
  return {
    getSectChannel: async () => MSGS,
    getMyFamily: async () => FAM,
    getSect: async () => SECT,
  } as unknown as WorldApiClient;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Mount SectScene straight into its my-sect view (the hub hand-off skips both fetches) and flush
 *  the channel round-trip, so every case below starts from a fully painted page. */
async function mount(w: number, h: number): Promise<{ scene: any; input: InputManager; core: any }> {
  const input = new InputManager();
  const scene = new SectScene(createLayout(w, h), input, {
    openTextInput: openDomTextInput,
    onBack() {}, onNavTab() {},
    worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: ME, playerName: 'Tester',
    getCoins: () => 100_000, refreshWallet: async () => {},
    preloadedFamily: FAM as any, preloadedSect: SECT as any,
  }) as any;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(scene.core.mode).toBe('mySect');
  expect(scene.core.messages).toHaveLength(MESSAGES);
  return { scene, input, core: scene.core };
}

/** A Text's ink colour as a number — PIXI normalises `style.fill` to a '#rrggbb' string. */
function fillOf(obj: PIXI.Text): number {
  const fill = obj.style.fill as unknown;
  return typeof fill === 'number' ? fill : parseInt(String(fill).replace('#', ''), 16);
}

/** Screen y of every roster tap target currently registered, in the order they were built. */
function voteRowScreenYs(core: any): number[] {
  const applied = core.repaint.appliedDelta('families');
  return core.hitRects
    .filter((hit: any) => hit.scroll === 'families')
    .map((hit: any) => Math.round(hit.rect.y - applied))
    .filter((y: number) => y >= core.familiesRegionTop && y + ROW_H <= core.familiesRegionBottom)
    .sort((a: number, b: number) => a - b);
}

describe('SectScene: a drag scrolls by translating the built column, not by rebuilding it', () => {
  it('portrait roster: a drag inside the overscan band renders zero times', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const renderSpy = vi.spyOn(scene, 'render');
    const layer = core.repaint.layerFor('families');
    expect(layer).toBeTruthy();
    expect(core.familiesMax).toBeGreaterThan(0);
    expect(core.repaint.overscanFor('families')).toBeGreaterThan(200);

    // Drag upward (decreasing y): scrolls the list down from scrollY = 0.
    input._emitDown(400, 640);
    input._emitMove(400, 620);
    input._emitMove(400, 600);
    input._emitMove(400, 580);
    expect(renderSpy).not.toHaveBeenCalled();

    // Drained on the frame boundary as always — but as a translate, not a rebuild.
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.repaint.layerFor('families')).toBe(layer); // same tree, just moved
    expect(layer.y).toBe(-60);
    expect(core.scrollY).toBe(60);

    // An idle frame does nothing at all.
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();

    // Past the band there are no pre-built rows left to show — fall back to one rebuild.
    input._emitMove(400, 640 - (core.repaint.overscanFor('families') + 100));
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('portrait roster: the translate lands rows exactly where a rebuild would', async () => {
    const { scene, input, core } = await mount(800, 1280);
    input._emitDown(400, 640);
    input._emitMove(400, 640 - 137); // an awkward offset, so an off-by-one can't hide
    scene.update(1 / 60);
    expect(core.scrollY).toBe(137);

    const translated = voteRowScreenYs(core);
    expect(translated.length).toBeGreaterThan(3); // the comparison must not be vacuous

    // Same scroll position, arrived at by a full rebuild instead of a translate.
    scene.render();
    expect(core.repaint.layerFor('families').y).toBe(0); // freshly baselined
    expect(voteRowScreenYs(core)).toEqual(translated);
    scene.destroy();
  });

  it('portrait roster: a tap after a translate hits the family a rebuild would have', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const confirmVote = vi.spyOn(scene.actions, 'confirmVote');

    input._emitDown(400, 640);
    input._emitMove(400, 640 - 137);
    scene.update(1 / 60);

    // Pick a roster tap target that is comfortably on screen, and tap where it *appears*.
    const applied = core.repaint.appliedDelta('families');
    expect(applied).toBe(137);
    const target = core.hitRects
      .filter((hit: any) => hit.scroll === 'families')
      .map((hit: any) => ({ rect: hit.rect, sy: hit.rect.y - applied }))
      .find((h: any) => h.sy > core.familiesRegionTop + 20 && h.sy + h.rect.h < core.familiesRegionBottom - 20);
    expect(target).toBeTruthy();
    const px = target.rect.x + target.rect.w / 2;
    const py = target.sy + target.rect.h / 2;

    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(confirmVote).toHaveBeenCalledTimes(1);
    const afterTranslate = confirmVote.mock.calls[0]![0];
    core.closeModal();

    // Rebuild at the same scrollY, tap the identical screen point: same family.
    scene.render();
    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(confirmVote).toHaveBeenCalledTimes(2);
    expect(confirmVote.mock.calls[1]![0]).toBe(afterTranslate);
    scene.destroy();
  });

  it('portrait roster: a tap that lands outside the viewport (on an overscan row) misses', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const confirmVote = vi.spyOn(scene.actions, 'confirmVote');
    // Rows are built a viewport beyond the fold, so hit rects exist below it now. A tap down there
    // is on the bottom nav / page chrome, not on a row, and must not fire one.
    const below = core.hitRects.find((hit: any) => hit.scroll === 'families' && hit.rect.y > core.familiesRegionBottom + 10);
    expect(below).toBeTruthy();
    const py = below.rect.y + below.rect.h / 2;
    input._emitDown(below.rect.x + below.rect.w / 2, py);
    input._emitUp(below.rect.x + below.rect.w / 2, py);
    expect(confirmVote).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('portrait channel tab: a drag translates the message column', async () => {
    const { scene, input, core } = await mount(800, 1280);
    core.activeTab = 'channel';
    scene.render();
    const layer = core.repaint.layerFor('channel');
    expect(layer).toBeTruthy();
    expect(core.channelMax).toBeGreaterThan(100);
    // Stuck to the latest message on entry, so there is room to drag *back up* through history.
    expect(core.scrollY).toBe(core.channelMax);

    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 500);
    input._emitMove(400, 520);
    input._emitMove(400, 540);
    input._emitMove(400, 560);
    scene.update(1 / 60);

    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.repaint.layerFor('channel')).toBe(layer);
    expect(layer.y).toBe(60);
    expect(core.scrollY).toBe(core.channelMax - 60);
    // Scrolling up off the bottom releases the stick-to-latest pin.
    expect(core.channelStick).toBe(false);
    scene.destroy();
  });

  it('landscape split view: dragging one column leaves the other one alone', async () => {
    const { scene, input, core } = await mount(1280, 800);
    const families = core.repaint.layerFor('families');
    const channel = core.repaint.layerFor('channel');
    expect(families).toBeTruthy();
    expect(channel).toBeTruthy();
    expect(core.chatColX).toBeGreaterThan(0);

    const renderSpy = vi.spyOn(scene, 'render');
    // Right of the divider: the chat column, on its own scrollYChannel.
    const chatX = core.chatColX + 40;
    input._emitDown(chatX, 400);
    input._emitMove(chatX, 420);
    input._emitMove(chatX, 440);
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(channel.y).toBe(40);
    expect(families.y).toBe(0);
    expect(core.scrollY).toBe(0);
    input._emitUp(chatX, 440);

    // Left of it: the roster, on scrollY — and the chat column must not follow.
    const rosterX = core.chatColX - 60;
    input._emitDown(rosterX, 400);
    input._emitMove(rosterX, 380);
    input._emitMove(rosterX, 360);
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(families.y).toBe(-40);
    expect(channel.y).toBe(40); // unchanged
    expect(core.scrollYChannel).toBe(core.channelMax - 40);
    scene.destroy();
  });

  it('a wheel tick over one column translates only that column', async () => {
    const { scene, input, core } = await mount(1280, 800);
    const families = core.repaint.layerFor('families');
    const channel = core.repaint.layerFor('channel');
    const renderSpy = vi.spyOn(scene, 'render');

    input._emitWheel(core.chatColX - 60, 400, 120);
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(families.y).toBeLessThan(0);
    expect(channel.y).toBe(0);
    scene.destroy();
  });
});

describe('SectScene: the caret and keystrokes rewrite one Text, not the page', () => {
  it('the 0.5 s blink swaps the caret in the same Text object', async () => {
    const { scene, core } = await mount(800, 1280);
    core.activeTab = 'channel';
    scene.render();
    scene.input.openSendInput();
    scene.render();

    const field = core.repaint.caretField;
    expect(field).toBeTruthy();
    expect(field.obj.text).toContain('|'); // caretOn starts true

    const renderSpy = vi.spyOn(scene, 'render');
    scene.update(0.5);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.repaint.caretField.obj).toBe(field.obj); // same Text, new string
    expect(field.obj.text).not.toContain('|');

    scene.update(0.5);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(field.obj.text).toContain('|');
    scene.destroy();
  });

  it('a keystroke in the channel input rewrites (and recolours) that one Text', async () => {
    const { scene, core } = await mount(800, 1280);
    core.activeTab = 'channel';
    scene.render();
    scene.input.openSendInput();
    scene.render();

    const field = core.repaint.caretField;
    // Empty field: the placeholder is drawn in the muted ink.
    expect(fillOf(field.obj)).toBe(C.mid);

    const renderSpy = vi.spyOn(scene, 'render');
    typeInto('hello');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.channelInput).toBe('hello');
    expect(core.repaint.caretField.obj).toBe(field.obj);
    expect(field.obj.text).toContain('hello');
    expect(fillOf(field.obj)).toBe(C.dark);

    // Clearing it goes back to the muted placeholder colour, still without a rebuild.
    typeInto('');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(fillOf(field.obj)).toBe(C.mid);
    scene.destroy();
  });

  it('a keystroke in the create form rewrites that one Text', async () => {
    const { scene, core } = await mount(800, 1280);
    // The create form belongs to the no-sect mode — drive the scene into it directly.
    core.sect = null;
    core.mode = 'create';
    scene.render();
    scene.input.openInputFor('name');
    scene.render();

    const field = core.repaint.caretField;
    expect(field).toBeTruthy();

    const renderSpy = vi.spyOn(scene, 'render');
    typeInto('Wudang');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.createName).toBe('Wudang');
    expect(field.obj.text).toContain('Wudang');
    scene.destroy();
  });

  it('falls back to a full render when the registered Text is gone', async () => {
    const { scene, core } = await mount(800, 1280);
    core.activeTab = 'channel';
    scene.render();
    scene.input.openSendInput();
    scene.render();
    expect(core.repaint.caretField).toBeTruthy();

    // Simulates a missed registration / a torn-down tree: the cheap path must degrade to the old
    // behaviour rather than silently leaving a stale screen.
    (core.repaint.caretField.obj as PIXI.Text).destroy();
    const renderSpy = vi.spyOn(scene, 'render');
    scene.update(0.5);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });
});

describe('SectScene: the busy tracker no longer drives redraws', () => {
  it('ticking an in-flight action does not rebuild the page', async () => {
    const { scene, core } = await mount(800, 1280);
    const renderSpy = vi.spyOn(scene, 'render');
    // Nothing here draws bt's dots/loading overlay — it only greys buttons, and start()/stop() each
    // render on their own (actions.ts). This used to cost 2.5 rebuilds a second for no visual change.
    core.bt.start();
    for (let i = 0; i < 120; i++) scene.update(1 / 60); // two seconds of animation ticks
    expect(renderSpy).not.toHaveBeenCalled();
    scene.destroy();
  });
});

/** Every Text under `node`, recursing — chat lines are drawn into nested containers. */
function textNodes(node: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const c of n.children) {
      if (c instanceof PIXI.Text) out.push(c);
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(node);
  return out;
}

/** Pick a roster tap target that is comfortably inside the viewport as currently displayed. */
function visibleVoteTarget(core: any): { px: number; py: number } {
  const applied = core.repaint.appliedDelta('families');
  const hit = core.hitRects
    .filter((h: any) => h.scroll === 'families')
    .map((h: any) => ({ rect: h.rect, sy: h.rect.y - applied }))
    .find((h: any) => h.sy > core.familiesRegionTop + 30 && h.sy + h.rect.h < core.familiesRegionBottom - 30);
  expect(hit).toBeTruthy();
  return { px: hit.rect.x + hit.rect.w / 2, py: hit.sy + hit.rect.h / 2 };
}

/** Tap a screen point and report which family the roster resolved it to (null = nothing fired). */
function tapFamily(input: InputManager, spy: any, px: number, py: number): string | null {
  const before = spy.mock.calls.length;
  input._emitDown(px, py);
  input._emitUp(px, py);
  return spy.mock.calls.length > before ? (spy.mock.calls[spy.mock.calls.length - 1]![0] as string) : null;
}

describe('SectScene: what the cheap scroll made possible to get wrong', () => {
  it('a drag past the end stops at the end instead of translating into blank space', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const max = core.familiesMax;
    expect(max).toBeGreaterThan(0);

    // Park at the very end (a long drag leaves the overscan band, so this rebuilds and re-baselines).
    input._emitDown(400, 640);
    input._emitMove(400, 640 - (max + 300));
    scene.update(1 / 60);
    input._emitUp(400, 640 - (max + 300));
    expect(core.scrollY).toBe(max);
    expect(core.repaint.layerFor('families').y).toBe(0);

    // A further drag from there stays inside the band, so it takes the translate path — which used
    // to move the layer past the content's end and leave a blank strip that nothing clamped back
    // (the full render that used to re-clamp every frame is exactly what this pass removed).
    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 640);
    input._emitMove(400, 540);
    scene.update(1 / 60);
    expect(core.scrollY).toBe(max);
    expect(core.repaint.layerFor('families').y).toBe(0);
    expect(renderSpy).not.toHaveBeenCalled(); // clamped, so there is nothing to redraw either

    // Reversing the finger must move the content immediately (no dead zone to unwind first).
    input._emitMove(400, 740);
    scene.update(1 / 60);
    expect(core.scrollY).toBeLessThan(max);
    scene.destroy();
  });

  it('a tap right after a wheel tick — before the frame drains — hits what is on screen', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const confirmVote = vi.spyOn(scene.actions, 'confirmVote').mockImplementation(() => {});
    const { px, py } = visibleVoteTarget(core);

    const before = tapFamily(input, confirmVote, px, py);
    expect(before).toBeTruthy();

    // Wheel exactly one row and do NOT tick: scrollY has moved, the layer has not. A tap judged
    // against the pending offset (scrollY - builtScrollY) would resolve one row off; it must be
    // judged against what the player is looking at.
    input._emitWheel(px, py, ROW_H);
    expect(core.scrollY).toBe(ROW_H);
    expect(core.repaint.appliedDelta('families')).toBe(0);
    expect(tapFamily(input, confirmVote, px, py)).toBe(before);

    // Once the frame drains, the same point is genuinely a different row.
    scene.update(1 / 60);
    expect(core.repaint.appliedDelta('families')).toBe(ROW_H);
    expect(tapFamily(input, confirmVote, px, py)).not.toBe(before);
    scene.destroy();
  });

  it('after translating exactly one row, the same point hits the NEXT family', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const confirmVote = vi.spyOn(scene.actions, 'confirmVote').mockImplementation(() => {});
    const { px, py } = visibleVoteTarget(core);

    const first = tapFamily(input, confirmVote, px, py)!;
    input._emitDown(px, py);
    input._emitMove(px, py - ROW_H);
    scene.update(1 / 60);
    input._emitUp(px, py - ROW_H);
    const second = tapFamily(input, confirmVote, px, py)!;

    // Ids are fam_0..fam_N in roster order, so "the next one" is checkable exactly — a sign flip or
    // an off-by-one row would land somewhere else entirely.
    const idx = (id: string): number => Number(id.split('_')[1]);
    expect(idx(second)).toBe(idx(first) + 1);
    scene.destroy();
  });

  it('the per-frame scrollbar redraw does not accumulate children', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const before = core.bodyLayer.children.length;
    input._emitDown(400, 640);
    for (let i = 1; i <= 8; i++) {
      input._emitMove(400, 640 - i * 12);
      scene.update(1 / 60); // each drained frame destroys + redraws the indicator
    }
    expect(core.repaint.appliedDelta('families')).toBe(96);
    // One leaked Graphics per frame would read as +8 here, and it would keep growing per gesture.
    expect(core.bodyLayer.children.length).toBe(before);
    scene.destroy();
  });

  it('falls back to a full render when the built layer is gone', async () => {
    const { scene, input, core } = await mount(800, 1280);
    core.repaint.layerFor('families').destroy();
    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 640);
    input._emitMove(400, 580);
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('a mode that builds no scroll layer at all still scrolls by falling back to render', async () => {
    const { scene, input, core } = await mount(800, 1280);
    core.sect = null;
    core.mode = 'create';
    scene.render();
    expect(core.repaint.layerFor('families')).toBeNull();
    expect(core.repaint.layerFor('channel')).toBeNull();

    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 640);
    input._emitMove(400, 580);
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('portrait builds exactly one column, so the shared scrollY cannot move the other one', async () => {
    const { scene, core } = await mount(800, 1280);
    // Portrait renders one tab at a time, and both tabs drive `scrollY` on this scene (unlike the
    // landscape split view, where the channel owns scrollYChannel) — so the invariant that keeps a
    // drag from moving the hidden column is that the hidden column has no band at all.
    expect(core.activeTab).toBe('families');
    expect(core.repaint.layerFor('families')).toBeTruthy();
    expect(core.repaint.layerFor('channel')).toBeNull();

    core.activeTab = 'channel';
    scene.render();
    expect(core.repaint.layerFor('channel')).toBeTruthy();
    expect(core.repaint.layerFor('families')).toBeNull();
    scene.destroy();
  });

  it('channel: a translated column puts messages exactly where a rebuild would', async () => {
    const { scene, input, core } = await mount(1280, 800); // landscape: channel owns scrollYChannel
    const layer = core.repaint.layerFor('channel');
    expect(core.channelMax).toBeGreaterThan(100);

    const chatX = core.chatColX + 40;
    input._emitDown(chatX, 400);
    input._emitMove(chatX, 400 + 91); // awkward offset again
    scene.update(1 / 60);
    const screenYs = (): number[] => {
      const l = core.repaint.layerFor('channel');
      return textNodes(l)
        .map((t) => Math.round(t.y + l.y))
        .filter((y) => y >= core.channelRegionTop && y <= core.channelRegionBottom)
        .sort((a, b) => a - b);
    };
    const translated = screenYs();
    expect(translated.length).toBeGreaterThan(3);
    expect(layer.y).toBe(91);

    scene.render(); // same scroll position, rebuilt instead of translated
    expect(core.repaint.layerFor('channel').y).toBe(0);
    expect(screenYs()).toEqual(translated);
    scene.destroy();
  });
});

// ── list modals ───────────────────────────────────────────────────────────────
// The browse / ally / manage-allies picker used to draw `sects.slice(0, maxRows)` with no mask and
// no scroll: everything past the modal's height was unreachable, and nothing on screen said so.
// It is a scroll region now, on the same band machinery as the page columns (col 'modal', rebuilt
// through core.modalRedraw since modalLayer is outside render()'s tree).

/** 30 sects — comfortably more than any modal height can show at once. */
const MANY_SECTS = Array.from({ length: 30 }, (_, i) => ({
  sectId: `sect_${i}`, name: `Sect ${i}`, tag: `S${i}`, leaderId: 'x', leaderFamilyId: 'y',
  memberFamilyCount: i, prosperity: i * 10, allySectIds: [],
}));

/** Row labels actually VISIBLE in the modal's viewport — built-but-clipped overscan rows do not
 *  count, which is the whole point of the assertions below. */
function visibleModalTexts(core: any): string[] {
  const layer = core.repaint.layerFor('modal');
  if (!layer) return [];
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) {
        const sy = c.y + layer.y;
        if (sy >= core.modalRegionTop && sy <= core.modalRegionBottom) out.push(c.text);
      }
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(layer);
  return out;
}

/** Open the picker with a spy on the row callback. */
async function openPicker(w = 800, h = 1280): Promise<{ scene: any; input: InputManager; core: any; onPick: any }> {
  const { scene, input, core } = await mount(w, h);
  const onPick = vi.fn();
  scene.modals.showSectPickModal(MANY_SECTS as any, onPick, 'sect.noSects');
  expect(core.modalOpen).toBe(true);
  return { scene, input, core, onPick };
}

describe('SectScene: the pick modal is a real scroll region', () => {
  it('reaches every entry instead of silently cutting the list off', async () => {
    const { scene, input, core } = await openPicker();
    expect(core.modalMax).toBeGreaterThan(0);
    // The last sect is NOT on screen at rest…
    expect(visibleModalTexts(core).some((s) => s.includes('Sect 29'))).toBe(false);

    // …and scrolling to the end brings it in (wheel in big steps, draining each frame).
    for (let i = 0; i < 40 && core.modalScrollY < core.modalMax; i++) {
      input._emitWheel(core.w / 2, core.modalRegionTop + 20, 200);
      scene.update(1 / 60);
    }
    expect(core.modalScrollY).toBe(core.modalMax);
    expect(visibleModalTexts(core).some((s) => s.includes('Sect 29'))).toBe(true);
    scene.destroy();
  });

  it('a drag translates the built list instead of rebuilding it, and stops at the end', async () => {
    const { scene, input, core } = await openPicker();
    const layer = core.repaint.layerFor('modal');
    expect(layer).toBeTruthy();

    const y = core.modalRegionTop + 40;
    input._emitDown(core.w / 2, y);
    input._emitMove(core.w / 2, y - 50);
    scene.update(1 / 60);
    expect(core.repaint.layerFor('modal')).toBe(layer); // same tree, moved
    expect(layer.y).toBe(-50);
    expect(core.modalScrollY).toBe(50);

    // Over-drag stops at the end rather than translating into blank space (same clamp the page
    // columns needed once the per-frame rebuild stopped doing it for us).
    input._emitMove(core.w / 2, y - (core.modalMax + 400));
    scene.update(1 / 60);
    expect(core.modalScrollY).toBe(core.modalMax);
    scene.destroy();
  });

  it('a wheel over the modal scrolls the modal, not the page underneath', async () => {
    const { scene, input, core } = await openPicker();
    const pageScroll = core.scrollY;
    input._emitWheel(core.w / 2, core.modalRegionTop + 20, 120);
    scene.update(1 / 60);
    expect(core.modalScrollY).toBe(120);
    expect(core.scrollY).toBe(pageScroll);
    scene.destroy();
  });

  it('a row tap after scrolling picks the row that is on screen', async () => {
    const { scene, input, core, onPick } = await openPicker();
    input._emitWheel(core.w / 2, core.modalRegionTop + 20, 120);
    scene.update(1 / 60);

    const applied = core.repaint.appliedDelta('modal');
    expect(applied).toBe(120);
    const hit = core.modalHits
      .filter((h: any) => h.scroll === 'modal')
      .map((h: any) => ({ rect: h.rect, sy: h.rect.y - applied }))
      .find((h: any) => h.sy > core.modalRegionTop + 10 && h.sy + h.rect.h < core.modalRegionBottom - 10);
    expect(hit).toBeTruthy();
    const px = hit.rect.x + hit.rect.w / 2;
    const py = hit.sy + hit.rect.h / 2;

    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(onPick).toHaveBeenCalledTimes(1);
    const translated = onPick.mock.calls[0]![0];

    // A rebuild at the same offset must resolve the identical point to the identical sect.
    core.modalRedraw();
    expect(core.repaint.layerFor('modal').y).toBe(0);
    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick.mock.calls[1]![0]).toBe(translated);
    scene.destroy();
  });

  it('a drag that starts on a row scrolls instead of picking it', async () => {
    const { scene, input, core, onPick } = await openPicker();
    const y = core.modalRegionTop + 40;
    input._emitDown(core.w / 2, y);
    input._emitMove(core.w / 2, y - 60);
    scene.update(1 / 60);
    input._emitUp(core.w / 2, y - 60);
    expect(onPick).not.toHaveBeenCalled();
    expect(core.modalScrollY).toBe(60);
    scene.destroy();
  });

  it('closing resets the offset so the next open starts at the top', async () => {
    const { scene, input, core, onPick } = await openPicker();
    input._emitWheel(core.w / 2, core.modalRegionTop + 20, 200);
    scene.update(1 / 60);
    expect(core.modalScrollY).toBe(200);

    core.closeModal();
    expect(core.modalRedraw).toBeNull();
    expect(core.modalScrollY).toBe(0);

    scene.modals.showSectPickModal(MANY_SECTS as any, onPick, 'sect.noSects');
    expect(core.modalScrollY).toBe(0);
    // …while an explicit redraw of an OPEN modal keeps the reader in place.
    input._emitWheel(core.w / 2, core.modalRegionTop + 20, 160);
    scene.update(1 / 60);
    core.modalRedraw();
    expect(core.modalScrollY).toBe(160);
    scene.destroy();
  });

  it('a drag inside a non-list modal is a harmless no-op', async () => {
    const { scene, input, core } = await mount(800, 1280);
    scene.modals.showConfirm('Really?', () => {});
    expect(core.modalRedraw).toBeNull(); // confirm dialogs register no scroll band
    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 640);
    input._emitMove(400, 560);
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled(); // and no pointless page rebuild either
    scene.destroy();
  });
});

describe('SectScene: what the scrollable modal made possible to get wrong', () => {
  it('a tap right after a wheel tick — before the frame drains — picks what is on screen', async () => {
    const { scene, input, core, onPick } = await openPicker();
    const rowAt = (): any => {
      const applied = core.repaint.appliedDelta('modal');
      return core.modalHits
        .filter((h: any) => h.scroll === 'modal')
        .map((h: any) => ({ rect: h.rect, sy: h.rect.y - applied }))
        .find((h: any) => h.sy > core.modalRegionTop + 10 && h.sy + h.rect.h < core.modalRegionBottom - 10);
    };
    const target = rowAt();
    const px = target.rect.x + target.rect.w / 2;
    const py = target.sy + target.rect.h / 2;

    input._emitDown(px, py);
    input._emitUp(px, py);
    const before = onPick.mock.calls[0]![0];

    // Wheel and do NOT tick: modalScrollY moved, the layer has not. Judging the tap by the pending
    // offset would resolve a different row than the one under the finger.
    input._emitWheel(px, py, 80);
    expect(core.modalScrollY).toBe(80);
    expect(core.repaint.appliedDelta('modal')).toBe(0);
    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(onPick.mock.calls[1]![0]).toBe(before);

    // Once drained, the same point is a different sect.
    scene.update(1 / 60);
    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(onPick.mock.calls[2]![0]).not.toBe(before);
    scene.destroy();
  });

  it('the modal scrollbar is replaced in the MODAL layer, not stacked and not on the page', async () => {
    const { scene, input, core } = await openPicker();
    const beforeModal = core.modalLayer.children.length;
    const beforeBody = core.bodyLayer.children.length;
    for (let i = 0; i < 8; i++) {
      input._emitWheel(core.w / 2, core.modalRegionTop + 20, 20);
      scene.update(1 / 60);
    }
    expect(core.modalScrollY).toBe(160);
    // Flat: one leaked Graphics per frame would read as +8 here…
    expect(core.modalLayer.children.length).toBe(beforeModal);
    // …and a thumb redrawn into the wrong container would show up as +8 on the page instead, with
    // the modal's own thumb gone. (That was the first version's bug — see repaint.ts's drawBar.)
    expect(core.bodyLayer.children.length).toBe(beforeBody);
    scene.destroy();
  });

  it('an empty list registers no band, and dragging it is harmless', async () => {
    const { scene, input, core } = await mount(800, 1280);
    scene.modals.showSectPickModal([], vi.fn(), 'sect.noSects');
    expect(core.modalOpen).toBe(true);
    expect(core.modalMax).toBe(0);
    expect(core.repaint.layerFor('modal')).toBeNull();

    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(core.w / 2, core.h / 2);
    input._emitMove(core.w / 2, core.h / 2 - 70);
    scene.update(1 / 60);
    expect(core.modalOpen).toBe(true);
    expect(renderSpy).not.toHaveBeenCalled(); // rebuilds the (empty) modal at most, never the page
    scene.destroy();
  });

  it('a drag past the overscan band rebuilds the modal instead of running out of rows', async () => {
    // 200 entries: the extent is many viewports, so one long drag genuinely leaves the pre-built
    // window and has to fall back — for a modal that means core.modalRedraw, not render().
    const { scene, input, core } = await mount(800, 1280);
    const many = Array.from({ length: 200 }, (_, i) => ({
      sectId: `sect_${i}`, name: `Sect ${i}`, tag: `S${i}`, leaderId: 'x', leaderFamilyId: 'y',
      memberFamilyCount: 1, prosperity: 1, allySectIds: [],
    }));
    scene.modals.showSectPickModal(many as any, vi.fn(), 'sect.noSects');
    const first = core.repaint.layerFor('modal');
    expect(core.modalMax).toBeGreaterThan(core.repaint.overscanFor('modal'));

    const y = core.modalRegionTop + 40;
    input._emitDown(core.w / 2, y);
    input._emitMove(core.w / 2, y - (core.modalMax + 500));
    scene.update(1 / 60);

    expect(core.modalScrollY).toBe(core.modalMax);
    expect(core.repaint.layerFor('modal')).not.toBe(first); // rebuilt, not translated
    expect(visibleModalTexts(core).some((s) => s.includes('Sect 199'))).toBe(true);
    scene.destroy();
  });

  it('a modal whose layer was destroyed rebuilds through modalRedraw, not through render()', async () => {
    const { scene, input, core } = await openPicker();
    core.repaint.layerFor('modal').destroy();
    const real = core.modalRedraw!;
    const redraw = vi.fn(() => real());
    core.modalRedraw = redraw;
    const renderSpy = vi.spyOn(scene, 'render');

    input._emitDown(core.w / 2, core.modalRegionTop + 40);
    input._emitMove(core.w / 2, core.modalRegionTop - 20);
    scene.update(1 / 60);

    expect(redraw).toHaveBeenCalledTimes(1);
    expect(renderSpy).not.toHaveBeenCalled(); // the page has no business rebuilding for this
    expect(core.repaint.layerFor('modal')).toBeTruthy(); // a live tree again
    scene.destroy();
  });

  it('the read-only allies list still scrolls, and its rows stay untappable', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const onPick = vi.fn();
    scene.modals.showSectPickModal(MANY_SECTS as any, onPick, 'sect.noAllies', true);
    // Read-only means no row hits at all — only the dim-to-close rect.
    expect(core.modalHits.filter((h: any) => h.scroll === 'modal')).toHaveLength(0);
    expect(core.modalMax).toBeGreaterThan(0);

    const y = core.modalRegionTop + 40;
    input._emitDown(core.w / 2, y);
    input._emitMove(core.w / 2, y - 60);
    scene.update(1 / 60);
    expect(core.repaint.layerFor('modal').y).toBe(-60); // scrolls
    input._emitUp(core.w / 2, y - 60);

    input._emitDown(core.w / 2, y);
    input._emitUp(core.w / 2, y);
    expect(onPick).not.toHaveBeenCalled();
    // With no row hit registered, the tap falls through to the full-screen dim rect underneath and
    // dismisses the sheet. That predates the scroll work (rows never had hits here) and is fine for
    // a read-only list — pinned so it stays a decision rather than an accident.
    expect(core.modalOpen).toBe(false);
    scene.destroy();
  });

  it('tapping the dim closes the modal, but dragging on it does not', async () => {
    const { scene, input, core } = await openPicker();
    // Well above the panel: the only hit here is the full-screen dim rect.
    input._emitDown(core.w / 2, 20);
    input._emitMove(core.w / 2, 90); // a drag, so the tap is dropped
    input._emitUp(core.w / 2, 90);
    expect(core.modalOpen).toBe(true);

    input._emitDown(core.w / 2, 20);
    input._emitUp(core.w / 2, 20);
    expect(core.modalOpen).toBe(false);
    scene.destroy();
  });

  it('the confirm dialog still answers taps now that modal hits fire on pointer-up', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const onOk = vi.fn();
    scene.modals.showConfirm('Dissolve?', onOk);
    // Confirm dialogs register no scroll band, so their hits are plain screen-space rects.
    expect(core.modalRedraw).toBeNull();
    const hits = core.modalHits.filter((h: any) => h.rect.w < core.w); // skip the dim
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const ok = hits[0];
    input._emitDown(ok.rect.x + ok.rect.w / 2, ok.rect.y + ok.rect.h / 2);
    input._emitUp(ok.rect.x + ok.rect.w / 2, ok.rect.y + ok.rect.h / 2);
    expect(onOk).toHaveBeenCalledTimes(1);
    scene.destroy();
  });
});

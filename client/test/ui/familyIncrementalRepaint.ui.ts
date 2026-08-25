// Regression coverage for the FamilyScene incremental-repaint pass (2026-08-25) — the same fix the
// sect page got earlier the same day (see sectIncrementalRepaint.ui.ts), after the same user report. Four
// things each rebuilt the whole body (rail, info band, every hand-drawn member card, the chat
// column) to move exactly one thing:
//
//   - a drag/wheel scroll, once per rendered frame for the whole gesture;
//   - the focused field's caret, twice a second;
//   - every keystroke in the create form / channel send box;
//   - BusyTracker.tick() while a mutating action was in flight, which this scene draws nothing for.
//
// The roster is the interesting half here: unlike the sect page's, it had no mask at all — rows went
// straight onto bodyLayer — so this pass gave it its own masked, translatable layer (which also
// stops a row straddling the fold from bleeding past the viewport).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { ui as C } from '../../src/render/sketchUi';
import { MUTED } from '../../src/scenes/FamilyScene/lists';
import type { WorldApiClient, FamilyDetailView, FamilyMemberView, FamilyMessageView } from '../../src/net/WorldApiClient';

// Minimal DOM stub for the hidden-input fields, recording each element's listeners so a test can
// fire a real 'input' event the way a keystroke does (same stub shape as sectIncrementalRepaint.ui.ts).
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

const ME = 'acc_me';
const MEMBERS = 40;
const MESSAGES = 40;

/** I'm the leader, so every other row carries kick/role buttons — the roster's in-layer tap targets. */
const members: FamilyMemberView[] = [
  { accountId: ME, role: 'leader', joinedAt: 0, displayName: 'Me', publicId: '100000000' },
  ...Array.from({ length: MEMBERS - 1 }, (_, i) => ({
    accountId: `acc_${i}`, role: 'member' as const, joinedAt: 0, displayName: `Player${i}`, publicId: `20000000${i}`,
  })),
];

const FAM = {
  familyId: 'fam_1', name: 'Ink Wanderers', tag: 'INK', leaderId: ME,
  memberCount: MEMBERS, prosperity: 1280, announcement: '', members,
} as unknown as FamilyDetailView;

const MSGS: FamilyMessageView[] = Array.from({ length: MESSAGES }, (_, i) => ({
  id: `m${i}`, senderId: `acc_${i}`, senderName: `Player${i}`, body: `family chat line ${i}`, ts: 1000 + i,
}));

function stubWorldApi(): WorldApiClient {
  return {
    getMyFamily: async () => FAM,
    getFamily: async () => FAM,
    getFamilyChannel: async () => MSGS,
    listJoinRequests: async () => [],
    getProfileExtra: async () => ({}),
  } as unknown as WorldApiClient;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Mount FamilyScene straight into its my-family view and flush the load chain, so every case below
 *  starts from a fully painted page. */
async function mount(w: number, h: number): Promise<{ scene: any; input: InputManager; core: any }> {
  const input = new InputManager();
  const scene = new FamilyScene(createLayout(w, h), input, {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: ME, playerName: 'Me',
    preloadedFamily: FAM,
    addFriend: async () => {},
    getFriendPublicIds: async () => new Set<string>(),
    openChat() {},
  } as any) as any;
  await scene.data.loadData();
  expect(scene.core.mode).toBe('myFamily');
  expect(scene.core.messages).toHaveLength(MESSAGES);
  return { scene, input, core: scene.core };
}

/** A Text's ink colour as a number — PIXI normalises `style.fill` to a '#rrggbb' string. */
function fillOf(obj: PIXI.Text): number {
  const fill = obj.style.fill as unknown;
  return typeof fill === 'number' ? fill : parseInt(String(fill).replace('#', ''), 16);
}

/** Screen y of every roster tap target currently on screen, so a translated tree and a rebuilt one
 *  can be compared on what the player actually sees. */
function rosterRowScreenYs(core: any): number[] {
  const applied = core.repaint.appliedDelta('members');
  return core.hitRects
    .filter((hit: any) => hit.scroll === 'members')
    .map((hit: any) => Math.round(hit.rect.y - applied))
    .filter((y: number) => y >= core.membersRegionTop && y + core.rowH <= core.membersRegionBottom)
    .sort((a: number, b: number) => a - b);
}

describe('FamilyScene: a drag scrolls by translating the built column, not by rebuilding it', () => {
  it('portrait roster: a drag inside the overscan band renders zero times', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const renderSpy = vi.spyOn(scene, 'render');
    const layer = core.repaint.layerFor('members');
    expect(layer).toBeTruthy();
    expect(core.membersMax).toBeGreaterThan(0);
    expect(core.repaint.overscanFor('members')).toBeGreaterThan(200);

    // Drag upward (decreasing y): scrolls the roster down from scrollY = 0.
    input._emitDown(400, 900);
    input._emitMove(400, 880);
    input._emitMove(400, 860);
    input._emitMove(400, 840);
    expect(renderSpy).not.toHaveBeenCalled();

    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.repaint.layerFor('members')).toBe(layer); // same tree, just moved
    expect(layer.y).toBe(-60);
    expect(core.scrollY).toBe(60);

    // An idle frame does nothing at all.
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();

    // Past the band there are no pre-built rows left to show — fall back to one rebuild.
    input._emitMove(400, 900 - (core.repaint.overscanFor('members') + 100));
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('portrait roster: the translate lands rows exactly where a rebuild would', async () => {
    const { scene, input, core } = await mount(800, 1280);
    input._emitDown(400, 900);
    input._emitMove(400, 900 - 137); // an awkward offset, so an off-by-one can't hide
    scene.update(1 / 60);
    expect(core.scrollY).toBe(137);

    const translated = rosterRowScreenYs(core);
    expect(translated.length).toBeGreaterThan(3); // the comparison must not be vacuous

    scene.render(); // same scrollY, reached by a full rebuild instead of a translate
    expect(core.repaint.layerFor('members').y).toBe(0); // freshly baselined
    expect(rosterRowScreenYs(core)).toEqual(translated);
    scene.destroy();
  });

  it('portrait roster: a tap after a translate opens the member a rebuild would have', async () => {
    const { scene, input, core } = await mount(800, 1280);
    // Stub the popup out: it would swallow the second tap (handleDown returns early while open).
    const openProfile = vi.spyOn(core, 'openMemberProfile').mockImplementation(() => {});

    input._emitDown(400, 900);
    input._emitMove(400, 900 - 137);
    scene.update(1 / 60);
    const applied = core.repaint.appliedDelta('members');
    expect(applied).toBe(137);

    // The name/role rect (left-anchored at the row's own left edge, unlike the right-edge
    // kick/role buttons) is the row's profile tap target — pick one comfortably on screen and tap
    // where it *appears*.
    const target = core.hitRects
      .filter((hit: any) => hit.scroll === 'members' && hit.rect.x <= core.railW + 10)
      .map((hit: any) => ({ rect: hit.rect, sy: hit.rect.y - applied }))
      .find((h: any) => h.sy > core.membersRegionTop + 20 && h.sy + h.rect.h < core.membersRegionBottom - 20);
    expect(target).toBeTruthy();
    const px = target.rect.x + 20;
    const py = target.sy + target.rect.h / 2;

    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(openProfile).toHaveBeenCalledTimes(1);
    const afterTranslate = openProfile.mock.calls[0]![0];

    // Rebuild at the same scrollY, tap the identical screen point: same member.
    scene.render();
    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(openProfile).toHaveBeenCalledTimes(2);
    expect((openProfile.mock.calls[1]![0] as any).accountId).toBe((afterTranslate as any).accountId);
    scene.destroy();
  });

  it('portrait roster: a tap that lands outside the viewport (on an overscan row) misses', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const openProfile = vi.spyOn(core, 'openMemberProfile').mockImplementation(() => {});
    // Rows are built a viewport beyond the fold, so hit rects exist below it now. A tap down there
    // is on the bottom nav / page chrome, not on a row, and must not open anybody's profile.
    const below = core.hitRects.find((hit: any) => hit.scroll === 'members' && hit.rect.y > core.membersRegionBottom + 10);
    expect(below).toBeTruthy();
    const px = below.rect.x + 20;
    const py = below.rect.y + below.rect.h / 2;
    input._emitDown(px, py);
    input._emitUp(px, py);
    expect(openProfile).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('portrait channel tab: a drag translates the message column', async () => {
    const { scene, input, core } = await mount(800, 1280);
    core.activeTab = 'channel';
    scene.render();
    const layer = core.repaint.layerFor('channel');
    expect(layer).toBeTruthy();
    expect(core.channelMax).toBeGreaterThan(100);
    // Stuck to the latest message on entry, so there is room to drag back up through history.
    expect(core.scrollYChannel).toBe(core.channelMax);

    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 600);
    input._emitMove(400, 620);
    input._emitMove(400, 640);
    input._emitMove(400, 660);
    scene.update(1 / 60);

    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.repaint.layerFor('channel')).toBe(layer);
    expect(layer.y).toBe(60);
    expect(core.scrollYChannel).toBe(core.channelMax - 60);
    // Scrolling up off the bottom releases the stick-to-latest pin.
    expect(core.channelStick).toBe(false);
    scene.destroy();
  });

  it('landscape split view: dragging one column leaves the other one alone', async () => {
    const { scene, input, core } = await mount(1280, 800);
    const roster = core.repaint.layerFor('members');
    const channel = core.repaint.layerFor('channel');
    expect(roster).toBeTruthy();
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
    expect(roster.y).toBe(0);
    expect(core.scrollY).toBe(0);
    input._emitUp(chatX, 440);

    // Left of it: the roster, on scrollY — and the chat column must not follow.
    const rosterX = core.chatColX - 60;
    input._emitDown(rosterX, 400);
    input._emitMove(rosterX, 380);
    input._emitMove(rosterX, 360);
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(roster.y).toBe(-40);
    expect(channel.y).toBe(40); // unchanged
    expect(core.scrollYChannel).toBe(core.channelMax - 40);
    scene.destroy();
  });

  it('a wheel tick over one column translates only that column', async () => {
    const { scene, input, core } = await mount(1280, 800);
    const roster = core.repaint.layerFor('members');
    const channel = core.repaint.layerFor('channel');
    const renderSpy = vi.spyOn(scene, 'render');

    input._emitWheel(core.chatColX - 60, 400, 120);
    scene.update(1 / 60);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(roster.y).toBeLessThan(0);
    expect(channel.y).toBe(0);
    scene.destroy();
  });
});

describe('FamilyScene: the caret and keystrokes rewrite one Text, not the page', () => {
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

  it('a keystroke in the send box rewrites (and recolours) that one Text', async () => {
    const { scene, core } = await mount(800, 1280);
    core.activeTab = 'channel';
    scene.render();
    scene.input.openSendInput();
    scene.render();

    const field = core.repaint.caretField;
    // Empty field: the placeholder is drawn in the muted ink.
    expect(fillOf(field.obj)).toBe(MUTED);

    const renderSpy = vi.spyOn(scene, 'render');
    typeInto('hello');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.sendText).toBe('hello');
    expect(core.repaint.caretField.obj).toBe(field.obj);
    expect(field.obj.text).toContain('hello');
    expect(fillOf(field.obj)).toBe(C.dark);

    // Clearing it goes back to the muted placeholder colour, still without a rebuild.
    typeInto('');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(fillOf(field.obj)).toBe(MUTED);
    scene.destroy();
  });

  it('a keystroke in the create form rewrites that one Text', async () => {
    const { scene, core } = await mount(800, 1280);
    // The create form belongs to the no-family mode — drive the scene into it directly.
    core.family = null;
    core.mode = 'create';
    scene.render();
    scene.input.openInputFor('name');
    scene.render();

    const field = core.repaint.caretField;
    expect(field).toBeTruthy();

    const renderSpy = vi.spyOn(scene, 'render');
    // Short enough to survive truncateOrgName's display-width cap (ORG_NAME_WIDTH_MAX).
    typeInto('Ink Clan');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(core.createName).toBe('Ink Clan');
    expect(field.obj.text).toContain('Ink Clan');
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

describe('FamilyScene: the busy tracker no longer drives redraws', () => {
  it('ticking an in-flight action does not rebuild the page', async () => {
    const { scene, core } = await mount(800, 1280);
    const renderSpy = vi.spyOn(scene, 'render');
    // Nothing here draws bt's dots/loading overlay — it only greys buttons, and start()/stop() each
    // render on their own. This used to cost 2.5 rebuilds a second for no visual change.
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

/** Roster order of an accountId, so "the next row down" is checkable exactly. */
const rowIndex = (accountId: string): number => members.findIndex((m) => m.accountId === accountId);

/** Pick a roster row's name/profile target that is comfortably inside the viewport as displayed. */
function visibleRowTarget(core: any): { px: number; py: number } {
  const applied = core.repaint.appliedDelta('members');
  const hit = core.hitRects
    .filter((h: any) => h.scroll === 'members' && h.rect.x <= core.railW + 10)
    .map((h: any) => ({ rect: h.rect, sy: h.rect.y - applied }))
    .find((h: any) => h.sy > core.membersRegionTop + 30 && h.sy + h.rect.h < core.membersRegionBottom - 30);
  expect(hit).toBeTruthy();
  return { px: hit.rect.x + 20, py: hit.sy + hit.rect.h / 2 };
}

/** Tap a screen point and report which member the roster resolved it to (null = nothing fired). */
function tapMember(input: InputManager, spy: any, px: number, py: number): string | null {
  const before = spy.mock.calls.length;
  input._emitDown(px, py);
  input._emitUp(px, py);
  return spy.mock.calls.length > before
    ? ((spy.mock.calls[spy.mock.calls.length - 1]![0] as any).accountId as string)
    : null;
}

describe('FamilyScene: what the cheap scroll made possible to get wrong', () => {
  it('a drag past the end stops at the end instead of translating into blank space', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const max = core.membersMax;
    expect(max).toBeGreaterThan(0);

    // Park at the very end (a long drag leaves the overscan band, so this rebuilds and re-baselines).
    input._emitDown(400, 900);
    input._emitMove(400, 900 - (max + 300));
    scene.update(1 / 60);
    input._emitUp(400, 900 - (max + 300));
    expect(core.scrollY).toBe(max);
    expect(core.repaint.layerFor('members').y).toBe(0);

    // A further drag stays inside the band, so it takes the translate path — which used to move the
    // layer past the content's end and leave a blank strip nothing clamped back (the per-frame full
    // render that used to re-clamp is exactly what this pass removed).
    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 900);
    input._emitMove(400, 800);
    scene.update(1 / 60);
    expect(core.scrollY).toBe(max);
    expect(core.repaint.layerFor('members').y).toBe(0);
    expect(renderSpy).not.toHaveBeenCalled();

    // Reversing the finger must move the content immediately (no dead zone to unwind first).
    input._emitMove(400, 1000);
    scene.update(1 / 60);
    expect(core.scrollY).toBeLessThan(max);
    scene.destroy();
  });

  it('a tap right after a wheel tick — before the frame drains — hits what is on screen', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const openProfile = vi.spyOn(core, 'openMemberProfile').mockImplementation(() => {});
    const { px, py } = visibleRowTarget(core);
    const R = core.rowH;

    const before = tapMember(input, openProfile, px, py);
    expect(before).toBeTruthy();

    // Wheel exactly one row and do NOT tick: scrollY has moved, the layer has not. A tap judged
    // against the pending offset would resolve one row off; it must be judged against the screen.
    input._emitWheel(px, py, R);
    expect(core.scrollY).toBe(R);
    expect(core.repaint.appliedDelta('members')).toBe(0);
    expect(tapMember(input, openProfile, px, py)).toBe(before);

    scene.update(1 / 60);
    expect(core.repaint.appliedDelta('members')).toBe(R);
    expect(tapMember(input, openProfile, px, py)).not.toBe(before);
    scene.destroy();
  });

  it('after translating exactly one row, the same point hits the NEXT member', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const openProfile = vi.spyOn(core, 'openMemberProfile').mockImplementation(() => {});
    const { px, py } = visibleRowTarget(core);
    const R = core.rowH;

    const first = tapMember(input, openProfile, px, py)!;
    input._emitDown(px, py);
    input._emitMove(px, py - R);
    scene.update(1 / 60);
    input._emitUp(px, py - R);
    const second = tapMember(input, openProfile, px, py)!;

    expect(rowIndex(second)).toBe(rowIndex(first) + 1);
    scene.destroy();
  });

  it('the per-frame scrollbar redraw does not accumulate children', async () => {
    const { scene, input, core } = await mount(800, 1280);
    const before = core.bodyLayer.children.length;
    input._emitDown(400, 900);
    for (let i = 1; i <= 8; i++) {
      input._emitMove(400, 900 - i * 12);
      scene.update(1 / 60);
    }
    expect(core.repaint.appliedDelta('members')).toBe(96);
    expect(core.bodyLayer.children.length).toBe(before);
    scene.destroy();
  });

  it('falls back to a full render when the built layer is gone', async () => {
    const { scene, input, core } = await mount(800, 1280);
    core.repaint.layerFor('members').destroy();
    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 900);
    input._emitMove(400, 840);
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('a mode that builds no scroll layer at all still scrolls by falling back to render', async () => {
    const { scene, input, core } = await mount(800, 1280);
    core.family = null;
    core.mode = 'create';
    scene.render();
    expect(core.repaint.layerFor('members')).toBeNull();
    expect(core.repaint.layerFor('channel')).toBeNull();

    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(400, 900);
    input._emitMove(400, 840);
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('portrait builds exactly one column — the hidden tab has no stale band to translate', async () => {
    const { scene, core } = await mount(800, 1280);
    expect(core.activeTab).toBe('members');
    expect(core.repaint.layerFor('members')).toBeTruthy();
    expect(core.repaint.layerFor('channel')).toBeNull();

    core.activeTab = 'channel';
    scene.render();
    expect(core.repaint.layerFor('channel')).toBeTruthy();
    expect(core.repaint.layerFor('members')).toBeNull();
    scene.destroy();
  });

  it('channel: a translated column puts messages exactly where a rebuild would', async () => {
    const { scene, input, core } = await mount(1280, 800);
    const layer = core.repaint.layerFor('channel');
    expect(core.channelMax).toBeGreaterThan(50);

    const chatX = core.chatColX + 40;
    input._emitDown(chatX, 400);
    input._emitMove(chatX, 400 + 43); // awkward offset, and < channelMax so it stays a translate
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
    expect(layer.y).toBe(43);

    scene.render();
    expect(core.repaint.layerFor('channel').y).toBe(0);
    expect(screenYs()).toEqual(translated);
    scene.destroy();
  });

  it('the roster is masked to exactly its viewport, so the bottom row cannot bleed over the nav bar', async () => {
    // The pre-2026-08-25 roster drew straight onto bodyLayer with no mask at all: the row straddling
    // the fold was drawn in full and painted over the portrait bottom-nav bar. The mask that makes
    // the cheap scroll possible is also what clips it, so pin its rect against the viewport.
    const { scene, core } = await mount(800, 1280);
    const layer = core.repaint.layerFor('members');
    const mask = layer.mask as PIXI.Graphics;
    expect(mask).toBeTruthy();
    const b = mask.getBounds();
    expect(Math.round(b.y)).toBe(Math.round(core.membersRegionTop));
    expect(Math.round(b.y + b.height)).toBe(Math.round(core.membersRegionBottom));
    // …and the viewport itself stops short of the bottom nav bar.
    expect(core.membersRegionBottom).toBeLessThanOrEqual(core.bodyBottom);
    scene.destroy();
  });
});

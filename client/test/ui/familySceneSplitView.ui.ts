// Regression coverage for the 2026-07-13 FamilyScene layout work:
//   1. Landscape now shows the roster and family channel as two permanently-visible,
//      independently-scrolling columns (replacing a tab switch that left whichever
//      side wasn't selected mostly blank whenever the roster/history was short).
//   2. Portrait keeps the original tab switch (no width to spare for two columns).
//   3. Fixed a real bug surfaced while building the split view: `applyFamily()` is
//      `async` (it awaits loading channel messages) but was called without `await`
//      in both `loadData()` and `loadMyFamily()` — so the scene could render before
//      messages arrived. Invisible in the old tab UI (switching to the Channel tab
//      later re-rendered with the data already loaded by then); NOT invisible once
//      both columns render immediately in the split view.
//   4. The info band (`[TAG] Name` / prosperity / member count) was rewritten to
//      stack across rows + truncate long names with an ellipsis, since the original
//      single packed line collided with the member-count label on narrow widths.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import type { FamilyDetailView, FamilyMemberView, FamilyMessageView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeMembers(n: number): FamilyMemberView[] {
  const members: FamilyMemberView[] = [{ accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' }];
  for (let i = 0; i < n - 1; i++) {
    members.push({ accountId: `u${i}`, role: 'member', joinedAt: 0, displayName: `Player${i}`, publicId: `20${i}` });
  }
  return members;
}

/** `members` defaults to just the leader ('tao') — every test that needs more overrides it. */
function makeFamily(overrides: Partial<FamilyDetailView> = {}): FamilyDetailView {
  return {
    familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
    memberCount: 1, prosperity: 480, announcement: '', members: makeMembers(1),
    ...overrides,
  };
}

function makeMessages(n: number): FamilyMessageView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, senderId: 'u0', senderName: 'Player0', body: `Message number ${i} about strategy`, ts: i,
  }));
}

/** Builds a real FamilyScene (mixin chain assembled, headless PIXI) against a fake worldApi that
 *  resolves immediately with the given family/members/messages — enough to drive the real
 *  render code paths without a network or a full app graph. */
function buildScene(w: number, h: number, family: FamilyDetailView, messages: FamilyMessageView[]): any {
  const worldApi = {
    getMyFamily: async () => family,
    getFamilyChannel: async () => messages,
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
  };
  return new FamilyScene(createLayout(w, h), new InputManager(), cb as any);
}

/** Like `buildScene`, but bypasses `createLayout()` with a raw layout object so the design width
 *  actually is `w` — `PortraitLayout` otherwise pins `designWidth` to a fixed 1080 regardless of
 *  the physical screen size passed in, which would make a "narrow screen" test meaningless. Valid
 *  because `FamilySceneBase`'s constructor only reads `designWidth`/`designHeight`/`orientation`
 *  off its `layout` param (TS field privacy is erased at runtime — plain duck typing works). */
function buildSceneAtWidth(w: number, h: number, orientation: 'portrait' | 'landscape', family: FamilyDetailView, messages: FamilyMessageView[]): any {
  const worldApi = {
    getMyFamily: async () => family,
    getFamilyChannel: async () => messages,
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
  };
  const layout = { designWidth: w, designHeight: h, orientation } as any;
  return new FamilyScene(layout, new InputManager(), cb as any);
}

/** Flushes the getMyFamily → applyFamily → getFamilyChannel promise chain kicked off by the
 *  constructor's fire-and-forget `void this.loadData()`, by awaiting a fresh loadData() call
 *  directly — this is what actually regresses against the missing-`await` bug (see file header):
 *  with the bug, this resolves before `messages` is populated; with the fix, it doesn't. */
async function flush(scene: any): Promise<void> {
  await scene.loadData();
}

function textsOf(scene: any): string[] {
  return scene.bodyLayer.children
    .filter((c: unknown) => c instanceof PIXI.Text)
    .map((c: PIXI.Text) => c.text);
}

/** Header identity (title + landscape `[TAG] Name` / prosperity / count) is drawn on the scene
 *  container, on top of the cached header chrome — not in bodyLayer. */
function headerTextsOf(scene: any): string[] {
  return scene.container.children
    .filter((c: unknown) => c instanceof PIXI.Text)
    .map((c: PIXI.Text) => c.text);
}

describe('FamilyScene — data load ordering (applyFamily await regression)', () => {
  it('populates messages before loadData()s own promise resolves', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1 }), makeMessages(5));
    await flush(scene);

    expect(scene.mode).toBe('myFamily');
    expect(scene.messages).toHaveLength(5);
    expect(scene.messages[0].body).toBe('Message number 0 about strategy');
  });

  it('same fix applies to loadMyFamily() (used by the join-family flow)', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1 }), []);
    await flush(scene);
    scene.messages = [];

    scene.cb.worldApi.getFamily = async () => makeFamily({ memberCount: 1 });
    scene.cb.worldApi.getFamilyChannel = async () => makeMessages(3);
    await scene.loadMyFamily('fam1');

    expect(scene.messages).toHaveLength(3);
  });
});

describe('FamilyScene — landscape split view', () => {
  it('renders the roster AND the channel simultaneously (no tab switch)', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 3, members: makeMembers(3) }), makeMessages(2));
    await flush(scene);
    scene.render();

    const texts = textsOf(scene);
    // Roster content — leader + at least one other member row.
    expect(texts).toContain('tao');
    expect(texts).toContain('Player0');
    // Channel content — visible at the same time as the roster, not behind a tab.
    expect(texts.some((s) => s.includes('Message number 0'))).toBe(true);
    // Divider boundary was computed and sits strictly between the rail and the right edge.
    expect(scene.chatColX).toBeGreaterThan(scene.railW);
    expect(scene.chatColX).toBeLessThan(scene.w);
  });

  it('shows the empty-channel hint instead of leaving the column blank', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1 }), []);
    await flush(scene);
    scene.render();

    expect(textsOf(scene)).toContain('No messages yet');
  });

  it('scrolls the roster and channel columns independently', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 30, members: makeMembers(30) }), makeMessages(30));
    await flush(scene);
    scene.render();

    const midY = scene.h / 2;
    const rosterX = scene.railW + 10;
    const chatX = scene.chatColX + 10;

    // Drag up inside the roster column only.
    scene.handleDown(rosterX, midY);
    scene.handleMove(rosterX, midY - 80);
    scene.handleUp(rosterX, midY - 80);

    expect(scene.scrollY).toBeGreaterThan(0);
    expect(scene.scrollYChannel).toBe(0);

    const scrollYAfterFirstDrag = scene.scrollY;

    // Drag up inside the channel column only — must not disturb the roster's scroll.
    scene.handleDown(chatX, midY);
    scene.handleMove(chatX, midY - 80);
    scene.handleUp(chatX, midY - 80);

    expect(scene.scrollYChannel).toBeGreaterThan(0);
    expect(scene.scrollY).toBe(scrollYAfterFirstDrag);
  });
});

describe('FamilyScene — portrait keeps the tab switch', () => {
  it('shows only the active tab’s content and switches on tap', async () => {
    const scene = buildScene(390, 844, makeFamily({ memberCount: 1 }), makeMessages(2));
    await flush(scene);
    scene.render();

    expect(scene.activeTab).toBe('members');
    let texts = textsOf(scene);
    expect(texts).toContain('tao');
    expect(texts.some((s) => s.includes('Message number 0'))).toBe(false);

    const channelTabHit = scene.hitRects.find((h: any) =>
      h.rect.y === scene.headerH && h.rect.x > scene.railW + (scene.w - scene.railW) / 2 - 1);
    expect(channelTabHit).toBeTruthy();
    channelTabHit.action();

    expect(scene.activeTab).toBe('channel');
    texts = textsOf(scene);
    expect(texts.some((s) => s.includes('Message number 0'))).toBe(true);
    expect(texts).not.toContain('tao');
  });
});

describe('FamilyScene — portrait info band long-name handling', () => {
  it('truncates a long name with an ellipsis instead of colliding with the member count', async () => {
    const longFamily = makeFamily({
      name: 'Longwinded Scholars Guild', tag: 'LSGLD', memberCount: 1, prosperity: 123456,
    });
    const scene = buildSceneAtWidth(390, 844, 'portrait', longFamily, []);
    await flush(scene);
    scene.render();

    const children = scene.bodyLayer.children.filter((c: unknown) => c instanceof PIXI.Text) as PIXI.Text[];
    const nameLbl = children.find((c) => c.text.startsWith('[LSGLD]'));
    // "Members " (with the trailing space) picks the "Members 1/30" count label, not the bare
    // "Members" tab-bar label that portrait also draws (both would match a plain `.includes`).
    const countLbl = children.find((c) => c.text.startsWith('Members '));

    expect(nameLbl).toBeTruthy();
    expect(countLbl).toBeTruthy();
    expect(nameLbl!.text.endsWith('…')).toBe(true);
    // No collision: the (possibly truncated) name must end before the right-anchored count label.
    expect(nameLbl!.x + nameLbl!.width).toBeLessThanOrEqual(countLbl!.x);
  });
});

describe('FamilyScene — landscape lifts identity into the header', () => {
  it('shows title + [TAG] Name + prosperity + member count in the header, not the body', async () => {
    const scene = buildScene(1200, 950, makeFamily({ name: 'Iron Quill', tag: 'IRQ', memberCount: 3, members: makeMembers(3), prosperity: 480 }), []);
    await flush(scene);
    scene.render();

    const hdr = headerTextsOf(scene);
    expect(hdr).toContain('Family');            // scene title
    expect(hdr).toContain('[IRQ] Iron Quill');  // family name after the title
    expect(hdr.some((s) => s.includes('Prosperity') && s.includes('480'))).toBe(true);
    expect(hdr.some((s) => s.startsWith('Members '))).toBe(true); // Members 3/30 far-right

    // The identity is NOT duplicated in the body.
    expect(textsOf(scene).some((s) => s.startsWith('[IRQ]'))).toBe(false);
  });

  it('does not overlap the left identity cluster with the far-right member count', async () => {
    // A long name + big prosperity is the worst case for the single-line header.
    const scene = buildScene(1200, 760, makeFamily({
      name: 'Longwinded Scholars Guild', tag: 'LSGLD', memberCount: 12, members: makeMembers(12), prosperity: 987654,
    }), []);
    await flush(scene);
    scene.render();

    const children = scene.container.children.filter((c: unknown) => c instanceof PIXI.Text) as PIXI.Text[];
    const pros = children.find((c) => c.text.includes('Prosperity'));
    const count = children.find((c) => c.text.startsWith('Members '));
    expect(pros).toBeTruthy();
    expect(count).toBeTruthy();
    // Count is right-anchored (anchor.x=1): its left edge is count.x - count.width.
    expect(pros!.x + pros!.width).toBeLessThan(count!.x - count!.width);
  });
});

describe('FamilyScene — member rows & self action', () => {
  it('removes the Sect button and shows Dissolve on a lone leaders own row', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1, members: makeMembers(1) }), []);
    await flush(scene);
    scene.render();

    // The bottom-bar Sect button is gone. ('Sect' still legitimately appears as a left-rail nav tab
    // for a leader — assert only that no Sect control exists outside the rail.)
    const sectOutsideRail = (scene.bodyLayer.children as any[])
      .filter((c) => c instanceof PIXI.Text && c.text === 'Sect')
      .some((c) => c.x >= scene.railW);
    expect(sectOutsideRail).toBe(false);

    const texts = textsOf(scene);
    expect(texts).toContain('Dissolve Family');     // sole leader → dissolve, on the roster row
    expect(texts).not.toContain('Leave Family');
  });

  it('hides both Leave and Dissolve for a leader while other members remain', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 3, members: makeMembers(3) }), []);
    await flush(scene);
    scene.render();

    const texts = textsOf(scene);
    expect(texts).not.toContain('Leave Family');
    expect(texts).not.toContain('Dissolve Family');
  });

  it('shows Leave Family on a non-leaders own row', async () => {
    // 'me' is a plain member here; the leader is someone else.
    const members: FamilyMemberView[] = [
      { accountId: 'boss', role: 'leader', joinedAt: 0, displayName: 'Boss', publicId: '1' },
      { accountId: 'me', role: 'member', joinedAt: 0, displayName: 'tao', publicId: '2' },
    ];
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 2, members, leaderId: 'boss' }), []);
    await flush(scene);
    scene.render();

    const texts = textsOf(scene);
    expect(texts).toContain('Leave Family');
    expect(texts).not.toContain('Dissolve Family');
  });

  it('draws the role label to the right of the member name, vertically aligned (not stacked above)', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1, members: makeMembers(1) }), []);
    await flush(scene);
    scene.render();

    const rows = scene.bodyLayer.children.filter((c: unknown) => c instanceof PIXI.Text) as PIXI.Text[];
    const name = rows.find((c) => c.text === 'tao')!;
    const role = rows.find((c) => c.text === 'Leader')!;
    expect(name).toBeTruthy();
    expect(role).toBeTruthy();
    // Role starts after the name ends horizontally.
    expect(role.x).toBeGreaterThanOrEqual(name.x + name.width);
    // …and sits on roughly the same line (centres within a few px), not stacked above it.
    const nameMid = name.y + name.height / 2;
    const roleMid = role.y + role.height / 2;
    expect(Math.abs(nameMid - roleMid)).toBeLessThan(scene.rowH * 0.25);
  });

  it('gives each visible member row a card background behind the text', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 3, members: makeMembers(3) }), []);
    await flush(scene);
    scene.render();

    // sketchPanel() row backgrounds are Containers (not Text/Graphics accent bars). There must be
    // at least one background container per rendered member row.
    const panels = scene.bodyLayer.children.filter(
      (c: unknown) => c instanceof PIXI.Container && !(c instanceof PIXI.Text),
    );
    expect(panels.length).toBeGreaterThanOrEqual(3);
  });

  it('clicking Dissolve on a lone leaders row triggers confirmDissolve', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1, members: makeMembers(1) }), []);
    await flush(scene);
    scene.confirmDissolve = vi.fn();
    scene.render();

    const btn = (scene.bodyLayer.children as PIXI.Text[]).find(
      (c) => c instanceof PIXI.Text && c.text === 'Dissolve Family',
    )!;
    // Label anchor is (0.5,0.5) so its x/y are the button centre — route a tap there.
    scene.handleDown(btn.x, btn.y);
    expect(scene.confirmDissolve).toHaveBeenCalledTimes(1);
  });

  it('clicking Leave on a non-leaders row triggers confirmLeave', async () => {
    const members: FamilyMemberView[] = [
      { accountId: 'boss', role: 'leader', joinedAt: 0, displayName: 'Boss', publicId: '1' },
      { accountId: 'me', role: 'member', joinedAt: 0, displayName: 'tao', publicId: '2' },
    ];
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 2, members, leaderId: 'boss' }), []);
    await flush(scene);
    scene.confirmLeave = vi.fn();
    scene.render();

    const btn = (scene.bodyLayer.children as PIXI.Text[]).find(
      (c) => c instanceof PIXI.Text && c.text === 'Leave Family',
    )!;
    scene.handleDown(btn.x, btn.y);
    expect(scene.confirmLeave).toHaveBeenCalledTimes(1);
  });
});

describe('FamilyScene — channel send box shows the draft (input fix, render half)', () => {
  it('renders the typed draft + blinking caret while the field is focused', async () => {
    // Landscape shows the channel column permanently, so no tab switch is needed.
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1, members: makeMembers(1) }), []);
    await flush(scene);
    scene.sendInput = {}; // truthy → the field is "focused/active"
    scene.sendText = 'hello';

    scene.caretOn = true;
    scene.render();
    expect(textsOf(scene)).toContain('hello|');

    scene.caretOn = false;
    scene.render();
    const off = textsOf(scene);
    expect(off).toContain('hello');
    expect(off).not.toContain('hello|');
  });

  it('shows the placeholder (no caret) when the field is not focused', async () => {
    const scene = buildScene(1200, 950, makeFamily({ memberCount: 1, members: makeMembers(1) }), []);
    await flush(scene);
    scene.sendInput = null;
    scene.sendText = '';
    scene.caretOn = true;
    scene.render();

    const texts = textsOf(scene);
    expect(texts).toContain('Type a message…');
    expect(texts).not.toContain('|');
  });
});

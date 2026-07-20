// Regression coverage for the 2026-07-17 SectScene layout work: landscape now shows the member
// families and the sect channel as two permanently-visible, independently-scrolling columns
// (matching FamilyScene's split view), replacing the tab switch that left whichever side wasn't
// selected mostly blank. Portrait keeps the original tab switch.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { SectScene } from '../../src/scenes/SectScene';
import type { FamilyDetailView, SectDetailView, SectMemberFamilyView, SectMessageView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeFamilies(n: number): SectMemberFamilyView[] {
  return Array.from({ length: n }, (_, i) => ({
    familyId: i === 0 ? 'fam:LEAD' : `fam:${i}`,
    name: i === 0 ? 'Iron Quill' : `Guild ${i}`,
    tag: i === 0 ? 'IRQ' : `G${i}`,
    leaderId: i === 0 ? 'me' : `boss${i}`,
    memberCount: 1 + i,
    territoryCount: i,
  }));
}

function makeSect(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect1', worldId: 'w1', name: 'Great Nation', tag: 'TAO',
    leaderFamilyId: 'fam:LEAD', leaderId: 'me', memberFamilyCount: 1,
    allySectIds: [], prosperity: 0, memberFamilies: makeFamilies(1),
    ...overrides,
  };
}

function makeMyFamily(): FamilyDetailView {
  return {
    familyId: 'fam:LEAD', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
    memberCount: 1, prosperity: 0, sectId: 'sect1',
    members: [{ accountId: 'me', role: 'leader', joinedAt: 0 }],
  };
}

function makeMessages(n: number): SectMessageView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, senderId: 'u0', senderName: 'Player0', body: `Sect message ${i} about war`, ts: i,
  }));
}

function buildScene(w: number, h: number, orientation: 'portrait' | 'landscape', sect: SectDetailView, messages: SectMessageView[]): any {
  const worldApi = {
    getMyFamily: async () => makeMyFamily(),
    getSect: async () => sect,
    getSectChannel: async () => messages,
  };
  const cb = {
    onBack() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
    getCoins: () => 0, refreshWallet: async () => {},
  };
  const layout = { designWidth: w, designHeight: h, orientation } as any;
  return new SectScene(layout, new InputManager(), cb as any);
}

// Rows are drawn into masked sub-containers (the scroll-peek clip), so walk the whole
// bodyLayer subtree rather than only its direct children.
function textsOf(scene: any): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) out.push(c.text);
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(scene.bodyLayer);
  return out;
}

async function flush(scene: any): Promise<void> {
  await scene.loadData();
}

describe('SectScene — landscape split view', () => {
  it('renders the member families AND the sect channel simultaneously (no tab switch)', async () => {
    const scene = buildScene(1200, 950, 'landscape', makeSect({ memberFamilyCount: 3, memberFamilies: makeFamilies(3) }), makeMessages(2));
    await flush(scene);
    scene.render();

    const texts = textsOf(scene);
    // Families content.
    expect(texts.some((s) => s.includes('[IRQ] Iron Quill'))).toBe(true);
    expect(texts.some((s) => s.includes('[G1] Guild 1'))).toBe(true);
    // Channel content — visible at the same time as the families, not behind a tab.
    expect(texts.some((s) => s.includes('Sect message 0'))).toBe(true);
    // Divider boundary was computed and sits strictly between the rail and the right edge.
    expect(scene.chatColX).toBeGreaterThan(scene.railW);
    expect(scene.chatColX).toBeLessThan(scene.w);
  });

  it('shows the empty-channel hint instead of leaving the column blank', async () => {
    const scene = buildScene(1200, 950, 'landscape', makeSect(), []);
    await flush(scene);
    scene.render();

    expect(textsOf(scene)).toContain('No messages');
  });

  it('scrolls the families and channel columns independently', async () => {
    const scene = buildScene(1200, 950, 'landscape', makeSect({ memberFamilyCount: 40, memberFamilies: makeFamilies(40) }), makeMessages(40));
    await flush(scene);
    scene.render();

    const midY = scene.h / 2;
    const familiesX = scene.railW + 10;
    const chatX = scene.chatColX + 10;

    // Drag up inside the families column only.
    scene.handleDown(familiesX, midY);
    scene.handleMove(familiesX, midY - 80);
    scene.handleUp(familiesX, midY - 80);

    expect(scene.scrollY).toBeGreaterThan(0);
    expect(scene.scrollYChannel).toBe(0);

    const scrollYAfterFirstDrag = scene.scrollY;

    // Drag up inside the channel column only — must not disturb the families' scroll.
    scene.handleDown(chatX, midY);
    scene.handleMove(chatX, midY - 80);
    scene.handleUp(chatX, midY - 80);

    expect(scene.scrollYChannel).toBeGreaterThan(0);
    expect(scene.scrollY).toBe(scrollYAfterFirstDrag);
  });
});

describe('SectScene — portrait keeps the tab switch', () => {
  it('shows only the active tab’s content and switches on tap', async () => {
    const scene = buildScene(390, 844, 'portrait', makeSect(), makeMessages(2));
    await flush(scene);
    scene.render();

    expect(scene.activeTab).toBe('families');
    let texts = textsOf(scene);
    expect(texts.some((s) => s.includes('[IRQ] Iron Quill'))).toBe(true);
    expect(texts.some((s) => s.includes('Sect message 0'))).toBe(false);

    const channelTabHit = scene.hitRects.find((h: any) =>
      h.rect.y === scene.headerH && h.rect.x > scene.railW + (scene.w - scene.railW) / 2 - 1);
    expect(channelTabHit).toBeTruthy();
    channelTabHit.action();

    expect(scene.activeTab).toBe('channel');
    texts = textsOf(scene);
    expect(texts.some((s) => s.includes('Sect message 0'))).toBe(true);
  });
});

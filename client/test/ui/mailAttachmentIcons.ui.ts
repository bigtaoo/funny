// Regression test for "add one picture per mail attachment, laid out horizontally below the
// attachment name list" (20.07.2026). drawMailDetail() used to show attachments as a bare text
// list ("· Equipment Wax Seal +9"); drawAttachmentIcon() now also draws a framed square picture
// per attachment (equipment/card/material/coins reuse the same "single source of truth" icon
// resolvers as Equipment/Auction/Gacha), placed left-to-right underneath.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene, type FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import type { MailView } from '../../src/net/ApiClient';
import { cardInstanceArtUrl } from '../../src/render/cardArt';

// Every export passes through untouched except cardInstanceArtUrl, wrapped in vi.fn (keeping its
// real implementation) so the 2026-08-01-scoping spec below can inspect call arguments.
vi.mock('../../src/render/cardArt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/cardArt')>();
  return { ...actual, cardInstanceArtUrl: vi.fn(actual.cardInstanceArtUrl) };
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

const [W, H] = [800, 1280];

function build(cb: Partial<FriendsSceneCallbacks> = {}): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    loadConversations: async () => [],
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
    ...cb,
  });
}

/** Frames are square sketchPanel()s sized to `scene.h * 0.07` (drawMailDetail's iconSize) —
 *  everything else in the detail view (name text, wide buttons) is either not a Graphics or not
 *  square at that size. `scene.h` is the layout's design height, not the raw createLayout input —
 *  ScalingManager pins/stretches axes, so it must be read back off the scene, not recomputed. */
function frames(scene: any): PIXI.Container[] {
  const iconSize = Math.round(scene.h * 0.07);
  return (scene.container.children as PIXI.Container[]).filter(
    (c) => c instanceof PIXI.Graphics
      && Math.abs(c.width - iconSize) < 4
      && Math.abs(c.height - iconSize) < 4,
  );
}

const mixedMail: MailView = {
  mailId: 'gift:a', from: 'system', subject: 'Auction item received', body: 'enjoy',
  createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
  attachments: [
    { kind: 'equipment', id: 'tk_seal', count: 1, instance: { id: 'i1', defId: 'tk_seal', rarity: 'epic', level: 9, affixes: [], locked: false } },
    { kind: 'material', id: 'lead', count: 6 },
    { kind: 'coins', count: 500 },
  ],
} as unknown as MailView;

describe('FriendsScene mail detail — one picture per attachment, arranged horizontally', () => {
  it('draws one square frame per attachment, same row, strictly left-to-right and non-overlapping', () => {
    const scene = build();
    scene.container.removeChildren();
    scene.drawMailDetail(mixedMail);

    const fs = frames(scene);
    expect(fs.length).toBe(3);

    const ys = new Set(fs.map((f) => f.y));
    expect(ys.size).toBe(1); // one row

    const iconSize = Math.round(scene.h * 0.07);
    const xs = fs.map((f) => f.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] + iconSize);

    scene.destroy();
  });

  it('each frame is immediately followed by exactly one picture on top of it', () => {
    const scene = build();
    scene.container.removeChildren();
    scene.drawMailDetail(mixedMail);

    const iconSize = Math.round(scene.h * 0.07);
    const children = scene.container.children as PIXI.Container[];
    const frameIdxs = children
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c instanceof PIXI.Graphics && Math.abs(c.width - iconSize) < 4 && Math.abs(c.height - iconSize) < 4)
      .map(({ i }) => i);
    expect(frameIdxs).toHaveLength(3);
    // Consecutive frame/picture pairs: no stray children (e.g. from a different attachment's
    // frame) wedged in between a frame and its own picture.
    for (let k = 1; k < frameIdxs.length; k++) expect(frameIdxs[k] - frameIdxs[k - 1]).toBe(2);

    scene.destroy();
  });

  it('an attachment kind with no icon mapping still gets exactly one fallback picture, not zero', () => {
    const scene = build();
    const unknownMail: MailView = {
      ...mixedMail,
      attachments: [{ kind: 'item', id: 'whatever_unmapped', count: 1 }],
    } as unknown as MailView;
    scene.container.removeChildren();
    scene.drawMailDetail(unknownMail);

    expect(frames(scene)).toHaveLength(1);
    scene.destroy();
  });

  it('no attachments: detail view renders with no leftover icon frames', () => {
    const scene = build();
    const plainMail: MailView = {
      mailId: 'plain:a', from: 'system', subject: 'Hello', body: 'hi',
      createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
    } as unknown as MailView;
    scene.container.removeChildren();
    scene.drawMailDetail(plainMail);

    expect(frames(scene)).toHaveLength(0);
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-01 scoping decision (UI_DESIGN.md §27 addendum): a card
// attachment's thumbnail must always be the base portrait, never whichever skin the account has
// equipped for that unit type — a gift/auction-refund mail preview isn't the place to reflect the
// recipient's own equipped cosmetics. The earlier `getEquippedSkins` callback was removed from
// FriendsSceneCallbacks entirely, so this locks in that drawMailDetail keeps resolving through
// `cardInstanceArtUrl(instance)` with no second (equipped) argument.
describe('FriendsScene mail detail — card attachment always uses the base portrait, never an equipped skin', () => {
  const cardMail: MailView = {
    mailId: 'gift:card', from: 'system', subject: 'A gift card', body: 'enjoy',
    createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
    attachments: [
      { kind: 'card', id: 'lichuang', count: 1, instance: { id: 'i1', defId: 'lichuang', rarity: 'common', level: 1, affixes: [], locked: false } },
    ],
  } as unknown as MailView;

  it('passes only the card instance, never an equipped-skin map, when drawing the thumbnail', () => {
    const spy = cardInstanceArtUrl as unknown as { mock: { calls: unknown[][] } };
    spy.mock.calls.length = 0;
    const scene = build();
    scene.container.removeChildren();
    scene.drawMailDetail(cardMail);

    const cardCalls = spy.mock.calls.filter((call) => (call[0] as { defId?: string } | undefined)?.defId === 'lichuang');
    expect(cardCalls.length).toBeGreaterThan(0);
    for (const call of cardCalls) expect(call.length === 1 || call[1] === undefined).toBe(true);
    scene.destroy();
  });
});

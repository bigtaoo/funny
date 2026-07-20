// Regression test for "add one picture per mail attachment, laid out horizontally below the
// attachment name list" (20.07.2026). drawMailDetail() used to show attachments as a bare text
// list ("· Equipment Wax Seal +9"); drawAttachmentIcon() now also draws a framed square picture
// per attachment (equipment/card/material/coins reuse the same "single source of truth" icon
// resolvers as Equipment/Auction/Gacha), placed left-to-right underneath.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { MailView } from '../../src/net/ApiClient';

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

function build(): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {},
    loadConversations: async () => [],
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
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
    { kind: 'material', id: 'mat_lead', count: 6 },
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

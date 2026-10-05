// Player safety UI (App Review Guideline 1.2) — the dialogs, their stage-level host, and the feeds
// that must drop a blocked player's content the moment the block is confirmed.
//
// The reviewer films: EULA before login, flagging a message, blocking its author. So this file
// drives exactly that path headlessly:
//   * a chat row → the sender's card carries Report + Block;
//   * Report → a category → the report goes out with the category and the message snapshot;
//   * Block → confirm → the sender's messages vanish from the feed without any reload;
//   * the host raises the modal input gate once per overlay and releases it on every close path;
//   * every dialog stays on screen in all three locales, portrait and landscape.
//
// Run: npm run test:ui
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, t, type Locale } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { ChatScene } from '../../src/scenes/ChatScene';
import { ProfilePopup } from '../../src/ui/dialogs/ProfilePopup';
import { ReportDialog, BlockConfirmDialog, BlockedPlayersDialog } from '../../src/ui/dialogs/ModerationDialogs';
import { installModerationHost } from '../../src/ui/dialogs/moderationHost';
import {
  setModerationBackend, setModerationSink, resetBlockedPlayers, markBlocked, isBlocked, REPORT_CATEGORIES,
  requestReport, requestBlock, openPlayerCard, type ModerationBackend,
} from '../../src/ui/moderation';
import type { WorldChatMessage } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { monospaceWidth } from '../../src/render/pixiText';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const ME = '100000001';
const TROLL = '200000002';

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) { out.push(ch); continue; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function tappables(root: PIXI.Container): PIXI.Container[] {
  const out: PIXI.Container[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (!(ch instanceof PIXI.Container)) continue;
      if (ch.listenerCount('pointertap') > 0) out.push(ch);
      walk(ch);
    }
  };
  walk(root);
  return out;
}

/** Tap the PIXI button under the label `label` (the same way a finger would: by its bounds). */
function tap(root: PIXI.Container, label: string): void {
  const node = texts(root).find((n) => n.text === label);
  if (!node) throw new Error(`no "${label}" (have: ${texts(root).map((n) => n.text).join(' | ')})`);
  const b = node.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const btn = tappables(root).reverse().find((c) => c !== root && c.getBounds().contains(cx, cy) && !(c.getBounds().width >= root.getBounds().width * 0.99));
  if (!btn) throw new Error(`"${label}" carries no tap handler`);
  btn.emit('pointertap', {} as PIXI.FederatedPointerEvent);
}

function backend(): ModerationBackend & { reports: unknown[]; blocks: unknown[]; unblocks: string[] } {
  const reports: unknown[] = [];
  const blocks: unknown[] = [];
  const unblocks: string[] = [];
  return {
    reports, blocks, unblocks,
    report: async (publicId, ctx) => { reports.push({ publicId, ...ctx }); },
    block: async (publicId, ctx) => { blocks.push({ publicId, ...ctx }); },
    unblock: async (publicId) => { unblocks.push(publicId); },
    listBlocked: async () => [],
    selfPublicId: () => ME,
  };
}

function host(w = 800, h = 1280) {
  const stage = new PIXI.Container();
  const gameLayer = new PIXI.Container();
  gameLayer.scale.set(0.5);
  let held = 0;
  const input = new InputManager();
  const hold = input.holdForModal.bind(input);
  input.holdForModal = (on: boolean): void => { held += on ? 1 : -1; hold(on); };
  const handle = installModerationHost({
    stage,
    screen: () => ({ width: w / 2, height: h / 2 }),
    gameLayer,
    designSize: () => ({ w, h }),
    input,
  });
  return { stage, handle, input, held: () => held };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetBlockedPlayers();
  setModerationBackend(null);
  setModerationSink(null);
  setLocale('en');
});

describe('moderation dialogs fit the screen', () => {
  const VIEWPORTS: Array<[number, number]> = [[1080, 2337], [1920, 1080], [800, 1280], [1280, 800]];
  const target = { publicId: TROLL, name: 'Maximiliane-Vandenberghe', content: { channel: 'world' as const, text: 'x'.repeat(300) } };
  for (const locale of ['zh', 'en', 'de'] as Locale[]) {
    for (const [w, h] of VIEWPORTS) {
      it(`[${locale}] ${w}x${h}: report / block / blocked-list keep every label inside the screen`, () => {
        setLocale(locale);
        const many = Array.from({ length: 9 }, (_, i) => ({ publicId: `3000000${i}0`, displayName: `Player ${i}`, ts: i }));
        const dialogs = [
          new ReportDialog(w, h, target, { onSubmit: async () => {}, onClose() {} }),
          new BlockConfirmDialog(w, h, target, { onConfirm() {}, onClose() {} }),
          new BlockedPlayersDialog(w, h, many, { load: async () => many, onUnblock: async () => {}, onClose() {} }),
        ];
        for (const d of dialogs) {
          for (const n of texts(d.container)) {
            const b = n.getBounds();
            expect(b.x, `"${n.text}" spills left`).toBeGreaterThanOrEqual(0);
            expect(b.y, `"${n.text}" spills above`).toBeGreaterThanOrEqual(0);
            expect(b.x + b.width, `"${n.text}" spills right`).toBeLessThanOrEqual(w);
            expect(b.y + b.height, `"${n.text}" spills below`).toBeLessThanOrEqual(h);
          }
          d.destroy();
        }
      });
    }
  }

  /** Menlo's bold advance (iOS 'monospace'), measured on device as the reason for this test. */
  const MENLO_EM = 0.6;
  // Each category is a one-tap answer, so its label must read in full: on an iPhone in landscape the
  // three-column grid cut "Harassment / bullying" to "Harassment / bullyi…" (seen on device,
  // 2026-10-04). iOS resolves 'monospace' to Menlo, ~0.6 em bold against the 0.54 em headless
  // metric (and the headless canvas stub measures narrower still), so measurement is replaced with
  // Menlo's advance here — with either headless metric the label still fits and nothing fails.
  for (const locale of ['zh', 'en', 'de'] as Locale[]) {
    for (const [w, h] of [[1688, 780], [1560, 720], [1920, 1080], [720, 1560], [1080, 2337]] as Array<[number, number]>) {
      it(`[${locale}] ${w}x${h}: every report category label is shown in full with iOS-wide glyphs`, () => {
        setLocale(locale);
        const measure = PIXI.TextMetrics.measureText.bind(PIXI.TextMetrics);
        const spy = vi.spyOn(PIXI.TextMetrics, 'measureText').mockImplementation((...args) => {
          const m = measure(...args);
          const size = Number((args[1] as PIXI.TextStyle).fontSize);
          return Object.assign(Object.create(Object.getPrototypeOf(m)), m, { width: monospaceWidth(args[0], size) * (MENLO_EM / 0.54) });
        });
        try {
          const d = new ReportDialog(w, h, target, { onSubmit: async () => {}, onClose() {} });
          const shown = texts(d.container).map((n) => n.text);
          for (const key of ['harassment', 'hate', 'sexual', 'spam', 'cheating', 'offensiveName', 'other'] as const) {
            expect(shown).toContain(t(`moderation.cat.${key}`));
          }
          d.destroy();
        } finally {
          spy.mockRestore();
        }
      });
    }
  }

  it('the report dialog offers all seven categories', () => {
    const d = new ReportDialog(800, 1280, target, { onSubmit: async () => {}, onClose() {} });
    const labels = texts(d.container).map((n) => n.text);
    for (const key of ['harassment', 'hate', 'sexual', 'spam', 'cheating', 'offensiveName', 'other'] as const) {
      expect(labels).toContain(t(`moderation.cat.${key}`));
    }
    expect(REPORT_CATEGORIES).toHaveLength(7);
    d.destroy();
  });
});

describe('ProfilePopup action rows', () => {
  it('puts at most two buttons on a row, Report/Block together on the last one', () => {
    const popup = new ProfilePopup(800, 1280);
    popup.show({
      name: 'them', publicId: TROLL,
      actions: [
        { labelKey: 'friends.report', fn() {}, danger: true },
        { labelKey: 'friends.message', fn() {} },
        { labelKey: 'friends.block', fn() {}, danger: true },
      ],
    });
    const y = (label: string): number => texts(popup.container).find((n) => n.text === t(label as never))!.getBounds().y;
    expect(y('friends.report')).toBeCloseTo(y('friends.block'), 0);
    expect(y('friends.message')).toBeLessThan(y('friends.report'));
    popup.destroy();
  });
});

describe('stage-level host: report / block flows and the modal input gate', () => {
  it('report: category tap sends category + message, closes, and releases the gate', async () => {
    const b = backend();
    setModerationBackend(b);
    const { stage, held } = host();
    const content = { channel: 'world' as const, messageId: 'm1', text: 'you are trash' };
    requestReport({ publicId: TROLL, name: 'Troll', content });
    expect(held()).toBe(1);
    expect(texts(stage).map((n) => n.text)).toContain(t('moderation.reportTitle', { name: 'Troll' }));
    tap(stage, t('moderation.cat.harassment'));
    await flush();
    expect(b.reports).toEqual([{ publicId: TROLL, category: 'harassment', reason: 'harassment', content }]);
    expect(held()).toBe(0);
    expect(stage.children).toHaveLength(0);
    await tick();
  });

  it('block: confirm hides the player at once, sends the block, and releases the gate', async () => {
    const b = backend();
    setModerationBackend(b);
    const { stage, held } = host();
    requestBlock({ publicId: TROLL, name: 'Troll' });
    expect(texts(stage).map((n) => n.text)).toContain(t('moderation.blockBody'));
    tap(stage, t('moderation.blockConfirm'));
    expect(isBlocked(TROLL)).toBe(true);
    expect(held()).toBe(0);
    await flush();
    expect(b.blocks).toEqual([{ publicId: TROLL }]);
    await tick();
  });

  it('card → Report replaces the card without double-raising the gate; Cancel releases it', async () => {
    setModerationBackend(backend());
    const { stage, held } = host();
    openPlayerCard({ publicId: TROLL, name: 'Troll' });
    expect(held()).toBe(1);
    tap(stage, t('friends.report'));
    expect(held()).toBe(1);
    expect(texts(stage).map((n) => n.text)).toContain(t('moderation.reportTitle', { name: 'Troll' }));
    tap(stage, t('moderation.cancel'));
    expect(held()).toBe(0);
    await tick();
  });

  it('taps reach the overlay through the InputManager modal channel (design space), never the scene', async () => {
    const b = backend();
    setModerationBackend(b);
    const { stage, input, held } = host();
    const sceneUps: number[] = [];
    input.onUp(() => sceneUps.push(1));
    requestBlock({ publicId: TROLL, name: 'Troll' });
    // Design-space centre of the Block button = its screen-space bounds / the gameLayer scale (0.5).
    const lbl = texts(stage).find((n) => n.text === t('moderation.blockConfirm'))!.getBounds();
    const [x, y] = [(lbl.x + lbl.width / 2) / 0.5, (lbl.y + lbl.height / 2) / 0.5];
    input._emitUp(x, y); // an up without a down under the gate (the tap that opened it) is ignored
    expect(isBlocked(TROLL)).toBe(false);
    input._emitDown(x, y);
    input._emitUp(x, y);
    expect(isBlocked(TROLL)).toBe(true);
    expect(held()).toBe(0);
    expect(sceneUps).toEqual([]);
    await flush();
    expect(b.blocks).toEqual([{ publicId: TROLL }]);
    await tick();
  });

  it('never offers report / block on the player themselves', () => {
    setModerationBackend(backend());
    const { held } = host();
    openPlayerCard({ publicId: ME, name: 'me' });
    requestBlock({ publicId: ME, name: 'me' });
    expect(held()).toBe(0);
  });

  it('blocked-players list: Unblock removes the row once the server agrees', async () => {
    const b = backend();
    b.listBlocked = async () => [{ publicId: TROLL, displayName: 'Troll', ts: 1 }];
    setModerationBackend(b);
    markBlocked(TROLL, 'Troll');
    const d = new BlockedPlayersDialog(800, 1280, [{ publicId: TROLL, displayName: 'Troll', ts: 1 }], {
      load: b.listBlocked, onUnblock: async (p) => { await b.unblock(p.publicId); }, onClose() {},
    });
    await flush();
    expect(texts(d.container).map((n) => n.text)).toContain('Troll');
    tap(d.container, t('moderation.unblock'));
    await flush();
    expect(b.unblocks).toEqual([TROLL]);
    expect(texts(d.container).map((n) => n.text)).toContain(t('moderation.blockedEmpty'));
    d.destroy();
  });
});

describe('feeds hide a blocked player instantly', () => {
  function worldScene(messages: WorldChatMessage[]): any {
    return new FriendsScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      myPublicId: ME, getProfileExtra: async () => ({}),
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '999999999', displayName: 'Nobody' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, duelInvite: () => {}, duelRespond: () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
      loadSLGStatus: async () => null,
      loadWorldChat: async () => messages,
      defaultTab: 'world',
      openTextInput: createFakeTextInput().openTextInput,
    });
  }

  it('world chat: the sender card has Report + Block, and blocking drops their rows without a reload', async () => {
    setModerationBackend(backend());
    const { stage } = host();
    const messages: WorldChatMessage[] = [
      { id: 'm1', senderId: 'a', senderName: 'Troll', senderPublicId: TROLL, body: 'nasty words', ts: 1 },
      { id: 'm2', senderId: 'b', senderName: 'Nice', senderPublicId: '300000003', body: 'hello all', ts: 2 },
    ];
    const scene = worldScene(messages);
    await flush();
    const bodies = (): string => texts(scene.container).map((n) => n.text).join('|');
    expect(bodies()).toContain('nasty words');

    // The row's tap opens the sender card; its actions include the two safety buttons.
    scene.worldChat.openWorldSenderProfile(messages[0]);
    const cardLabels = texts(scene.core.popup.container).map((n: PIXI.Text) => n.text);
    expect(cardLabels).toContain(t('friends.report'));
    expect(cardLabels).toContain(t('friends.block'));

    tap(scene.core.popup.container, t('friends.block'));
    tap(stage, t('moderation.blockConfirm'));
    expect(bodies()).not.toContain('nasty words');
    expect(bodies()).toContain('hello all');
    scene.destroy();
    await tick();
  });

  it('DM thread: the header offers Report / Block, and a blocked peer\'s side of the thread is hidden', async () => {
    setModerationBackend(backend());
    host();
    const scene = new ChatScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, peerName: 'Troll', peerPublicId: TROLL, myPublicId: ME,
      resolveConvId: async () => 'c1',
      loadMessages: async () => [
        { messageId: 'd2', convId: 'c1', fromPublicId: ME, body: 'mine stays', kind: 'text', ts: 2 },
        { messageId: 'd1', convId: 'c1', fromPublicId: TROLL, body: 'their insult', kind: 'text', ts: 1 },
      ],
      send: async () => ({ messageId: 'x', ts: 3 }), markRead: async () => {},
      openTextInput: createFakeTextInput().openTextInput,
    });
    await flush();
    const all = (): string => texts(scene.container).map((n) => n.text).join('|');
    expect(all()).toContain(t('moderation.safetyMenu'));
    expect(all()).toContain('their insult');
    markBlocked(TROLL, 'Troll');
    expect(all()).not.toContain('their insult');
    expect(all()).toContain('mine stays');
    expect(all()).toContain(t('moderation.dmBlockedNotice'));
    scene.destroy();
  });
});

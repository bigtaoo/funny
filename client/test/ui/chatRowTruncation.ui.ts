// Width-based truncation for chat rows — ui/widgets/truncateText.ts + drawChatLine's use of it.
//
// The bug this pins (2026-08-26): drawChatLine cut a message body at 60 *characters* and drew it
// unwrapped. A character count is not what clips glyphs — the containing column is — and the two
// disagree by more than 2x between scripts, so the cap was simultaneously far too generous for the
// Sect/Family split-view columns (a Latin line lost its tail well before 60, with no ellipsis to
// admit it) and irrelevant for the full-width world row. It first surfaced as an ADR-074 capture
// announcement whose German copy was cut mid-word while every length assertion stayed green.
//
// The last two describes cover the other half of that story — an announcement travelling from a
// server-chosen i18n key to drawn prose inside a real scene. How WIDE it ends up is checked
// elsewhere, and deliberately so; see the comment above them.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, type Locale } from '../../src/i18n';
import { fitToWidth, truncateToWidth } from '../../src/ui/widgets/truncateText';
import { drawChatLine } from '../../src/ui/widgets/chatRow';
import { txt } from '../../src/render/sketchUi';
import { FS } from '../../src/render/fontScale';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { SectScene } from '../../src/scenes/SectScene';
import { ORG_NAME_WIDTH_MAX } from '@nw/shared';
import type { WorldChatMessage, SectMessageView } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Rendered width of `s`, via a real PIXI.Text — the thing fitToWidth's estimate has to match. */
function renderedWidth(s: string, size: number): number {
  const node = txt(s, size, 0);
  const w = node.width;
  node.destroy();
  return w;
}

function collectTexts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children) {
      if (child instanceof PIXI.Text) out.push(child);
      if (child instanceof PIXI.Container) walk(child as PIXI.Container);
    }
  };
  walk(root);
  return out;
}

describe('fitToWidth', () => {
  it('returns the label untouched when it already fits', () => {
    expect(fitToWidth('short', FS.label, 10_000)).toBe('short');
  });

  it('appends an ellipsis when it does not fit — the old cap dropped the tail silently', () => {
    const long = 'the quick brown fox jumps over the lazy dog and keeps going';
    const out = fitToWidth(long, FS.label, 200);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(long.length);
    expect(long.startsWith(out.slice(0, -1))).toBe(true); // a prefix, not a reflow
  });

  it('the result really fits — measured on a real PIXI.Text, not on TextMetrics alone', () => {
    // fitToWidth measures via PIXI.TextMetrics to avoid building a Text per candidate. That is only
    // sound because makeText()'s CJK anti-clip padding is excluded from reported width
    // (render/pixiText.ts); if that ever stops holding, this is the assertion that catches it.
    for (const maxW of [60, 120, 300, 640]) {
      const out = fitToWidth('the quick brown fox jumps over the lazy dog', FS.label, maxW);
      expect(renderedWidth(out, FS.label), `maxW=${maxW}`).toBeLessThanOrEqual(maxW);
    }
  });

  // NOT tested here, deliberately: that the same width fits fewer CJK than Latin characters — the
  // single fact that makes a character cap unfixable. The headless adapter's measureText returns a
  // flat 7px per UTF-16 unit regardless of font or script (test/harness/pixiHeadless.ts), so every
  // script measures identically under this suite and such an assertion would pass or fail for
  // reasons unrelated to the code. It is real-browser territory — see the screenshots on the commit.

  it('never cuts a surrogate pair in half', () => {
    // An emoji in a player-chosen name is two UTF-16 units; slicing between them leaves a lone
    // surrogate that renders as tofu. Sweep every width so the cut lands mid-pair at some point.
    // (The harness charges per UTF-16 unit, so a pair costs 14px and mid-pair widths do occur.)
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const label = '🐉🐉🐉🐉🐉🐉🐉🐉';
    for (let maxW = 8; maxW < 300; maxW += 1) {
      const out = fitToWidth(label, FS.label, maxW);
      expect(LONE_SURROGATE.test(out), `lone surrogate at maxW=${maxW}: ${JSON.stringify(out)}`).toBe(false);
    }
  });

  it('truncateToWidth hands back a placed-ready Text carrying the fitted string', () => {
    const node = truncateToWidth('a'.repeat(200), FS.label, 0x000000, 240);
    expect(node.text.endsWith('…')).toBe(true);
    expect(node.width).toBeLessThanOrEqual(240);
    node.destroy();
  });
});

describe('drawChatLine — both halves fit the row it was given', () => {
  const SENDER = { senderName: 'tao' };
  const ROW_W = 500;

  /** Draws one row into a bare container and returns its two Texts (name tag, body). */
  function draw(sender: Parameters<typeof drawChatLine>[3], body: string, maxW = ROW_W): {
    layer: PIXI.Container; name: PIXI.Text; body: PIXI.Text;
  } {
    const layer = new PIXI.Container();
    drawChatLine(layer, 0, 20, sender, body, FS.label, FS.label, maxW);
    const texts = collectTexts(layer);
    return { layer, name: texts[0]!, body: texts[1]! };
  }

  it('leaves a body that fits alone', () => {
    const { layer, body } = draw(SENDER, 'hi there');
    expect(body.text).toBe(': hi there');
    layer.destroy({ children: true });
  });

  it('truncates a long body with an ellipsis instead of letting the column clip it', () => {
    const { layer, body } = draw(SENDER, 'we are marching on the world center right now, bring everything you have');
    expect(body.text.endsWith('…')).toBe(true);
    layer.destroy({ children: true });
  });

  it('keeps the whole row inside maxW — the property the character cap never had', () => {
    const long = 'we are marching on the world center right now, bring everything you have';
    for (const maxW of [200, 350, 500, 900]) {
      const { layer, body } = draw(SENDER, long, maxW);
      expect(body.x + body.width, `maxW=${maxW}`).toBeLessThanOrEqual(maxW);
      layer.destroy({ children: true });
    }
  });

  it('a body just under 60 chars but too wide for the column is still truncated', () => {
    // Exactly the shape that used to slip through: under the old 60-char cap, so it was drawn in
    // full and then clipped by the column with no ellipsis.
    const body = 'a'.repeat(59);
    expect(body.length).toBeLessThan(60);
    const { layer, body: bodyTxt } = draw(SENDER, body, 300);
    expect(bodyTxt.text.endsWith('…')).toBe(true);
    layer.destroy({ children: true });
  });

  it('a huge name tag is capped so the body cannot be squeezed out of existence', () => {
    const wide = {
      senderName: 'a-very-long-player-name-indeed',
      title: 'Grandmaster',
      sectName: 'W'.repeat(ORG_NAME_WIDTH_MAX),
      familyName: 'W'.repeat(ORG_NAME_WIDTH_MAX),
    };
    const { layer, name, body } = draw(wide, 'did we win?');
    expect(name.text.endsWith('…')).toBe(true);
    expect(name.width).toBeLessThanOrEqual(ROW_W * 0.5);
    expect(body.text.length).toBeGreaterThan(3);      // more than just ": …"
    expect(body.x + body.width).toBeLessThanOrEqual(ROW_W);
    layer.destroy({ children: true });
  });
});

// ── ADR-074 capture announcements survive the trip through a real chat scene ───────────────────
//
// What these two describes cover is the WIRING: an announcement arrives as a server-chosen i18n key
// with piped params, and by the time drawChatLine has drawn it, it has to be prose — not the raw
// key (which is how it first shipped) and not a sentence with `{level}` still in it (which is how it
// shipped second, from positional params). Nothing else exercises that path end to end inside a
// real scene.
//
// They deliberately do NOT assert that the copy FITS its column. It would look like they do, and it
// would be worthless: this harness's measureText is a flat 7px per UTF-16 unit, script- and
// font-blind, so a CJK line measures at half its real width here and a Latin one at half its real
// width too — every verdict would be uniformly ~2x optimistic. That budget lives in
// test/i18n-system-text.test.ts instead, in display units, against numbers measured in a real
// browser; see the comment there.
const WIDEST_SECT = 'W'.repeat(ORG_NAME_WIDTH_MAX);
const CITY_REF = `kind=garrison|node=n7|level=9|x=128|y=128|sect=${WIDEST_SECT}`;
const LOCALES: Locale[] = ['zh', 'en', 'de'];

describe('ADR-074 sect-channel announcements reach the row as prose', () => {
  function renderSectChannel(body: string): PIXI.Text[] {
    const messages: SectMessageView[] = [{
      id: 'm1', senderId: 'system', senderName: 'system', body, ts: 1,
    }];
    // Landscape: the split view's right-hand column is the narrow case these two keys must fit.
    const scene: any = new SectScene(createLayout(1920, 1080), new InputManager(), {
      onBack() {}, onNavTab() {},
      worldApi: { getMyFamily: () => new Promise<never>(() => {}) } as any,
      worldId: 'w1', myAccountId: 'me', playerName: 'tao',
      getCoins: () => 0, refreshWallet: async () => {},
    } as any);
    scene.core.mode = 'mySect';
    scene.core.activeTab = 'channel';
    scene.core.sect = {
      sectId: 's1', worldId: 'w1', name: 'Sky Sect', tag: 'SKY', leaderId: 'me',
      leaderFamilyId: 'fam1', memberFamilyCount: 1, prosperity: 0, memberFamilies: [], allySectIds: [],
    };
    scene.core.messages = messages;
    scene.render();
    const texts = collectTexts(scene.core.bodyLayer);
    scene.destroy();
    return texts;
  }

  for (const key of ['slg.city.captured', 'slg.city.lost'] as const) {
    it.each(LOCALES)(`${key} resolves to prose in %s`, (locale) => {
      setLocale(locale);
      const row = renderSectChannel(`${key}|${CITY_REF}`);
      const body = row.find((n) => n.text.startsWith(': '));
      expect(body, `no ${key} row rendered in ${locale}`).toBeDefined();
      expect(body!.text, 'shipped as the raw key').not.toContain(key);
      expect(body!.text, 'a placeholder went unbound').not.toContain('{');
      expect(body!.text, 'a pipe segment leaked into the copy').not.toContain('|');
      expect(body!.text).toContain('128');     // the coords survived — the point of the notice
      setLocale('en');
    });
  }
});

describe('ADR-074 world-centre announcement reaches the row as prose', () => {
  async function renderWorldChat(body: string): Promise<PIXI.Text[]> {
    const messages: WorldChatMessage[] = [{
      id: 'm1', senderId: 'system', senderName: 'system', senderPublicId: '', body, ts: 1,
    }];
    const scene: any = new FriendsScene(createLayout(1920, 1080), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      myPublicId: '', getProfileExtra: async () => ({}),
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '999999999', displayName: 'Nobody' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
      reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {},
      claimMail: async () => true, deleteMail: async () => {},
      loadSLGStatus: async () => null,
      loadWorldChat: async () => messages,
      defaultTab: 'world',
      openTextInput: createFakeTextInput().openTextInput,
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    return collectTexts(scene.container);
  }

  it.each(LOCALES)('slg.city.worldCenterCaptured resolves to prose in %s', async (locale) => {
    setLocale(locale);
    const row = await renderWorldChat(`slg.city.worldCenterCaptured|${CITY_REF}`);
    const body = row.find((n) => n.text.startsWith(': '));
    expect(body, `no announcement row rendered in ${locale}`).toBeDefined();
    expect(body!.text, 'shipped as the raw key').not.toContain('slg.city.worldCenterCaptured');
    expect(body!.text, 'a placeholder went unbound').not.toContain('{');
    expect(body!.text, 'a pipe segment leaked into the copy').not.toContain('|');
    expect(body!.text).toContain(WIDEST_SECT);   // who took it survived
    setLocale('en');
  });
});

// Regression coverage (2026-08-12 sweep, prompted by the BattlePassScene mobile-reload bug):
// ChatScene.drawThread() used to build a real bubble (Graphics panel + word-wrapped Text) for
// EVERY message in `this.messages` on every render() — unconditionally, regardless of scroll
// position. Unlike BattlePassScene's fixed 30 levels, chat history is genuinely unbounded:
// loadEarlier() prepends another PAGE(30) messages with no eviction every time the user pages
// back, and render() re-runs on every scroll-drag frame *and* every ~0.5s caret blink while
// composing — not just once on open. A long-lived conversation would eventually build enough
// GPU textures in one frame to spike mobile WebView memory the same way BattlePassScene did.
//
// Fix: ChatScene/thread.ts's measureRows() computes every row's geometry via PIXI.TextMetrics
// (no texture created) so the total content height is known cheaply, then drawThread() only
// calls buildBubble() (real Text+Graphics) for rows within one viewport of the visible band.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { ChatScene, type ChatSceneCallbacks } from '../../src/scenes/ChatScene';
import type { ChatMessageView } from '../../src/net/ApiClient';
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

const [W, H] = [800, 1280];
const MY_ID = '987654321';
const PEER_ID = '123456789';

function countTexts(container: PIXI.Container): number {
  let n = 0;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) n++;
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return n;
}

function hasText(container: PIXI.Container, text: string): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === text) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

/** Ascending-ts messages (m0 oldest .. m{n-1} newest); loadMessages returns them newest-first
 *  (per ChatScene.load()'s doc comment: "server returns newest-first"). */
function makeMessages(n: number): ChatMessageView[] {
  return Array.from({ length: n }, (_, i) => ({
    messageId: `m${i}`,
    convId: 'c1',
    fromPublicId: i % 2 === 0 ? MY_ID : PEER_ID,
    body: `message number ${i}`,
    kind: 'text' as const,
    ts: 1_000 + i,
  })).reverse();
}

function buildChat(cb: Partial<ChatSceneCallbacks>): ChatScene {
  const { openTextInput } = createFakeTextInput();
  return new ChatScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    peerName: 'Bob',
    peerPublicId: PEER_ID,
    myPublicId: MY_ID,
    resolveConvId: async () => 'c1',
    loadMessages: async () => [],
    send: async () => ({ messageId: 'srv-1', ts: Date.now() }),
    markRead: async () => {},
    openTextInput,
    ...cb,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ChatScene — message-thread virtualization (mobile OOM fix)', () => {
  it('does not build a Text/bubble for every one of 200 messages up front', async () => {
    const scene = buildChat({ loadMessages: async () => makeMessages(200) });
    await flush();

    const s = scene as unknown as { maxScroll: number };
    // 200 messages is comfortably scrollable.
    expect(s.maxScroll).toBeGreaterThan(0);

    // Each unvirtualized bubble carries at least 1 Text (body); 200 messages would be ~200+
    // Text nodes. Bounding it far below that proves virtualization is active.
    const textCount = countTexts(scene.container);
    expect(textCount).toBeGreaterThan(0);
    expect(textCount).toBeLessThan(60);
    scene.destroy();
  });

  it('shows the newest message initially (stickBottom) and the oldest after scrolling to top', async () => {
    const input = new InputManager();
    const scene = new ChatScene(createLayout(W, H), input, {
      onBack() {},
      peerName: 'Bob',
      peerPublicId: PEER_ID,
      myPublicId: MY_ID,
      resolveConvId: async () => 'c1',
      loadMessages: async () => makeMessages(200),
      send: async () => ({ messageId: 'srv-1', ts: Date.now() }),
      markRead: async () => {},
      openTextInput: createFakeTextInput().openTextInput,
    });
    await flush();

    // Initial view pins to the bottom (latest) — the newest message is visible...
    expect(hasText(scene.container, 'message number 199')).toBe(true);
    // ...but the oldest, 200 rows of scroll away, is not (proves it isn't just building everything).
    expect(hasText(scene.container, 'message number 0')).toBe(false);

    const s = scene as unknown as { update(dt: number): void };
    // Drag far enough, and repeatedly (each render() re-measures/re-clamps scrollY), to reach the
    // very top of the thread.
    for (let i = 0; i < 5; i++) {
      input._emitDown(400, 100);
      input._emitMove(400, 100 + 100_000);
      s.update(0.016);
      input._emitUp(400, 100 + 100_000);
    }

    expect(hasText(scene.container, 'message number 0')).toBe(true);
    scene.destroy();
  });

  it('caches nothing across renders that would make text count grow with history length', async () => {
    // A much longer history (simulating many "load earlier" taps with no eviction) must still
    // keep the built Text count bounded by the viewport, not by total message count.
    const scene = buildChat({ loadMessages: async () => makeMessages(600) });
    await flush();

    const textCount = countTexts(scene.container);
    expect(textCount).toBeGreaterThan(0);
    expect(textCount).toBeLessThan(60);
    scene.destroy();
  });

  it('the composer caret blink (periodic render()) does not rebuild the full history either', async () => {
    const scene = buildChat({ loadMessages: async () => makeMessages(200) });
    await flush();

    const s = scene as unknown as { composeFocused: boolean; update(dt: number): void };
    s.composeFocused = true;
    s.update(0.6); // >= the 0.5s caret-blink threshold — triggers a render()

    const textCount = countTexts(scene.container);
    expect(textCount).toBeGreaterThan(0);
    expect(textCount).toBeLessThan(60);
    scene.destroy();
  });
});

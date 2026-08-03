// Regression coverage for a failed chat send leaving a phantom "delivered" bubble (2026-08-03 fix).
//
// Before: doSend() optimistically appended the message bubble and rendered it BEFORE awaiting
// cb.send(body); on failure the catch block only showed a toast (easily missed/dismissed) and never
// removed or marked the bubble — so if a friend blocked the sender mid-conversation, or a rate limit
// tripped, the sender's bubble stayed in the thread looking identical to a delivered message, with no
// visible indication it never reached the peer.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { ChatScene, type ChatSceneCallbacks } from '../../src/scenes/ChatScene';

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

/** The body Text node matching `bodyText` — its own `.alpha` is what buildBubble dims on failure
 *  (set directly on `body`/`bg`, not on the outer bubble container). */
function findBodyText(container: PIXI.Container, bodyText: string): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === bodyText) { found = node; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function buildChat(cb: Partial<ChatSceneCallbacks>): ChatScene {
  return new ChatScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    peerName: 'Bob',
    peerPublicId: '123456789',
    myPublicId: '987654321',
    resolveConvId: async () => null,
    loadMessages: async () => [],
    send: async () => ({ messageId: 'srv-1', ts: Date.now() }),
    markRead: async () => {},
    ...cb,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ChatScene — a failed send marks the bubble "not delivered" instead of leaving it looking sent', () => {
  it('the bubble stays in the thread but dims + captions "Not delivered" on a send failure', async () => {
    const scene = buildChat({ send: async () => { throw new Error('BLOCKED'); } });
    await flush(); // let the constructor's load() settle

    const s = scene as unknown as { draft: string; doSend(): Promise<void> };
    s.draft = 'hello there';
    const sendPromise = s.doSend();
    await flush();
    await sendPromise;
    await flush();

    // The optimistic bubble is NOT removed — it stays visible with its original text.
    expect(hasText(scene.container, 'hello there')).toBe(true);
    // ...but is now visibly marked as failed.
    expect(hasText(scene.container, t('chat.sendFailed'))).toBe(true);
    const bodyText = findBodyText(scene.container, 'hello there');
    expect(bodyText).not.toBeNull();
    expect(bodyText!.alpha).toBeLessThan(1); // dimmed, not indistinguishable from a delivered message
    scene.destroy();
  });

  it('a successful send does NOT show the "not delivered" caption', async () => {
    const scene = buildChat({});
    await flush();

    const s = scene as unknown as { draft: string; doSend(): Promise<void> };
    s.draft = 'all good';
    await s.doSend();
    await flush();

    expect(hasText(scene.container, 'all good')).toBe(true);
    expect(hasText(scene.container, t('chat.sendFailed'))).toBe(false);
    const bodyText = findBodyText(scene.container, 'all good');
    expect(bodyText!.alpha).toBe(1); // full opacity — not mistakenly dimmed
    scene.destroy();
  });
});

// Regression guard for the GPU texture leak fixed in 29b0daea (iPad Safari
// "注册输昵称一直崩溃"). High-frequency render() scenes (LoginScene caret + every
// keystroke, chat compose, shop recharge, settings rename, world-map countdowns)
// rebuild their PIXI tree on each render. A bare `container.removeChildren()` only
// DETACHES children — each PIXI.Text owns a GPU texture that then leaks for PIXI's
// ~60s texture-GC window, exhausting the tiny WebGL budget on iPad → context loss
// → page reload. The fix routes those clears through `tearDownChildren`, which
// destroys each child.
//
// The contract is subtle and leans on a PIXI internal worth pinning down:
//   • PIXI.Text.destroy() merges with its OWN defaultDestroyOptions
//     (texture:true, baseTexture:true), so a Text frees its texture even when
//     destroyed via destroy({children:true}) — including when it is NESTED inside
//     a sub-container that gets destroy({children:true}) recursively (chat bubbles
//     live at container → layer → node → body).
//   • PIXI.Sprite.destroy({children:true}) leaves options.texture falsy, so a
//     Sprite wrapping a SHARED bake() RenderTexture keeps its texture — the baked
//     paper background must survive the re-render.
// A PIXI upgrade that changed either default would silently reintroduce the leak
// (or, worse, start nuking shared bake textures); these tests catch both directions.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts) — real display objects, no renderer/WebGL. Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { tearDownChildren } from '../../src/render/sketchUi';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { ChatScene } from '../../src/scenes/ChatScene';
import type { ChatMessagePush } from '../../src/net/proto/transport';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** A Sprite standing in for the baked paper background: wraps a texture whose
 * baseTexture is shared and must NOT be freed on re-render. */
function sharedTextureSprite(): { sprite: PIXI.Sprite; base: PIXI.BaseTexture } {
  const base = new PIXI.BaseTexture();
  const sprite = new PIXI.Sprite(new PIXI.Texture(base));
  return { sprite, base };
}

/** Every live PIXI.Text baseTexture reachable from `root` (recursing sub-containers). */
function liveTextBaseTextures(root: PIXI.Container): Set<PIXI.BaseTexture> {
  const out = new Set<PIXI.BaseTexture>();
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.add(ch.texture.baseTexture);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

describe('tearDownChildren — frees text textures, spares shared bake textures', () => {
  it('frees a top-level PIXI.Text texture + baseTexture and empties the container', () => {
    const root = new PIXI.Container();
    const label = new PIXI.Text('hello', { fontSize: 16 });
    const base = label.texture.baseTexture;
    root.addChild(label);

    tearDownChildren(root);

    expect(root.children.length).toBe(0);
    expect(base.destroyed).toBe(true);
  });

  it('does NOT free a non-Text Sprite backed by a shared bake texture', () => {
    const root = new PIXI.Container();
    const { sprite, base } = sharedTextureSprite();
    root.addChild(sprite);

    tearDownChildren(root);

    expect(root.children.length).toBe(0);
    expect(base.destroyed).toBe(false); // shared baked paper survives
  });

  it('frees NESTED text textures while sparing a nested shared bake sprite', () => {
    // Mirrors a chat bubble: container → layer → node → { bubbleBg(shared), body(Text) }.
    const root = new PIXI.Container();
    const layer = new PIXI.Container();
    const node = new PIXI.Container();
    const body = new PIXI.Text('msg', { fontSize: 14 });
    const { sprite: bubbleBg, base: sharedBase } = sharedTextureSprite();
    const bodyBase = body.texture.baseTexture;
    node.addChild(bubbleBg, body);
    layer.addChild(node);
    root.addChild(layer);

    tearDownChildren(root);

    expect(root.children.length).toBe(0);
    expect(bodyBase.destroyed).toBe(true);   // nested Text texture freed via recursion + Text defaults
    expect(sharedBase.destroyed).toBe(false); // nested shared bake texture preserved
  });

  it('regression direction: a bare removeChildren() leaks the text texture (proves the bug)', () => {
    const root = new PIXI.Container();
    const label = new PIXI.Text('leak', { fontSize: 16 });
    const base = label.texture.baseTexture;
    root.addChild(label);

    root.removeChildren(); // the OLD, buggy clear

    expect(base.destroyed).toBe(false); // orphaned texture — exactly what tearDownChildren fixes
  });
});

describe('ChatScene — repeated re-render frees the previous generation of text textures', () => {
  it('destroys each prior render generation instead of orphaning it', () => {
    const scene = new ChatScene(createLayout(800, 1280), new InputManager(), {
      onBack() {},
      peerName: 'Bob',
      peerPublicId: '123456789',
      myPublicId: '987654321',
      resolveConvId: async () => null,
      loadMessages: async () => [],
      send: async () => ({ messageId: 'm1', ts: 0 }),
      markRead: async () => {},
    });

    // Each applyIncoming appends a message and re-renders (render() → tearDownChildren).
    // Snapshot the live text textures BEFORE a re-render, then assert that generation
    // is fully destroyed AFTER it — i.e. nothing leaks across renders.
    for (let i = 0; i < 5; i++) {
      const prevGen = liveTextBaseTextures(scene.container);
      const push: ChatMessagePush = {
        convId: 'c1',
        fromPublicId: '123456789',
        fromName: 'Bob',
        body: `message ${i}`,
        ts: i + 1,
      };
      scene.applyIncoming(push);
      for (const base of prevGen) expect(base.destroyed).toBe(true);
    }

    scene.destroy();
  });
});

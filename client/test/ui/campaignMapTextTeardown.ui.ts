// Regression coverage for CampaignMapScene's Text-texture teardown on page flip
// (claudedocs/client-memory-leak.md §8.6, 2026-08-03).
//
// Note on what this actually proves: CampaignMapScene's showPage()/advanceFlip()/destroy() were
// changed to call tearDownChildren() before destroy({children:true}). Empirically verifying this
// PIXI version's behavior (see the inline check below) shows PIXI.Text.destroy() always merges in
// its OWN defaultDestroyOptions ({texture:true, baseTexture:true}) regardless of what a *cascading*
// destroy({children:true}) call passed down to it — so a bare `root.destroy({children:true})`
// (the pre-fix code, which already used {children:true} throughout, just without tearDownChildren)
// already freed nested Text textures correctly in this PIXI version. tearDownChildren's real value
// here is defensive/convention consistency (see client-memory-leak.md §5/§8.4), not a change in
// measurable outcome for this specific scene.
//
// What genuinely does leak textures — and what these tests actually guard against — is dropping
// `{children:true}` entirely (e.g. a future edit that "simplifies" `f.out.destroy({children:true})`
// down to a bare `f.out.destroy()`, or swaps in a plain `removeChildren()`). These tests check the
// real outcome (each Text's baseTexture.destroyed flag) rather than call-shape, so they catch that
// class of regression regardless of whether tearDownChildren specifically is involved.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CampaignMapScene } from '../../src/scenes/CampaignMapScene';

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
const FLIP_DUR = 0.42;

function buildScene(): CampaignMapScene {
  return new CampaignMapScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    onSelectLevel() {},
    onOpenEquipment() {},
    getStars: () => ({}),
    getCleared: () => [],
    isOnline: () => true,
    getPendingLevels: () => [],
  });
}

/** Every PIXI.Text baseTexture reachable from `root` (recursing sub-containers) — captured by
 * reference BEFORE the teardown under test, so `.destroyed` reflects the real outcome afterwards
 * (a Text's OWN `.texture` reference goes away on destroy, so it must be captured up front). */
function collectBaseTextures(root: PIXI.Container): PIXI.BaseTexture[] {
  const out: PIXI.BaseTexture[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.texture.baseTexture);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

describe('CampaignMapScene — Text-texture teardown on page flip', () => {
  it('flipping from the chapter page to the TOC frees the outgoing page\'s Text baseTextures', () => {
    const scene = buildScene();
    // Lands directly on the chapter page (no opening-flip gate, see scenes.ui.ts) — it has plenty
    // of Text (chapter title, level labels, etc.) to tear down.
    const outgoingRoot = (scene as unknown as { page: { root: PIXI.Container } }).page.root;
    const bases = collectBaseTextures(outgoingRoot);
    expect(bases.length).toBeGreaterThan(0);

    (scene as unknown as { backToToc(): void }).backToToc();
    scene.update(FLIP_DUR + 0.01); // settle the flip — advanceFlip's f.t>=1 branch tears down the outgoing page

    expect(bases.every((b) => b.destroyed)).toBe(true);
    scene.destroy();
  });

  it('flipping from the TOC into a chapter frees the outgoing TOC page\'s Text the same way', () => {
    const scene = buildScene();
    (scene as unknown as { backToToc(): void }).backToToc();
    scene.update(FLIP_DUR + 0.01); // now showing the TOC

    const outgoingRoot = (scene as unknown as { page: { root: PIXI.Container } }).page.root;
    const bases = collectBaseTextures(outgoingRoot);
    expect(bases.length).toBeGreaterThan(0);

    (scene as unknown as { openChapter(ch: number): void }).openChapter(1);
    scene.update(FLIP_DUR + 0.01);

    expect(bases.every((b) => b.destroyed)).toBe(true);
    scene.destroy();
  });

  it('destroy() frees the currently-shown page\'s Text baseTextures too', () => {
    const scene = buildScene();
    const currentRoot = (scene as unknown as { page: { root: PIXI.Container } }).page.root;
    const bases = collectBaseTextures(currentRoot);
    expect(bases.length).toBeGreaterThan(0);

    scene.destroy();

    expect(bases.every((b) => b.destroyed)).toBe(true);
    expect(scene.container.destroyed).toBe(true);
  });

  it('showPage() replacing an already-shown page frees the old one\'s Text the same way (defensive path — not on any live navigation route today, since all real navigation goes through flipTo, but must stay correct if one is ever added)', () => {
    const scene = buildScene();
    const s = scene as unknown as { showPage(p: unknown): void; buildToc(): unknown; page: { root: PIXI.Container } };
    const firstRoot = s.page.root;
    const bases = collectBaseTextures(firstRoot);
    expect(bases.length).toBeGreaterThan(0);

    s.showPage(s.buildToc());

    expect(s.page.root).not.toBe(firstRoot);
    expect(bases.every((b) => b.destroyed)).toBe(true);
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-03 DefenseEditorScene onSaveChanged gap (see
// claudedocs/client-modules.md's 2026-08-03 data-sharing entry). DefenseEditorScene's attack-mode
// roster panel reads cb.getSave?.().cardInv/equipmentInv, but — unlike every other scene that
// displays wallet/save data (client-modules.md §34's contract) — it never wired
// SaveManager.subscribe. A save mutation while the editor sat open (mail auto-claim, sync
// reconcile) left the roster showing stale cards until the player's next unrelated interaction
// happened to trigger a re-render.
//
// Mirrors saveManagerAutoRerender.ui.ts's pattern (a real scene + a real SaveManager, mutate the
// manager directly, assert the rendered tree updates without the test calling render() itself) —
// but for the actual scene that had the bug, which that file's Gacha+BattlePass pair doesn't cover.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { DefenseEditorScene, type DefenseEditorCallbacks } from '../../src/scenes/DefenseEditorScene';
import { SaveManager } from '../../src/game/meta/SaveManager';
import { LocalSaveStore } from '../../src/game/meta/SaveStore';
import type { IStorage } from '../../src/platform/IPlatform';
import type { WorldApiClient, TeamTemplate } from '../../src/net/WorldApiClient';

class MemStorage implements IStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

initI18n('en', new MemStorage(), ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';

/** All PIXI.Text content currently in the display tree (same helper as saveManagerAutoRerender.ui.ts). */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

/** Wires DefenseEditorScene exactly like nav/world.ts's openCity().onEditTeam call site. */
function buildHarness(mgr: SaveManager) {
  const getTeams = vi.fn().mockResolvedValue([{ id: 't1', name: 'Team 1', army: [] } as TeamTemplate]);
  const getMe = vi.fn().mockResolvedValue({ cardState: {} });
  const worldApi = { getTeams, getMe } as unknown as WorldApiClient;

  const cb: DefenseEditorCallbacks = {
    onBack: vi.fn(),
    getSave: () => mgr.get(),
    onSaveChanged: (fn) => mgr.subscribe(fn),
    worldApi,
    worldId: WORLD_ID,
    target: { mode: 'attack', teamId: 't1', teamName: 'Team 1' },
  };
  const scene = new DefenseEditorScene(createLayout(800, 1280), new InputManager(), cb);
  return { scene };
}

describe('DefenseEditorScene onSaveChanged wiring (2026-08-03 fix)', () => {
  it('a card added to the shared save while the editor is open appears in the roster without the test calling render()', async () => {
    const mgr = new SaveManager({ store: new LocalSaveStore(new MemStorage()) });
    const { scene } = buildHarness(mgr);
    await flush();

    // No cards yet — the roster shows the empty-state placeholder.
    expect(collectTexts(scene.container)).toContain(t('world.team.noCards'));
    expect(collectTexts(scene.container).some((s) => s.includes(t('card.lichuang.name')))).toBe(false);

    // Simulate a background save write (e.g. mail auto-claim, sync reconcile) while the editor
    // sits open — nothing here calls scene.render() itself.
    mgr.update((s) => {
      s.cardInv!['c0'] = { id: 'c0', defId: 'lichuang', level: 1, gear: {}, locked: false };
    });

    // Roster cell text is "<name> Lv.<n>", not the bare name — substring match.
    expect(collectTexts(scene.container).some((s) => s.includes(t('card.lichuang.name')))).toBe(true);
    expect(collectTexts(scene.container)).not.toContain(t('world.team.noCards'));

    scene.destroy();
  });

  it('destroy() unsubscribes — a later save mutation does not throw', async () => {
    const mgr = new SaveManager({ store: new LocalSaveStore(new MemStorage()) });
    const { scene } = buildHarness(mgr);
    await flush();

    scene.destroy();
    expect(() => {
      mgr.update((s) => {
        s.cardInv!['c0'] = { id: 'c0', defId: 'lichuang', level: 1, gear: {}, locked: false };
      });
    }).not.toThrow();
  });
});

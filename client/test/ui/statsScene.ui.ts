// StatsScene match-history section — asserts the four fetch states each render the
// expected rows. Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles)
// so the scene can build its PIXI tree and measure text in plain Node.
//
// Strategy: walk the scene container for PIXI.Text nodes and match their strings
// against the i18n values (locale pinned to 'en' below). loadHistory is async and the
// scene re-renders on resolve, so populated/empty assertions await a microtask flush.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { StatsScene, type StatsCallbacks } from '../../src/scenes/StatsScene';
import type { MatchHistoryEntry } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const STATS: StatsCallbacks['getStats'] = () => ({
  pvp: { rank: 'bronze', elo: 1000, wins: 12, losses: 5, streak: 3 },
  cleared: 2,
  totalLevels: 4,
  stars: 5,
  skinsOwned: 1,
  materials: { scrap: 30, lead: 10, binding: 4 },
});

/** Collect every PIXI.Text string in the scene tree. */
function texts(container: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) out.push(node.text);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

function build(cb: Partial<StatsCallbacks>): StatsScene {
  return new StatsScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getStats: STATS,
    ...cb,
  });
}

/** Let the fetchHistory microtask + re-render settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('StatsScene match history', () => {
  it('no loadHistory (offline) → shows "log in to view"', () => {
    const scene = build({});
    expect(texts(scene.container)).toContain(t('stats.historyOffline'));
    scene.destroy();
  });

  it('loadHistory pending → shows loading', () => {
    // A promise that never resolves: history stays null → loading row.
    const scene = build({ loadHistory: () => new Promise<MatchHistoryEntry[]>(() => {}) });
    const ts = texts(scene.container);
    expect(ts).toContain(t('stats.historyLoading'));
    expect(ts).not.toContain(t('stats.historyOffline'));
    scene.destroy();
  });

  it('loadHistory resolves empty → shows "no matches yet"', async () => {
    const scene = build({ loadHistory: async () => [] });
    await flush();
    expect(texts(scene.container)).toContain(t('stats.historyEmpty'));
    scene.destroy();
  });

  it('loadHistory rejects → degrades to "no matches yet" (not stuck loading)', async () => {
    const scene = build({ loadHistory: async () => { throw new Error('boom'); } });
    await flush();
    const ts = texts(scene.container);
    expect(ts).toContain(t('stats.historyEmpty'));
    expect(ts).not.toContain(t('stats.historyLoading'));
    scene.destroy();
  });

  it('populated → renders opponent + win/loss + signed ELO delta', async () => {
    const history: MatchHistoryEntry[] = [
      { roomId: 'r1', mode: 'ranked', result: 'win', opponentName: 'Alice', eloDelta: 16, ts: 2 },
      { roomId: 'r2', mode: 'ranked', result: 'loss', opponentPublicId: '987654321', eloDelta: -16, ts: 1 },
      { roomId: 'r3', mode: 'friendly', result: 'unknown', ts: 0 },
    ];
    const scene = build({ loadHistory: async () => history });
    await flush();
    const ts = texts(scene.container);
    // Row 1: named opponent shown in a "me vs opponent" matchup line + win + (+16)
    expect(ts.some((s) => s.includes('Alice'))).toBe(true);
    expect(ts.some((s) => s.includes(t('stats.win')) && s.includes('+16'))).toBe(true);
    // Row 2: publicId fallback label (matchup line) + loss + (-16)
    expect(ts.some((s) => s.includes('#987654321'))).toBe(true);
    expect(ts.some((s) => s.includes(t('stats.loss')) && s.includes('-16'))).toBe(true);
    // Row 3: unknown opponent fallback label (matchup line), no ELO suffix
    expect(ts.some((s) => s.includes(t('stats.historyUnknownOpp')))).toBe(true);
    scene.destroy();
  });

  it('caps to the 10 most recent matches', async () => {
    const many: MatchHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
      roomId: `r${i}`,
      mode: 'ranked',
      result: 'win' as const,
      opponentName: `Opp${i}`,
      eloDelta: 1,
      ts: i,
    }));
    const scene = build({ loadHistory: async () => many });
    await flush();
    const ts = texts(scene.container);
    const shown = many.filter((m) => ts.some((s) => s.includes(m.opponentName!)));
    expect(shown).toHaveLength(10);
    scene.destroy();
  });
});

// ELO-loss protection line on the ranked result screen (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07):
// a protected ranked game (new-player slot: an account's first 3 settled ranked games; daily slot: the
// first 3 of each server-UTC day) costs no ELO on a loss, and match_over.elo carries
// protectedGame/protectedTotal/protectedKind so ResultScene can say which under the ELO line. Verifies
// the line is drawn (loss and win, both kinds), sits under the ELO line without overlapping any other
// text, stays on screen at every locale in portrait and landscape, and is absent for an unprotected game.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ResultScene, type EloResult } from '../../src/scenes/ResultScene';
import { initI18n, setLocale, t, type Locale } from '../../src/i18n';
import type { PlayerStats } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const VIEWPORTS: Array<[string, number, number]> = [
  ['portrait', 1080, 1920],
  ['landscape', 1920, 1080],
];

function zeroStats(owner: 0 | 1): PlayerStats {
  return {
    owner, damageDealtToBase: 0, damageTakenByBase: 0, unitsSent: 0, unitsKilled: 0,
    spellHits: 0, killsByType: {}, castsByType: {}, buildingSurvivalTicks: 0, goldSpent: 0,
  };
}

function buildScene(w: number, h: number, winner: 0 | 1, elo: EloResult): ResultScene {
  return new ResultScene(w, h, winner, [zeroStats(0), zeroStats(1)], { onPlayAgain() {}, onBack() {} }, 0, elo);
}

function texts(root: PIXI.Container): Array<{ text: string; b: PIXI.Rectangle }> {
  const out: Array<{ text: string; b: PIXI.Rectangle }> = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) { out.push({ text: ch.text, b: ch.getBounds() }); continue; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

const overlaps = (a: PIXI.Rectangle, b: PIXI.Rectangle): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const KINDS: Array<{ kind: number; key: 'result.newbieProtect' | 'result.dailyProtect' }> = [
  { kind: 1, key: 'result.newbieProtect' },
  { kind: 2, key: 'result.dailyProtect' },
];

describe('ResultScene - ELO-loss protection line', () => {
  it('draws "+0" plus the protection line under it on a protected loss, on screen and overlap-free', () => {
    for (const locale of ['zh', 'en', 'de'] as Locale[]) {
      setLocale(locale);
      try {
        for (const [name, w, h] of VIEWPORTS) for (const { kind, key } of KINDS) {
          const elo: EloResult = { delta: 0, after: 1000, rankAfter: 'bronze', protectedGame: 2, protectedTotal: 3, protectedKind: kind };
          const scene = buildScene(w, h, 1, elo); // winner=1, localOwner=0 -> a loss
          const all = texts(scene.container);
          const expected = t(key, { n: 2, total: 3 });
          const line = all.find((n) => n.text === expected);
          const where = `${locale}/${name}/${key}`;
          expect(line, `${where}: no protection line (have: ${all.map((n) => n.text).join(' | ')})`).toBeDefined();
          expect(expected).toContain('2/3');

          const eloLine = all.find((n) => n.text.includes('+0'));
          expect(eloLine, `${where}: ELO line should read +0`).toBeDefined();
          expect(line!.b.y, `${where}: protection line must sit under the ELO line`).toBeGreaterThanOrEqual(eloLine!.b.y + eloLine!.b.height - 1);

          expect(line!.b.x, `${where}: spills off the left edge`).toBeGreaterThanOrEqual(0);
          expect(line!.b.x + line!.b.width, `${where}: spills off the right edge`).toBeLessThanOrEqual(w);
          expect(line!.b.y + line!.b.height, `${where}: must stay above the primary CTA`).toBeLessThanOrEqual(Math.round(h * 0.78));
          for (const other of all) {
            if (other === line) continue;
            expect(overlaps(line!.b, other.b), `${where}: overlaps "${other.text}"`).toBe(false);
          }
          scene.destroy();
        }
      } finally {
        setLocale('en');
      }
    }
  });

  it('also labels a protected win (wins use up a slot too)', () => {
    const [, w, h] = VIEWPORTS[1]!;
    const scene = buildScene(w, h, 0, { delta: 16, after: 1016, rankAfter: 'bronze', protectedGame: 1, protectedTotal: 3, protectedKind: 2 });
    const all = texts(scene.container).map((n) => n.text);
    expect(all).toContain(t('result.dailyProtect', { n: 1, total: 3 }));
    scene.destroy();
  });

  it('reads a missing kind (older server) as new-player protection', () => {
    const [, w, h] = VIEWPORTS[0]!;
    const scene = buildScene(w, h, 1, { delta: 0, after: 1000, rankAfter: 'bronze', protectedGame: 3, protectedTotal: 3 });
    const all = texts(scene.container).map((n) => n.text);
    expect(all).toContain(t('result.newbieProtect', { n: 3, total: 3 }));
    scene.destroy();
  });

  it('draws no protection line for an unprotected game (proto default 0 or field absent)', () => {
    const [, w, h] = VIEWPORTS[1]!;
    for (const elo of [
      { delta: -16, after: 984, rankAfter: 'bronze' },
      { delta: -16, after: 984, rankAfter: 'bronze', protectedGame: 0, protectedTotal: 0 },
    ] as EloResult[]) {
      const scene = buildScene(w, h, 1, elo);
      const all = texts(scene.container).map((n) => n.text);
      expect(all.some((s) => s.includes('3)') || s.includes('3）'))).toBe(false);
      expect(all.some((s) => s.includes('-16'))).toBe(true);
      scene.destroy();
    }
  });
});

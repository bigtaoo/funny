// Static guard for the 2026-08-27 blank-wardrobe fix (design/game/CHARACTER_CARDS_DESIGN_IMPL.md §10).
//
// Background: CardScene's two content tabs (roster grid / skins wardrobe) share one `core.scrollY`,
// and the roster's offsets are far larger than anything the 6-card wardrobe can hold. Switching tabs
// now goes through `CardSceneCore.setTab()`, which parks the outgoing tab's offset in `scrollByTab`
// and restores the incoming tab's own — so the wardrobe opens at its own top instead of inheriting a
// roster offset that scrolls its whole grid out of view.
//
// The bug existed because there were TWO switch sites with their own semantics (the in-scene rail in
// list.ts and CardScene.showTab, added later for the EquipmentScene overlay's rail). A third one
// written as a plain `core.tab = 'skins'` would silently skip the swap and bring the symptom back,
// and no rendering test would fail — the offset only matters when the tab you came FROM was scrolled.
// So this checks mechanically that `setTab` stays the only way in.
//
// Why STATIC rather than behavioural: test/ui/cardSceneSkins.ui.ts already pins what the two existing
// sites DO ("wardrobe first paint after a scrolled roster"). What can't be asserted at runtime is the
// absence of a future third site — that's this file.
//
// Runs under plain vitest (source-text scan, no PIXI). Run: npm test

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../src');
/** Where the field itself lives: its declaration and setTab's own assignments are the legitimate ones. */
const CORE = 'scenes/CardScene/core.ts';

function cardSceneFiles(): { rel: string; text: string }[] {
  // Recursive on purpose: `logic/` arrived 2026-08-27 (ADR-071 4b) and a non-recursive readdir
  // would have quietly stopped scanning whatever moves in there next.
  const walk = (rel: string): string[] =>
    fs.readdirSync(path.join(SRC_ROOT, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${rel}/${e.name}`) : e.name.endsWith('.ts') ? [`${rel}/${e.name}`] : []);
  const files = walk('scenes/CardScene');
  files.push('scenes/CardScene.ts'); // the assembly shell (showTab lives here)
  return files.map((rel) => ({ rel, text: fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8') }));
}

describe('CardScene tab switches go through setTab (2026-08-27 blank-wardrobe fix)', () => {
  const files = cardSceneFiles();

  it('finds the sources at all (canary: a move or rename must not silently empty this suite)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.some((f) => f.rel === CORE)).toBe(true);
    expect(files.some((f) => f.rel === 'scenes/CardScene.ts')).toBe(true);
  });

  it('setTab is still the swap point, and both known switch sites call it', () => {
    const core = files.find((f) => f.rel === CORE)!.text;
    expect(core).toMatch(/setTab\(tab: CardSceneTab\): boolean/);
    expect(core).toMatch(/scrollByTab/);
    // The rail (list.ts renderSidebar) and the overlay path (CardScene.showTab).
    expect(files.find((f) => f.rel === 'scenes/CardScene/list.ts')!.text).toMatch(/core\.setTab\(/);
    expect(files.find((f) => f.rel === 'scenes/CardScene.ts')!.text).toMatch(/core\.setTab\(/);
  });

  it('nothing outside core.ts assigns core.tab directly', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (rel === CORE) continue; // setTab + the initialTab default in the constructor
      // `/\r?\n/`, not `'\n'`: on a CRLF checkout every line keeps a trailing `\r`, and `\r` IS an
      // ECMAScript LineTerminator — so `.` refuses to cross it and the `$`-anchored comment strip
      // below matched nothing at all. The line that then got flagged as an offender was list.ts's own
      // explanatory comment — the prose this guard exists NOT to match — so the suite was red on
      // every Windows checkout while staying green in CI. A per-line regex ending in `$` is only as
      // correct as the split that fed it.
      text.split(/\r?\n/).forEach((line, i) => {
        // Comments legitimately spell the anti-pattern out (list.ts says "never a bare `core.tab =`"),
        // so strip them before matching instead of matching the prose.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        // `core.tab = …` / `this.core.tab = …`, but not a comparison (`===`).
        if (/(?:^|[^=!<>])\b(?:this\.)?core\.tab\s*=(?!=)/.test(code)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'a bare `core.tab = …` skips CardSceneCore.setTab, so the incoming tab inherits the outgoing '
      + "tab's scroll offset — the 2026-08-27 blank-wardrobe bug. Call core.setTab(tab) instead (it "
      + `returns false when already on that tab, which is also the render guard):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

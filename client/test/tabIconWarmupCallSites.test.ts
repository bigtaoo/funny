// Static guard: every page that can be entered WITHOUT passing through LobbyScene must warm the
// raster icon art itself and redraw when it lands (2026-08-25).
//
// Why this is a test and not a comment: `buildRasterTabIcon` (render/icons/tabIconRaster.ts) returns
// an EMPTY container while its PNG is still decoding, and registers no 'loaded' callback — so a page
// that paints before the atlas is warm simply has no rail/tab/title glyphs until *something* redraws
// it. LobbyScene warms them for everything entered from the lobby (see preloadIconArt's doc
// comment), and CardScene/EquipmentScene have long carried their own one-liner for the direct-entry
// case.
//
// The sect/family pages used to get that redraw by accident: a caret blink, a busy-tracker tick or a
// drag frame would rebuild the whole body a few times a second. The 2026-08-25 incremental-repaint
// pass removed all of those, which is exactly when the missing glyphs showed up in an A/B screenshot
// — see design/game/SOCIAL_DESIGN.md's 2026-08-25 rows. The fix is one line per scene; this test is
// here so removing it (or adding a fifth such page) fails loudly instead of silently blanking icons.
//
// Deliberately static: `preloadTextureList` resolves off BaseTexture 'loaded' events, which never
// fire under the headless PIXI harness, so a behavioural version of this would hang rather than fail.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../src/scenes');

/** Scenes reachable without LobbyScene mounting first (social hub rail / SLG overlay / deep entry). */
const DIRECT_ENTRY_SCENES = [
  'CardScene.ts',
  'EquipmentScene.ts',
  'SectScene.ts',
  'FamilyScene.ts',
];

describe('tab-icon warm-up call sites', () => {
  for (const file of DIRECT_ENTRY_SCENES) {
    it(`${file} warms the tab-icon art and redraws once it resolves`, () => {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      expect(src).toContain('preloadIconArt');
      // The redraw is the half that actually fixes anything — a bare preload with no `.then` leaves
      // the already-painted frame glyph-less forever.
      expect(src).toMatch(/preloadIconArt\(\)\s*\.then\(\(\)\s*=>\s*this\.render\(\)\)/);
    });
  }

  it('names every scene that draws the social rail (so a new one cannot be forgotten)', () => {
    // The social rail is the widest user of these glyphs; any scene drawing it is reachable from the
    // hub without the lobby. FriendsScene is the hub itself and is only ever entered from the lobby
    // or from one of these pages, so it inherits a warm cache — listed here as a deliberate omission
    // rather than an oversight.
    const railUsers = fs.readdirSync(SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((dir) => fs.readdirSync(path.join(SRC, dir.name), { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.ts'))
        .some((f) => fs.readFileSync(path.join(SRC, dir.name, f.name), 'utf8').includes('drawSocialTabRail')))
      .map((dir) => `${dir.name}.ts`)
      .sort();
    expect(railUsers).toEqual(['FamilyScene.ts', 'FriendsScene.ts', 'SectScene.ts']);
  });
});

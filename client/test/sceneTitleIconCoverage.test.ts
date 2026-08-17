// Static guard: no page title ships without a glyph.
//
// Background: tab-icon batches 1–4 scoped themselves to tab strips, so `drawSceneHeader` drew text
// only and *31 title states across the app had no icon at all* — nobody noticed until a user circled
// a screenshot (design/product/tab-icon-art-prompts-batch5.md). That drift is invisible per-commit:
// a new secondary scene that copies an older `drawSceneHeader(...)` line is indistinguishable from
// correct code, and no runtime test fails. So this scans the source instead: every call passing a
// real title must also pass `icon:`.
//
// Sites that pass `title: null` draw their own title (or none) and are listed explicitly below —
// an allowlist that has to be *edited* to grow, which is the point: adding a scene to it is a
// decision, forgetting an icon isn't.
//
// Runs under plain vitest (no PIXI needed) — just a source-text scan. Run: npm test

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../src');

/**
 * `drawSceneHeader(container, w, h, title, opts?)` call sites that deliberately pass `title: null`,
 * with what draws the title instead. The first three lay out their own `[icon][gap][title]` group
 * via `buildTitleIcon` (asserted below); the last two draw no title at all.
 */
const NULL_TITLE_SITES: Record<string, 'self-titled' | 'no title'> = {
  'scenes/CampaignMapScene.ts': 'self-titled',      // chapter name + owner subtitle
  'scenes/FamilyScene/core.ts': 'self-titled',      // family identity cluster in the bar
  'scenes/SectScene/core.ts': 'self-titled',        // sect identity + alliance buttons
  'scenes/ResultScene/builders.ts': 'no title',     // bar chrome only, result banner owns the space
  'scenes/worldmap/WorldMapRenderer/build.ts': 'no title', // SLG HUD draws its own resource cluster
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Each `drawSceneHeader(` call with its argument text, gathered by counting parens from the call
 * onward — the calls span 1–5 lines and several pass a nested options object, so a per-line regex
 * would read the wrong `icon`/`null` (or miss it entirely).
 */
function callSites(): { file: string; line: number; args: string }[] {
  const out: { file: string; line: number; args: string }[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
    if (rel === 'ui/widgets/SceneHeader.ts') continue; // the definition itself
    const text = fs.readFileSync(file, 'utf8');
    const re = /drawSceneHeader\(/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) break;
      }
      out.push({
        file: rel,
        line: text.slice(0, m.index).split('\n').length,
        args: text.slice(m.index + m[0].length, i),
      });
    }
  }
  return out;
}

describe('every scene title carries an icon (tab-icon batch 5)', () => {
  const sites = callSites();

  it('finds the call sites at all (guards against the scan silently matching nothing)', () => {
    // Was 27 when batch 5 landed; a floor, not an equality, so adding a scene doesn't fail here —
    // it fails the real assertion below instead, with a useful message.
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it('passes `icon:` at every site that passes a real title', () => {
    const offenders = sites
      .filter((s) => !(s.file in NULL_TITLE_SITES))
      .filter((s) => !/\bicon:/.test(s.args))
      .map((s) => `${s.file}:${s.line}`);
    expect(
      offenders,
      `these scene titles would render with no glyph — pass opts.icon (see design/product/`
      + `tab-icon-art-prompts-batch5.md for the concept table), or, if the scene draws its own title, `
      + `pass title: null and add it to NULL_TITLE_SITES in this test:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the allowlisted sites really do pass a null title', () => {
    for (const [file, kind] of Object.entries(NULL_TITLE_SITES)) {
      const own = sites.filter((s) => s.file === file);
      expect(own.length, `${file} (allowlisted as "${kind}") has no drawSceneHeader call any more`).toBeGreaterThan(0);
      for (const s of own) {
        expect(/\bnull\b/.test(s.args), `${file}:${s.line} is allowlisted but passes a real title`).toBe(true);
      }
    }
  });

  it('every self-titled scene builds its glyph through buildTitleIcon', () => {
    // The shared ink rule (paper title → the `content` bake, never the inactive-tab grey) lives in
    // buildTitleIcon; a scene hand-rolling `buildIcon` instead would silently get the washed-out grey.
    for (const [file, kind] of Object.entries(NULL_TITLE_SITES)) {
      if (kind !== 'self-titled') continue;
      // The title row may be split out of core.ts (FamilyScene/SectScene keep it in header.ts), so
      // look across that scene's whole directory rather than only the file with the header call.
      const dir = path.dirname(path.join(SRC_ROOT, file));
      const found = listSourceFiles(dir).some((f) => fs.readFileSync(f, 'utf8').includes('buildTitleIcon('));
      expect(found, `${file} draws its own title but nothing in ${path.relative(SRC_ROOT, dir)} calls buildTitleIcon`).toBe(true);
    }
  });
});

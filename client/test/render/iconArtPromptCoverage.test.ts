// Guards design/product/tab-icon-art-prompts-batch7.md (2026-08-25) against silently going stale.
// That doc is the backlog for the last 48 procedural DrawableIconKinds still on the SketchPen/DRAW
// path (everything left after the tabicon/coin-icon raster work) — it names, for every one of them,
// either a numbered AI-art prompt or a documented "reuse an existing raster icon instead" decision.
// Before this file existed, nothing stopped that doc from drifting the moment someone added, removed,
// or renamed a DrawableIconKind in icons.ts: the doc would keep reading as complete while quietly
// missing (or over-claiming) coverage, and nobody would notice until the next person tried to use it
// as "the list of what's left to convert" and got a wrong answer.
//
// No pixi rendering here — this only reads DRAW's keys and the doc's raw text. Lives in test/render
// only because importing icons.ts pulls pixi.js-legacy (same reason as tabIconContentVariant.test.ts).
// Run: npm test — the default suite's `test/**/*.test.ts` include picks this up.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DRAW } from '../../src/render/icons';

const DOC_PATH = path.resolve(__dirname, '../../../design/product/tab-icon-art-prompts-batch7.md');
const doc = fs.readFileSync(DOC_PATH, 'utf8');

/**
 * The 5 kinds batch 7 judged as "reuse an existing raster icon, no new art needed" (see the doc's
 * 判断结果总表) instead of getting their own numbered prompt — `swords`→pvpTabIcon, `home`→homeTabIcon,
 * `capsule`→gachaTabIcon, `gift`→weeklyTabIcon, `tag`→auctionTabIcon. They still get a doc mention (in
 * the reuse table, not a prompt section), so the blanket "is this kind mentioned at all" check below
 * covers them the same way it covers the 43 that got real prompts.
 */
const REUSE_KINDS = ['swords', 'home', 'capsule', 'gift', 'tag'];

describe('tab-icon-art-prompts-batch7.md — icon-art backlog doc stays in sync with the real DRAW table', () => {
  it('every currently-procedural DrawableIconKind is accounted for (new prompt or documented reuse)', () => {
    // Exact backtick-delimited match (`${kind}`), not a substring search — 'star' must not
    // false-positive against 'titleStar' or 'tabicon_star', which never place a backtick
    // immediately in front of the bare word.
    const missing = Object.keys(DRAW).filter((kind) => !doc.includes(`\`${kind}\``));
    expect(missing).toEqual([]);
  });

  it('the reuse table names real DRAW keys, not stale/renamed ones', () => {
    const stale = REUSE_KINDS.filter((kind) => !(kind in DRAW));
    expect(stale).toEqual([]);
  });

  it('mentions drawInk, the one procedural icon that bypasses the DRAW dispatch table entirely', () => {
    // drawInk (icons/currency.ts) is called directly by HUDView.ts, not through buildIcon()/DRAW,
    // so it can't be picked up by the Object.keys(DRAW) loop above — guard it by name explicitly.
    expect(doc).toContain('`drawInk`');
  });
});

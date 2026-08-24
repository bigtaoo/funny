// Static guard for the 2026-08-24 header-row overlap fix (design/game/LOBBY_IA_REDESIGN_LOG.md §26).
//
// Background: `drawSceneHeader` used to hold back a flat 20% of the bar width for the currency
// cluster scenes draw on top of it. That reserve cannot be a constant — the cluster's width depends
// on the caller's data (digit count, capacity readout, material chips) — and on a 430pt portrait
// viewport the roster's coin balance plus `73/500` came to ~27% of the bar, so the centred title ran
// straight under the coin number. Every scene that draws a cluster now measures it with
// `headerCurrencyWidth(...)`, hands that to `drawSceneHeader` as `opts.rightReserve`, and hands
// `hdr.titleRight` back to `drawHeaderCurrency` as its `leftBound` backstop.
//
// Why this test is STATIC rather than a rendering assertion: the headless harness's `measureText` is
// a flat 7px/char and font-size-independent (claudedocs/client-testing.md), so under it the roster's
// cluster measures ~171px against the old 216px reserve — the bug does not reproduce there, and a
// scene-level "do they overlap?" case is green with or without the plumbing (see
// test/ui/sceneHeaderCurrencyFit.ui.ts, which pins the mechanism at the unit level instead and says
// so in its header). What CAN be checked mechanically is that no call site quietly goes back to
// letting the header guess: that is this file.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Files that CALL drawHeaderCurrency — i.e. draw a cluster over a header. Excludes its own module. */
function callerFiles(): { file: string; rel: string; text: string }[] {
  return listSourceFiles(SRC_ROOT)
    .map((file) => ({ file, rel: path.relative(SRC_ROOT, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ rel, text }) => rel !== 'ui/widgets/SceneHeader/currency.ts'
      && rel !== 'ui/widgets/SceneHeader.ts'
      && /\bdrawHeaderCurrency\s*\(/.test(text));
}

describe('header currency reserve — no scene may let drawSceneHeader guess the cluster width', () => {
  it('finds the call sites at all (canary: a rename must not silently empty this suite)', () => {
    const callers = callerFiles();
    expect(callers.length).toBeGreaterThanOrEqual(8);
    // The scenes known to draw one, so a call site that MOVES rather than disappearing still shows up.
    const rels = callers.map((c) => c.rel);
    // This list is also the record of what the fix had to touch: three of these (Gacha, Recharge,
    // Shop) were found BY this test, not by the grep that preceded it — `grep | head` had quietly
    // truncated the call-site list at five.
    for (const expected of [
      'scenes/AuctionScene/core.ts',
      'scenes/BattlePassScene.ts',
      'scenes/CardScene/list.ts',
      'scenes/EquipmentScene/headerRow.ts',
      'scenes/FriendsScene/chrome.ts',
      'scenes/GachaScene/page.ts',
      'scenes/RechargeScene.ts',
      'scenes/ShopScene/core.ts',
    ]) {
      expect(rels, `${expected} no longer calls drawHeaderCurrency — update this list deliberately`)
        .toContain(expected);
    }
  });

  it.each(callerFiles().map((c) => c.rel))(
    '%s passes a leftBound to drawHeaderCurrency',
    (rel) => {
      const { text } = callerFiles().find((c) => c.rel === rel)!;
      // The 8th argument. Matched loosely (any 7 comma-separated groups before it) because call sites
      // legitimately differ in how they spell the middle arguments; what matters is that something is
      // there, since the parameter is optional and omitting it silently restores the old behaviour.
      const calls = text.match(/drawHeaderCurrency\s*\(([\s\S]*?)\);/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const args = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
        const topLevel = splitTopLevel(args);
        expect(topLevel.length, `drawHeaderCurrency in ${rel} is missing its leftBound argument:\n${call}`)
          .toBeGreaterThanOrEqual(8);
        expect(topLevel[7]!.trim(), `leftBound in ${rel} must not be a literal`).not.toMatch(/^\d+$/);
      }
    },
  );

  it.each(callerFiles().map((c) => c.rel))(
    '%s (or its scene root) measures the reserve with headerCurrencyWidth',
    (rel) => {
      // The measurement may live in a sibling: a scene whose header is baked in core.ts's build()
      // measures there, while the draw call sits in the panel that renders the overlay each frame.
      // So accept it anywhere under the same scene directory (or the same file, for flat scenes).
      const dir = path.dirname(path.join(SRC_ROOT, rel));
      const siblings = listSourceFiles(dir).map((f) => fs.readFileSync(f, 'utf8'));
      const found = siblings.some((text) => /headerCurrencyWidth\s*\(/.test(text) && /rightReserve/.test(text));
      expect(found, `no headerCurrencyWidth(...) + rightReserve pairing found next to ${rel}`).toBe(true);
    },
  );
});

/** Split an argument list on top-level commas (ignoring those inside (), [], {}, `` or quotes). */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote) {
      if (ch === quote && args[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
  }
  out.push(args.slice(start));
  return out;
}

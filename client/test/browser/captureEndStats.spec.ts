// Regenerates `endStatsFixture.ts` — the end-of-match payload the layout sweep's `result` stop is
// handed — by PLAYING A REAL AI MATCH to its end and recording what the game actually produced.
//
// Skipped unless NW_CAPTURE=1, because it is not a test: it asserts nothing about layout, it takes
// as long as a match takes (minutes), and it would be pure cost on every sweep. It exists so the
// fixture has a provenance other than "someone typed plausible numbers".
//
// Why the sweep does not simply play the match itself: it would pay those minutes once per viewport,
// ten times over, to audit a screen whose content is fixed the instant the match ends. And why the
// fixture is not hand-written either — which is what it was until 2026-09-12: hand-written stats are
// a guess at the SHAPE as much as at the values. The first version left `killsByType`/`castsByType`
// empty objects, so the two widest rows on the screen — the per-unit-type breakdowns — rendered as
// nothing at all and the sweep audited a screen the player never sees.
//
// ── Why the recorder has to PLAY (2026-09-12) ────────────────────────────────────────────────────
// The first version started an AI match and waited. It never finished, and both reasons are
// structural rather than bad luck:
//
//  1. A PvP match with an idle player does have a guaranteed end, but it is at
//     FORCE_DRAW_THRESHOLD_TICKS (engine config: 30600 ticks / 30 Hz = 17 minutes) — the engine's
//     own stalemate timer. The old ceiling here was 15 minutes, i.e. BELOW the only end state that
//     run could ever reach.
//  2. Waiting it out would have been the wrong recording anyway. The AI plays the Top side only
//     (AISystem.ts); an idle Bottom is a player who sent nothing, killed nothing and cast nothing,
//     so `killsByType`/`castsByType` for the local side — the reason this fixture exists — would
//     come out as exactly the empty objects the hand-written version had.
//
// Surrender is not the fallback it looks like, either: the confirm button calls `onExitToLobby`
// (GameRenderer/input.ts), and for a vs-AI match that goes straight back to the lobby. It produces
// no stats and never reaches ResultScene, so there is nothing there to record.
//
// So the harness plays, through the real input path: tap a hand card, tap a cell — the same
// tap-select gesture a player uses (GameRenderer/input.ts `startTapSelect` → `commitCardPlay`), at
// real screen coordinates, through the real InputManager. It plays badly (first affordable card,
// first free lane) and that is fine: what the fixture needs is a real distribution across unit
// types on both sides, not a good game.
//
//   Run: NW_CAPTURE=1 npx playwright test --config playwright.portrait.config.ts captureEndStats

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  uid, registerAndEnterLobby, callCb, currentScreen, dismissFeatureGuide, screenIs,
} from './lib/nwE2E';

/**
 * Ceiling for the match itself. Above the engine's own FORCE_DRAW_THRESHOLD_TICKS (17 min) so that
 * even a match which somehow reaches the stalemate timer still ends inside it, rather than being
 * cut off one state short of the thing we came to record. An actually-played match ends far sooner.
 */
const MATCH_TIMEOUT_MS = 20 * 60_000;

/** Pause before looking again when nothing is playable — roughly the regen time of a cheap card. */
const IDLE_MS = 500;

/**
 * The lanes a unit or building may be placed in (server/engine/src/config.ts `ATTACK_LANES` —
 * cols 5/6 are the base). Written out rather than imported because this array is handed to
 * `page.evaluate`, whose arguments are serialised.
 */
const ATTACK_LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];

interface Pt { x: number; y: number }

type PlayStep =
  /** Tap `card`, then `target` — real coordinates in the page's own pixel space. */
  | { kind: 'play'; card: Pt; target: Pt }
  /** Nothing playable this instant: no affordable card, every lane blocked, or settlement pending. */
  | { kind: 'idle' }
  /** ResultScene is up — the match is over and its payload is readable. */
  | { kind: 'done' };

/**
 * Works out the next play by reading the live engine, and returns it as two points to click.
 *
 * Reaching `views.manager.current.renderer.core` walks three `private` fields. That is deliberate,
 * and it is test code's privilege rather than a seam anyone should add to src: the alternative is
 * deriving hand-slot and board-cell pixel coordinates from the viewport size, which would restate
 * the layout's arithmetic (design box, scale factor, letterbox bands) inside the test and break on
 * every layout change. `slotCenter`/`gridToScreen` ARE that arithmetic, already written, and
 * `container.toGlobal` turns their design-space answer into the page coordinates `page.mouse.click`
 * takes — the same global-coordinate route `tapLabel` already drives the sweep's modals with.
 */
async function nextPlay(page: Page, lanes: number[]): Promise<PlayStep> {
  return page.evaluate((cols: number[]): PlayStep => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const e2e = (window as any).__nwE2E;
    if (e2e?.state?.screen === 'result') return { kind: 'done' };
    const core = e2e?.views?.manager?.current?.renderer?.core;
    // Not in the battle yet (the cross-fade's loading scene), or already decided: `gameEnded` is
    // set the moment the engine reports game_over, and settlement is deferred a couple of seconds
    // past that — input is refused for that whole window (input.ts), so nothing should be sent.
    if (!core || core.gameEnded) return { kind: 'idle' };
    const state = core.engine.state;
    const player = core.localPlayer(state);
    const slots = player?.hand?.slots ?? [];
    const toGlobal = (p: Pt): Pt => {
      const g = core.container.toGlobal(p);
      return { x: g.x, y: g.y };
    };

    // The first live enemy unit on the board, if any — the only cell worth aiming a spell at.
    let enemy: { col: number; row: number } | null = null;
    for (const u of state.board.units.values()) {
      if (u.side !== core.layout.localSide && !u.isDead) { enemy = { col: u.col, row: u.row }; break; }
    }

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || slot.card.cost > player.ink) continue;
      const card = slot.card;
      let col = -1;
      let row = -1;
      if (card.cardType === 'unit') {
        row = core.localSpawnRow;
        col = cols.find((c) => !state.board.isCellOccupiedByUnit(c, row)) ?? -1;
      } else if (card.cardType === 'building') {
        row = core.localBuildRow;
        col = cols.find((c) => !state.board.hasBuildingAt(c, row) && !state.board.isNoBuild(c, row)) ?? -1;
      } else {
        // Spells: Haste ignores the cell, Meteor takes one, Rockslide/BridgeCollapse take a lane.
        // With no enemy on the board none of them is worth the ink — leave the card in hand.
        if (!enemy) continue;
        col = enemy.col;
        row = enemy.row;
      }
      if (col < 0) continue;
      return {
        kind: 'play',
        card: toGlobal(core.handView.slotCenter(i)),
        target: toGlobal(core.layout.gridToScreen(col, row)),
      };
    }
    return { kind: 'idle' };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, lanes);
}

test.describe('end-of-match stats fixture', () => {
  test('play one AI match and record its result payload', async ({ page }) => {
    test.skip(!process.env.NW_CAPTURE, 'set NW_CAPTURE=1 to regenerate test/browser/endStatsFixture.ts');
    test.setTimeout(MATCH_TIMEOUT_MS + 180_000);
    await registerAndEnterLobby(page, uid('capture'), 'CaptureStats');
    expect(await callCb(page, 'lobbyCb', 'onStartGame', ['AI'])).toBe(true);
    // A fresh account has seen no feature guide, and the guide is shown INSTEAD of navigating
    // (nav/lobby.ts `withGuide`) — on that account this is the step that actually starts the match.
    await dismissFeatureGuide(page);
    await screenIs(page, 'game', 60_000);

    const deadline = Date.now() + MATCH_TIMEOUT_MS;
    let plays = 0;
    for (;;) {
      const step = await nextPlay(page, ATTACK_LANES);
      if (step.kind === 'done') break;
      if (Date.now() > deadline) break;
      if (step.kind === 'idle') { await page.waitForTimeout(IDLE_MS); continue; }
      // Tap-select: the card, then the cell. Two clicks, exactly as a finger does it.
      await page.mouse.click(step.card.x, step.card.y);
      await page.mouse.click(step.target.x, step.target.y);
      plays++;
    }
    expect(await currentScreen(page), `match did not reach ResultScene after ${plays} plays`).toBe('result');

    // `showResult` is handed one `ResultViewProps`; only its data half is a fixture — `cb` is the
    // live scene callbacks bag and `localOwner` is whichever side this capture happened to play.
    const captured = await page.evaluate(() => {
      const props = window.__nwE2E?.state?.resultArgs?.[0] as
        { winner?: number | null; stats?: unknown[] } | undefined;
      if (!props || !Array.isArray(props.stats)) return null;
      return JSON.parse(JSON.stringify({ winner: props.winner ?? null, stats: props.stats })) as
        { winner: number | null; stats: unknown[] };
    });
    expect(captured, 'ResultScene was shown without winner/stats').not.toBeNull();
    expect(captured!.stats.length, 'expected one PlayerStats per side').toBe(2);

    const file = path.join('test', 'browser', 'endStatsFixture.ts');
    fs.writeFileSync(file, `${header(plays)}
/** The winner as onGameEnd takes it: the owning side's id, or null for a draw. */
export const REAL_END_WINNER: number | null = ${JSON.stringify(captured!.winner)};

/** Both sides' PlayerStats, exactly as the engine produced them. */
export const REAL_END_STATS: Record<string, unknown>[] = ${JSON.stringify(captured!.stats, null, 2)};
`);
    // eslint-disable-next-line no-console
    console.log(`wrote ${file} after ${plays} plays`);
  });
});

const header = (plays: number): string =>
  `// GENERATED by captureEndStats.spec.ts (NW_CAPTURE=1) — do not hand-edit.
//
// The arguments a real, played-out AI match handed ResultScene, captured on ${new Date().toISOString().slice(0, 10)}
// after ${plays} plays by the recorder. The layout sweep replays them into the \`result\` stop rather
// than playing the match again on every viewport; see captureEndStats.spec.ts for why this is a
// recording rather than a fixture, and why the recorder plays rather than waits.
//
// The extreme end of the range is a separate stop (\`result+extreme\`, portraitLayout.spec.ts): a
// recorded match is realistic, and realistic is the one thing it cannot be while also being extreme.
`;

// Static guard over `client/src/app/PixiAppViews.ts`: every screen must route its mount through
// `SceneMounts`, and the rebuild policy each screen gets is pinned here by name.
//
// ## Why a guard, and why this shape
//
// The 2026-09-14 change (rotation re-lays out every rebuildable screen, not just the lobby) replaced
// a per-screen arm/disarm lifetime with a single piece of state: `SceneMounts.respawn`, "how to put
// the CURRENT screen back". That is strictly better behaviour, but it introduces a failure mode the
// old design could not have — a new `showX` that calls `this.manager.goto(...)` directly, as ~20 of
// them did before this change and as the surrounding code still reads like:
//
//     showNewThing(cb) { this.manager.goto(new NewThingScene(this.layout, this.input, cb)); }
//
// never claims the screen, so `respawn` keeps pointing at whatever the player was on BEFORE. The
// next rotation then rebuilds that previous screen on top of this one — i.e. the player is silently
// yanked back a screen by turning their phone. Nothing throws, no scene is obviously wrong, and it
// only reproduces on a device that rotates. That is exactly the shape of bug that needs a mechanical
// gate rather than a reviewer noticing.
//
// The policy table below is the second half: it is not redundant with the routing check, it makes
// RECLASSIFYING a screen (rebuildable ↔ never-rebuilt) a deliberate two-file edit. Both directions
// are silent in production — a menu screen wrongly marked `never` just keeps the old bug on one
// screen; a battle wrongly marked `rebuilt` restarts the match on rotation.
//
// Source-reading rather than behavioural, for the same reason as appAssetGateWiring.test.ts:
// PixiAppViews is not importable in this suite (its ~30 scene classes reach `@nw/shared`, which
// needs server/node_modules). What each policy MEANS is tested for real in test/sceneMounts.test.ts;
// what this file pins is which screen got which.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.resolve(__dirname, '../src/app/PixiAppViews.ts'), 'utf8');

/** What a settled viewport change does to a screen, as derived from how it mounts. */
type Policy =
  | 'rebuilt'          // mounts.mount(...) — replay the factory against the new layout
  | 'rebuilt-on-gate'  // mounts.takeScreen() now, mounts.armRespawn(...) once an asset gate is through
  | 'never'            // mounts.volatile(...) / a bare mounts.takeScreen() — left at its entry layout
  | 'lobby';           // mounts.lobby(...) — rebuilt by the app core instead

/**
 * The pinned policy for every screen PixiAppViews can show. Changing an entry here should mean you
 * meant to change what rotating the phone does on that screen — see SceneMounts' header for what
 * makes a screen un-rebuildable (state a fresh constructor cannot restore).
 */
const EXPECTED: Record<string, Policy> = {
  // Menu / shop / meta screens and the stage-level dialogs: nothing a constructor cannot redo.
  showConsent: 'rebuilt',
  showAgeGate: 'rebuilt',
  showReconnectPrompt: 'rebuilt',
  showSettings: 'rebuilt',
  showLogin: 'rebuilt',
  showShop: 'rebuilt',
  showCampaignMap: 'rebuilt',
  showLevelPrep: 'rebuilt',
  showCardCodex: 'rebuilt',
  showCardRoster: 'rebuilt',
  showEquipment: 'rebuilt',
  showStats: 'rebuilt',
  showAchievements: 'rebuilt',
  showLeaderboard: 'rebuilt',
  showBattlePass: 'rebuilt',
  showRecharge: 'rebuilt',
  showTitles: 'rebuilt',
  showDaily: 'rebuilt',
  showEvents: 'rebuilt',
  showResult: 'rebuilt',
  showDeckBuilder: 'rebuilt',
  // SLG / social panels — rebuildable on their full-screen path; the overlay path is never rebuilt
  // (the host underneath would be the thing needing it), which mountSlg handles on its own.
  showFriends: 'rebuilt',
  showChat: 'rebuilt',
  showFamily: 'rebuilt',
  showSect: 'rebuilt',
  showAuction: 'rebuilt',
  showDefenseEditor: 'rebuilt',
  showCity: 'rebuilt',

  // Behind the gacha asset gate: armed only once the gate is through (the rebuild then skips it,
  // since the textures are warm), and dropped if the player left while it was open.
  showGacha: 'rebuilt-on-gate',

  // A fresh constructor cannot restore what these hold.
  showIntro: 'never',           // a cinematic restarting mid-beat
  showRealLayerInterlude: 'never',
  showReplay: 'never',          // the playhead
  showStatePlayer: 'never',
  showGame: 'never',            // an engine mid-match
  showGameNet: 'never',
  showRoom: 'never',            // contents arrive only as server pushes
  showWorldMap: 'never',        // camera + tile cache + live subscriptions

  showLobby: 'lobby',
};

/** Index of the bracket matching the `open`-th one, given its pair. */
function matchBracket(from: number, open: '(' | '{', close: ')' | '}'): number {
  let depth = 0;
  for (let i = from; i < SRC.length; i++) {
    if (SRC[i] === open) depth += 1;
    else if (SRC[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${open}${close} from index ${from}`);
}

/**
 * Body of `name` as source text.
 *
 * Deliberately not "the first `{` after the signature": `showReplay`'s parameter list ends with
 * `siegeAcademy?: { hp: number; damage: number; siege: number }`, and taking that brace as the body
 * made the whole method read as unrouted — a false alarm that looks exactly like the real bug this
 * file exists to catch. So the parameter list is paren-matched first, and the body is the first
 * brace after it.
 */
function methodBody(name: string): string {
  const at = SRC.search(new RegExp(`\\n  (?:private )?${name}[(<]`));
  if (at < 0) throw new Error(`no method ${name}() in PixiAppViews.ts`);
  const params = matchBracket(SRC.indexOf('(', at), '(', ')');
  const open = SRC.indexOf('{', params);
  return SRC.slice(open, matchBracket(open, '{', '}') + 1);
}

/** Every `showX` method the class declares, in source order. */
function screenMethods(): string[] {
  return [...SRC.matchAll(/\n {2}(show[A-Z]\w*)[(<]/g)].map((m) => m[1]!);
}

/**
 * `mountSlg` is the one legitimate indirection — seven screens delegate their whole mount to it —
 * so its body counts as part of theirs. Nothing else may stand between a `showX` and SceneMounts:
 * a second such helper would be a second place for the routing to be wrong.
 */
function routedBody(name: string): string {
  const body = methodBody(name);
  return body.includes('this.mountSlg(') ? body + methodBody('mountSlg') : body;
}

function policyOf(name: string): Policy | null {
  const b = routedBody(name);
  if (b.includes('this.mounts.lobby(')) return 'lobby';
  if (b.includes('this.mounts.mount(')) return 'rebuilt';
  if (b.includes('this.mounts.armRespawn(')) return 'rebuilt-on-gate';
  if (b.includes('this.mounts.volatile(') || b.includes('this.mounts.takeScreen(')) return 'never';
  return null;
}

describe('PixiAppViews — every screen routes its mount through SceneMounts', () => {
  it('has no screen that mounts without claiming the screen', () => {
    // The whole point: an unrouted showX leaves `respawn` pointing at the PREVIOUS screen, and the
    // next rotation rebuilds that one on top of this one.
    const unrouted = screenMethods().filter((m) => policyOf(m) === null);
    expect(unrouted, 'add a mounts.mount / mounts.volatile / mounts.takeScreen call').toEqual([]);
  });

  it('covers every screen in the pinned policy table', () => {
    // Catches the other direction: a screen added to the class but never classified here, which
    // would otherwise sail through the check above on whichever verb its author happened to copy.
    const declared = screenMethods();
    expect(declared.filter((m) => !(m in EXPECTED)), 'new screen: pin its policy in EXPECTED').toEqual([]);
    expect(Object.keys(EXPECTED).filter((m) => m !== 'showLobby' && !declared.includes(m)), 'stale EXPECTED entry').toEqual([]);
  });

  it('gives each screen the rebuild policy it is pinned to', () => {
    const actual: Record<string, Policy | null> = {};
    for (const m of screenMethods()) actual[m] = policyOf(m);
    // showLobby is in `screenMethods()` too, so this compares the whole table in one assertion —
    // a diff here names every screen that moved, not just the first.
    expect(actual).toEqual(EXPECTED);
  });

  it('never gotos the SceneManager without first claiming the screen', () => {
    // Three methods mount themselves rather than handing the constructor to SceneMounts (the two
    // asset-gated ones and the two that need the scene instance before goto). Each must still say
    // "this screen is mine now", or it inherits the previous screen's respawn exactly as an
    // unrouted showX would.
    const offenders = screenMethods().filter((m) => {
      const b = methodBody(m);
      return b.includes('this.manager.goto(')
        && !b.includes('this.mounts.takeScreen(')
        && !b.includes('this.mounts.armRespawn(');
    });
    expect(offenders).toEqual([]);
  });

  it('keeps mountSlg the only hop between a screen and SceneMounts', () => {
    // `routedBody` follows exactly one helper. A second one would silently become a blind spot for
    // every check above — they would read a body with no mounts.* call and report `null`, which the
    // first test reads as "unrouted" rather than "the test cannot see it".
    const helpers = [...SRC.matchAll(/\n {2}(?:private )?(\w+)[(<][^)]*\)[^{]*\{/g)]
      .map((m) => m[1]!)
      .filter((n) => !n.startsWith('show') && n !== 'constructor' && n !== 'hideOverlay');
    expect(helpers).toEqual(['mountSlg']);
  });
});

describe('PixiAppViews — overlays', () => {
  it('routes hideOverlay through SceneMounts so the host gets its rebuild back', () => {
    // A bare `this.manager.popOverlay()` here would leave the host's respawn parked forever, i.e.
    // the screen the player returns to silently stops responding to rotation.
    expect(methodBody('hideOverlay')).toContain('this.mounts.popOverlay(');
  });

  it('parks rather than claims on the overlay path', () => {
    // Both overlay hosts (CardScene under Equipment per ADR-072, WorldMapScene under the SLG panels
    // per ADR-044) must stay the screen being rebuilt. `mounts.overlay()` parks; `mounts.mount()`
    // would take the screen over and let a rotation tear the host out from under the panel.
    for (const m of ['showEquipment', 'mountSlg']) {
      const b = methodBody(m);
      expect(b, `${m} must push overlays via mounts.overlay()`).toContain('this.mounts.overlay(');
      expect(b, `${m} must not pushOverlay behind SceneMounts' back`).not.toContain('this.manager.pushOverlay(');
    }
  });
});

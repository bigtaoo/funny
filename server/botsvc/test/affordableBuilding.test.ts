// affordableBuilding (slgActions.ts) picked directly, for the branches bot.test.ts's tickSlg suite
// does not reach through a whole turn: the desk gate and max levels it mirrors from worldsvc, the
// rotation cursor wrapping past the last key, and the stickerShop jump turning itself off once the
// shop is built. bot.test.ts covers the sticker-first pick, a full queue, and an affordable key
// beating the next one in the rotation.
import { describe, it, expect } from 'vitest';
import { BUILDING_MAX_LEVEL, DESK_MAX_LEVEL } from '@nw/shared';
import { affordableBuilding } from '../src/slgActions';
import type { PlayerWorldView } from '../src/worldClient';

const RICH = { ink: 1e9, paper: 1e9, graphite: 1e9, metal: 1e9, sticker: 1e9 };
/** Shop already built, so the sticker-first jump is off and the plain rotation shows. */
const me = (over: Partial<PlayerWorldView> = {}): PlayerWorldView =>
  ({ joined: true, buildings: { desk: 5, stickerShop: 1 }, resources: RICH, ...over });

describe('affordableBuilding', () => {
  it('takes the key under the cursor and moves the cursor one past it', () => {
    // P1 order: desk, inkPot, paperTray, graphiteMill, metalForge, stickerShop, cabinet, drillYard.
    expect(affordableBuilding(me(), 0)).toEqual({ key: 'desk', buildRotation: 1 });
    expect(affordableBuilding(me(), 3)).toEqual({ key: 'graphiteMill', buildRotation: 4 });
  });

  it('wraps past the last key to the front of the rotation', () => {
    // drillYard (index 7) needs metal; without it the scan wraps to desk at index 0.
    const view = me({ resources: { ...RICH, metal: 0 } });
    expect(affordableBuilding(view, 7)).toEqual({ key: 'desk', buildRotation: 9 });
  });

  it('skips a key the desk gate refuses, like worldsvc would', () => {
    // paperTray -> 2 needs desk 2; the next key in the rotation is taken instead.
    const view = me({ buildings: { desk: 1, stickerShop: 1, paperTray: 1 } });
    expect(affordableBuilding(view, 2)).toEqual({ key: 'graphiteMill', buildRotation: 4 });
  });

  it('skips a desk at its max level', () => {
    const view = me({ buildings: { desk: DESK_MAX_LEVEL, stickerShop: 1 } });
    expect(affordableBuilding(view, 0)).toEqual({ key: 'inkPot', buildRotation: 2 });
  });

  it('skips a building at its max level even under a maxed desk', () => {
    const view = me({ buildings: { desk: DESK_MAX_LEVEL, stickerShop: 1, inkPot: BUILDING_MAX_LEVEL } });
    expect(affordableBuilding(view, 1)).toEqual({ key: 'paperTray', buildRotation: 3 });
  });

  it('nothing affordable: null, and the cursor stays where it was', () => {
    expect(affordableBuilding(me({ resources: {} }), 5)).toEqual({ key: null, buildRotation: 5 });
    expect(affordableBuilding(me({ resources: undefined }), 2)).toEqual({ key: null, buildRotation: 2 });
  });

  it('the stickerShop jump leaves the cursor alone, and stops once the shop stands', () => {
    const unbuilt = me({ buildings: { desk: 5 } });
    expect(affordableBuilding(unbuilt, 3)).toEqual({ key: 'stickerShop', buildRotation: 3 });
    // Built: stickerShop is only taken when the rotation reaches it.
    expect(affordableBuilding(me(), 3).key).toBe('graphiteMill');
  });

  it('no stickerShop jump when the shop cannot be paid for; the rotation goes on', () => {
    // graphiteMill costs only paper; the shop also wants graphite.
    const view = me({ buildings: { desk: 5 }, resources: { paper: 1e9 } });
    expect(affordableBuilding(view, 0)).toEqual({ key: 'graphiteMill', buildRotation: 4 });
  });

  it('a view with no buildings reads as a lone desk at level 1, which allows any level-1 build', () => {
    // Graphite only: desk, inkPot and stickerShop all want paper; paperTray -> 1 needs only graphite,
    // and the defaulted desk 1 does not gate a level-1 target.
    const view: PlayerWorldView = { joined: true, resources: { graphite: 1e9 } };
    expect(affordableBuilding(view, 0)).toEqual({ key: 'paperTray', buildRotation: 3 });
  });
});

// Coverage for `client/src/scenes/LobbyScene/matchState.ts` — the two-line fork that decides what
// pressing START does, and the local-AI state machine behind it.
//
// 0% until now. It is three statements of routing, and the reason it is worth a gate is that BOTH
// outcomes are a working game: take the wrong branch and an online player who tapped ranked gets a
// local AI match against a randomly-named bot, with a plausible VS screen and a real battle. Nothing
// errors, nothing looks broken, and the only symptom is that ranked matchmaking "sometimes doesn't
// find anyone" — which reads as a server problem. That is the shape of failure this file exists for,
// and no scene-level suite would catch it either, because a scene test that stubs the callbacks sees
// a match start in both worlds.
//
// `./core` is stubbed: it is the scene's PIXI-bearing module (drawBtn draws, randomAiName is only
// there because it shares the file). The functions under test hold no state of their own — every
// field lives on Core — so a plain object stands in for it, which is the same fake-core treatment
// `test/socialPointerRouting.test.ts` gives FamilyScene/SectScene.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const drawBtn = vi.fn();
vi.mock('../src/scenes/LobbyScene/core', () => ({
  drawBtn: (...a: unknown[]) => drawBtn(...a),
  randomAiName: () => 'Bot McBotface',
}));

import { onStartPressed, matchFound } from '../src/scenes/LobbyScene/matchState';
import type { LobbySceneCore } from '../src/scenes/LobbyScene/core';
import { setLocale, t } from '../src/i18n';

/** Only the fields these two functions touch — everything else on Core is irrelevant here. */
function fakeCore(cb: { online?: boolean; onStartRanked?: () => void } = {}) {
  return {
    cb,
    state: 'idle',
    matchTimer: 99, dotsTimer: 99, dotCount: 9, vsTimer: 99,
    opponentName: '',
    btnRect: { x: 0, y: 0, w: 240, h: 64 },
    btnBg: { tag: 'btnBg' },
    btnLabel: { text: '' },
    oppLabel: { text: '' },
    vsLayer: { visible: false },
  } as unknown as LobbySceneCore & { state: string; opponentName: string };
}

describe('lobby start button routing', () => {
  beforeEach(() => { setLocale('zh'); drawBtn.mockClear(); });

  it('sends an online, logged-in player to ranked matchmaking and starts NO local match', () => {
    const onStartRanked = vi.fn();
    const core = fakeCore({ online: true, onStartRanked });
    onStartPressed(core);

    expect(onStartRanked).toHaveBeenCalledTimes(1);
    // The load-bearing half: it returns before touching any local-match state. If it fell through,
    // the player would be in a local AI match AND in the ranked queue, and the screen would say
    // "matching..." for whichever finished first.
    expect(core.state).toBe('idle');
    expect(core.matchTimer).toBe(99);
    expect(drawBtn).not.toHaveBeenCalled();
    expect(core.btnLabel.text).toBe('');
  });

  it('falls back to the local AI match when offline', () => {
    const onStartRanked = vi.fn();
    const core = fakeCore({ online: false, onStartRanked });
    onStartPressed(core);

    expect(onStartRanked).not.toHaveBeenCalled();
    expect(core.state).toBe('matching');
    expect(core.btnLabel.text).toBe(`${t('lobby.matching')}...`);
  });

  it('falls back to the local AI match when online but no ranked callback is wired', () => {
    // Both halves of the condition matter: a build that is online but has no ranked entry point
    // (an older host, a target that ships without PvP) must still get a playable button rather than
    // a dead one.
    const core = fakeCore({ online: true });
    onStartPressed(core);
    expect(core.state).toBe('matching');
  });

  it('resets every timer the local search reads, so a second search cannot inherit the first', () => {
    const core = fakeCore({ online: false });
    onStartPressed(core);
    expect(core.matchTimer).toBe(0);
    expect(core.dotsTimer).toBe(0);
    expect(core.dotCount).toBe(0);
  });

  it('redraws the button from the STORED rect, not from the live display object', () => {
    // Pinned because the comment in the source says why and nothing else enforces it: the sketch
    // stroke overshoots the box, so re-reading gfx bounds grows the button a little on every redraw.
    const core = fakeCore({ online: false });
    onStartPressed(core);
    expect(drawBtn).toHaveBeenCalledWith(core.btnBg, 240, 64, false);
  });

  it('matchFound moves to the VS screen with a named opponent', () => {
    const core = fakeCore({ online: false });
    matchFound(core);
    expect(core.state).toBe('vs');
    expect(core.vsTimer).toBe(0);
    expect(core.opponentName).toBe('Bot McBotface');
    expect(core.oppLabel.text).toBe('Bot McBotface');
    expect(core.vsLayer.visible).toBe(true);
  });
});

// Local-AI match state machine — split out of build.ts (2026-08-12, form ① independent function
// module per claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under
// the 500-line convention. All state (state/matchTimer/vsTimer/dotsTimer/dotCount/opponentName/
// btnBg/btnLabel/vsLayer/oppLabel) already lives on Core, so this stays a pair of free functions
// (no local state of its own) rather than becoming its own domain class — called directly from
// BuildPanel.handleDown() (the tap that starts a match) and the outer LobbyScene assembly's
// update() (which advances the timers and, on expiry, calls matchFound() here).
import { t } from '../../i18n';
import { drawBtn, randomAiName, type LobbySceneCore } from './core';

export function onStartPressed(core: LobbySceneCore): void {
  // Online + logged in → real PvP ranked matchmaking (RoomScene searching flow).
  // Offline / no server → the local AI quick-match below.
  if (core.cb.online && core.cb.onStartRanked) {
    core.cb.onStartRanked();
    return;
  }
  core.state = 'matching'; core.matchTimer = 0; core.dotsTimer = 0; core.dotCount = 0;
  // Use the stored rect, not gfx.width — the sketch stroke overshoots the box,
  // so re-reading bounds would grow the button on every redraw.
  drawBtn(core.btnBg, core.btnRect.w, core.btnRect.h, false);
  core.btnLabel.text = t('lobby.matching') + '...';
}

export function matchFound(core: LobbySceneCore): void {
  core.state = 'vs'; core.vsTimer = 0;
  core.opponentName  = randomAiName();
  core.oppLabel.text = core.opponentName;
  core.vsLayer.visible = true;
}

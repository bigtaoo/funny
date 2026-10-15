// tutorialHost.ts — wires the TutorialDirector (ch0_tutorial) to the battle renderer: the view hooks it
// highlights and frames with, and its two-part graduation (WIN moment, then leave). Split out of core.ts
// for the 500-line rule (claudedocs/client-modules.md).
import type { TutorialConfig, TutorialHost } from '../TutorialDirector';
import { stateRecorder } from '../../game/replay/StateRecorder';
import type { GameRendererCore } from './core';

export function buildTutorialHost(core: GameRendererCore, config: TutorialConfig): TutorialHost {
  let finished = false;
  return {
    container: core.container,
    layout: core.layout,
    config,
    highlightUnitLane: (col) => core.boardView.showUnitLaneHighlights([col], new Set(), col),
    highlightBuildingLane: (col) => core.boardView.showBuildingHighlights([col], core.localBuildRow),
    clearLaneHighlights: () => core.boardView.clearHighlights(),
    handSlotCenter: (i) => core.handView.slotCenter(i),
    buildCardGhost: (i) => core.input.buildCardGhost(i),
    // Graduation, part 1: the scripted victory moment — WIN banner + stinger, the same pair a real
    // game_over shows (the tutorial level never actually decides a winner, §3.5). The scene stays up:
    // the director owns the exit (finish).
    forceVictory: () => {
      if (core.gameEnded) return;
      core.gameEnded = true;
      stateRecorder.setWinner(core.localOwner);
      core.input.cancelDrag(); core.input.cancelTapSelect();
      core.hudView.showGameOver(core.localOwner, core.localOwner);
      core.events.playResultStinger(core.localOwner);
    },
    // Graduation, part 2: settle as a local win.
    finish: () => {
      if (finished) return;
      finished = true;
      const winner = core.localOwner;
      const stats = core.engine.state.snapshotStats();
      const summary = core.engine.state.snapshotSummary();
      core.scheduleGameEnd(() => core.onGameEnd?.(winner, stats, summary), 0);
    },
    onSkip: () => core.onExitToLobby?.(),
  };
}

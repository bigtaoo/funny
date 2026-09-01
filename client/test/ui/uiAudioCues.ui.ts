// UI audio triggers (AUDIO_DESIGN §7 step 4): the cues the shared hit table (src/ui/hits.ts) and
// the outlets that deliberately are not hits emit once a real scene is driven through a real tap.
//
// The companion to gameRendererAudio.ui.ts, and split from it for the same reason: *which cue, how
// many times* is unit-testable against a fake `AudioBus`; *whether it is pleasant, and whether its
// rate is bearable* is not, and is measured in a real browser instead (AUDIO_DESIGN §0.1).
//
// Every assertion below goes through a genuine pointer event, never a direct call to a hit's `fn`
// — a cue attached to a hit that no tap can actually reach would pass the direct-call version of
// this file and still be silent in the game.

import * as PIXI from 'pixi.js-legacy';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';
import { BASE_COLS } from '@nw/engine/config';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { ResultScene } from '../../src/scenes/ResultScene';
import { ReconnectPromptDialog } from '../../src/ui/dialogs/ReconnectPromptDialog';
import type { PlayerStats } from '@nw/engine/types';
import { revealCue } from '../../src/scenes/GachaScene/core';
import { showToastMessage, setToastSink } from '../../src/net/log';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, AudioCue } from '../../src/audio/types';
import type { Rect } from '../../src/layout/ILayout';
import type { Hit } from '../../src/ui/hits';
import type { AudioSlider } from '../../src/scenes/SettingsScene/audioPanel';
import {
  AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS,
  installAudioSettings, resetAudioSettingsForTest, getAudioSettings,
} from '../../src/audio/audioSettings';
import type { IStorage } from '../../src/platform/IPlatform';

function memStorage(): IStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}
initI18n('en', memStorage(), ['zh', 'en', 'de']);

class RecordingBus implements AudioBus {
  readonly cues: AudioCue[] = [];
  async preload(): Promise<void> {}
  play(cue: AudioCue): void { this.cues.push(cue); }
  setSfxVolume(): void {}
  setMusicVolume(): void {}
  playMusic(): void {}
  resume(): void {}
}

let bus: RecordingBus;
beforeEach(() => { bus = new RecordingBus(); setAudioBus(bus); });
afterEach(() => { setAudioBus(new NullAudioBus()); resetAudioSettingsForTest(); });

/** Centre of a rect, in design space. */
function centre(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

interface SettingsInternals { hits: Hit[]; audioSliders: AudioSlider[] }

function buildSettings(): { scene: SettingsScene; input: InputManager; inner: SettingsInternals } {
  const input = new InputManager();
  const scene = new SettingsScene(createLayout(800, 1280), input, {
    playerName: 'Tester',
    onBack: vi.fn(),
  } as never);
  return { scene, input, inner: scene as unknown as SettingsInternals };
}

// ── Menu scenes: the default tap, and the back button's own cue ────────────────

describe('menu taps — the cue comes from the shared hit table', () => {
  it('the header Back button sounds like back, not like a tap', () => {
    const { scene, input, inner } = buildSettings();
    const back = centre(inner.hits[0]!.rect);
    input._emitDown(back.x, back.y);
    expect(bus.cues).toEqual(['sfx.ui.back']);
    scene.destroy();
  });

  it('an ordinary button gets sfx.ui.tap without having to say so', () => {
    const { scene, input, inner } = buildSettings();
    const plain = inner.hits.slice(1).find((h) => h.sound === undefined);
    expect(plain, 'settings draws at least one un-annotated button').toBeTruthy();
    const p = centre(plain!.rect);
    input._emitDown(p.x, p.y);
    expect(bus.cues).toEqual(['sfx.ui.tap']);
    scene.destroy();
  });

  it('a tap that hits nothing is silent', () => {
    const { scene, input } = buildSettings();
    input._emitDown(4, 1275); // bottom-left corner: background, no hit
    expect(bus.cues).toEqual([]);
    scene.destroy();
  });
});

// ── Settings: the volume block ────────────────────────────────────────────────

describe('SettingsScene volume block (AUDIO_DESIGN §4)', () => {
  it('draws three sliders', () => {
    installAudioSettings({ storage: memStorage() });
    const { scene, inner } = buildSettings();
    expect(inner.audioSliders).toHaveLength(3);
    scene.destroy();
  });

  it('dragging the sfx slider past the right end pins it to 1 and persists', () => {
    const store = memStorage();
    installAudioSettings({ storage: store });
    const { scene, input, inner } = buildSettings();
    const sfx = inner.audioSliders[2]!.rect; // master, bgm, sfx — CHANNELS order in audioPanel.ts
    const y = sfx.y + sfx.h / 2;
    input._emitDown(sfx.x + sfx.w / 2, y);
    input._emitMove(sfx.x + sfx.w * 4, y);
    input._emitUp(sfx.x + sfx.w * 4, y);
    expect(getAudioSettings().sfx).toBe(1);
    expect(JSON.parse(store.data.get(AUDIO_SETTINGS_KEY)!).sfx).toBe(1);
    scene.destroy();
  });

  it('a slider press and the whole drag are silent — it is a drag zone, not a button', () => {
    // The original shape of this assertion covered down+up together. It was split when the release
    // audition was added (AUDIO_DESIGN.md §0.2): what must stay true is that a slider never sounds
    // like a BUTTON on press, and never once per pointer-move — one cue per move is exactly the
    // machine-gun §0.1 caught `sfx.ink.tick` being, and a real drag is ~120 moves.
    installAudioSettings({ storage: memStorage() });
    const { scene, input, inner } = buildSettings();
    const sfx = inner.audioSliders[2]!.rect;
    const y = sfx.y + sfx.h / 2;
    input._emitDown(sfx.x + 10, y);
    for (let i = 1; i <= 40; i++) input._emitMove(sfx.x + 10 + i * 3, y);
    expect(bus.cues).toEqual([]);
    scene.destroy();
  });

  it('letting go of the sfx slider auditions the new level exactly once', () => {
    // Without this the SFX slider is a blind control: there is no BGM yet and nothing fires during
    // a drag, so a real-browser drag of 240 pointer-moves measured 0 cues and a 0.0000 bus peak
    // (AUDIO_DESIGN.md §0.2) — the player had no way to hear what they were choosing.
    installAudioSettings({ storage: memStorage() });
    const { scene, input, inner } = buildSettings();
    const sfx = inner.audioSliders[2]!.rect;
    const y = sfx.y + sfx.h / 2;
    input._emitDown(sfx.x + 10, y);
    input._emitMove(sfx.x + sfx.w / 2, y);
    expect(bus.cues).toEqual([]);
    input._emitUp(sfx.x + sfx.w / 2, y);
    expect(bus.cues).toEqual(['sfx.ui.tap']);
    // A pointer-up with no slider held must not audition — otherwise every tap anywhere on the
    // scene would sound twice (once from the hit on down, once from this on up).
    input._emitUp(sfx.x + sfx.w / 2, y);
    expect(bus.cues).toEqual(['sfx.ui.tap']);
    scene.destroy();
  });

  it('the bgm slider stays silent — its channel drives nothing yet', () => {
    // Auditioning an SFX cue for the music slider would be a lie about what the slider controls:
    // setMusicVolume accepts and ignores until §7 step 7 lands.
    installAudioSettings({ storage: memStorage() });
    const { scene, input, inner } = buildSettings();
    const bgm = inner.audioSliders[1]!.rect;
    const y = bgm.y + bgm.h / 2;
    input._emitDown(bgm.x + 10, y);
    input._emitMove(bgm.x + bgm.w / 2, y);
    input._emitUp(bgm.x + bgm.w / 2, y);
    expect(bus.cues).toEqual([]);
    scene.destroy();
  });

  it('the mute toggle flips and persists, and leaves the slider levels alone', () => {
    const store = memStorage();
    installAudioSettings({ storage: store });
    const { scene, input, inner } = buildSettings();
    const mute = inner.hits.find((h) => h.fn.toString().includes('setAudioMuted'));
    expect(mute, 'the volume block registers a mute hit').toBeTruthy();
    const c = centre(mute!.rect);
    input._emitDown(c.x, c.y);
    expect(getAudioSettings().muted).toBe(true);
    expect(JSON.parse(store.data.get(AUDIO_SETTINGS_KEY)!).muted).toBe(true);
    expect(getAudioSettings().sfx).toBe(DEFAULT_AUDIO_SETTINGS.sfx);
    scene.destroy();
  });
});

// ── The outlets that are deliberately NOT hits ────────────────────────────────

describe('sfx.ui.error rides the global toast, not a tap', () => {
  it('an error toast sounds; a success toast does not', () => {
    setToastSink(() => {});
    showToastMessage('nope', 'error');
    expect(bus.cues).toEqual(['sfx.ui.error']);
    bus.cues.length = 0;
    showToastMessage('saved', 'success');
    expect(bus.cues).toEqual([]);
  });
});

describe('gacha reveal is tiered per pull, not per card', () => {
  const e = (rarity: string): never => ({ rarity } as never);
  it('takes the best rarity in the batch', () => {
    expect(revealCue([e('common'), e('common')])).toBe('sfx.ui.gacha.reveal.common');
    expect(revealCue([e('common'), e('rare')])).toBe('sfx.ui.gacha.reveal.rare');
    expect(revealCue([e('rare'), e('epic')])).toBe('sfx.ui.gacha.reveal.epic');
  });
  it('legendary folds into the epic cue — the vocabulary tops out there', () => {
    expect(revealCue([e('common'), e('legendary')])).toBe('sfx.ui.gacha.reveal.epic');
  });
});

// ── Battle: sfx.card.invalid, the cue with no engine event ────────────────────

interface RendererInternals {
  core: {
    handView: { slotCenter(i: number): { x: number; y: number } };
    localPlayer(state: unknown): { ink: number; hand: unknown };
    hudView: {
      isPaused: boolean;
      getSurrenderRect(): Rect;
      getSurrenderCancelRect(): Rect | null;
    };
  };
}

function buildBattle(): {
  renderer: GameRenderer; input: InputManager; inner: RendererInternals;
  state: unknown; layout: ReturnType<typeof createLayout>;
} {
  const level = getLevel('ch1_lv1')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  // Settle the staggered opening deal before hit-testing hand cards (see gameRendererInput.ui.ts).
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);
  return { renderer, input, inner: renderer as unknown as RendererInternals, state: engine.state, layout };
}

describe('sfx.card.invalid (AUDIO_DESIGN §2.1) — the client-side rejections', () => {
  it('pressing a card the player cannot afford squeaks exactly once', () => {
    const { renderer, input, inner, state } = buildBattle();
    // `Player.ink` is a getter, so poverty is faked at the seam the input layer reads it through
    // rather than by writing the field.
    const player = inner.core.localPlayer(state);
    vi.spyOn(inner.core, 'localPlayer').mockReturnValue({ ...player, hand: player.hand, ink: 0 } as never);
    const from = inner.core.handView.slotCenter(0);
    input._emitDown(from.x, from.y);
    input._emitUp(from.x, from.y); // a tap → startTapSelect rejects
    expect(bus.cues).toEqual(['sfx.card.invalid']);
    renderer.destroy();
  });

  it('dropping a unit on a column that is not an attack lane squeaks', () => {
    const { renderer, input, inner, layout } = buildBattle();
    const from = inner.core.handView.slotCenter(2);   // shieldbearer, cost 6, affordable
    const to = layout.gridToScreen(BASE_COLS[0], 1);  // base columns are never an attack lane
    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y);
    input._emitUp(to.x, to.y);
    expect(bus.cues).toContain('sfx.card.invalid');
    renderer.destroy();
  });

  it('an affordable, legal play does NOT squeak — the engine event is what sounds there', () => {
    const { renderer, input, inner, layout } = buildBattle();
    const from = inner.core.handView.slotCenter(2);
    const to = layout.gridToScreen(1, 1);
    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y);
    input._emitUp(to.x, to.y);
    expect(bus.cues).not.toContain('sfx.card.invalid');
    renderer.destroy();
  });
});

describe('battle HUD buttons go through the shared hit table too', () => {
  it('surrender taps, and its Cancel sounds like back', () => {
    const { renderer, input, inner } = buildBattle();
    const hud = inner.core.hudView;
    const s = centre(hud.getSurrenderRect());
    input._emitDown(s.x, s.y);
    expect(bus.cues).toEqual(['sfx.ui.tap']);
    expect(hud.isPaused).toBe(true);

    bus.cues.length = 0;
    const cancel = hud.getSurrenderCancelRect();
    expect(cancel, 'the confirm overlay exposes a cancel rect while paused').toBeTruthy();
    const c = centre(cancel!);
    input._emitDown(c.x, c.y);
    expect(bus.cues).toEqual(['sfx.ui.back']);
    expect(hud.isPaused).toBe(false);
    renderer.destroy();
  });

  it('the locale is wired, so an empty label cannot make the assertions above vacuous', () => {
    expect(t('settings.audio')).toBeTruthy();
  });
});


// ── The PIXI-native tap family (2026-08-31, second pass) ─────────────────────
//
// These buttons never had a hit table: they are display objects with their own `eventMode` +
// `on('pointertap', …)`, and the first pass of §7 step 4 left every one of them silent — including
// all of ResultScene, the screen the player reaches seconds after the victory/defeat stinger.
// `test/uiTapSoundCoverage.test.ts` is the guard that stops that recurring; these are the
// behaviour half, driven through a REAL `PIXI.EventBoundary` hit-test rather than by emitting on a
// node we looked up by name — so a button that moved out from under the pointer, or that a
// backdrop now covers, fails here.

const zeroStats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: 0,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

function tapByName(scene: { container: PIXI.Container }, name: string): void {
  const node = scene.container.getChildByName(name);
  if (!node) throw new Error(`${name} not found`);
  const b = node.getBounds();
  const boundary = new PIXI.EventBoundary(scene.container);
  const hit = boundary.hitTest(b.x + b.width / 2, b.y + b.height / 2);
  if (!hit) throw new Error(`${name} is not reachable by a real hit-test`);
  (hit.emit as (e: string) => void)('pointertap');
}

describe('ResultScene buttons sound (they were silent until 2026-08-31)', () => {
  it('the primary CTA taps and the back chip sounds like back', () => {
    const playAgain = vi.fn();
    const onBack = vi.fn();
    const scene = new ResultScene(
      800, 1280, 0,
      [zeroStats(0), zeroStats(1)],
      { onPlayAgain: playAgain, onBack },
    );

    tapByName(scene, 'resultPrimaryCta');
    expect(playAgain).toHaveBeenCalledTimes(1);
    expect(bus.cues).toEqual(['sfx.ui.tap']);

    bus.cues.length = 0;
    tapByName(scene, 'resultBackChip');
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(bus.cues).toEqual(['sfx.ui.back']);
    scene.destroy();
  });
});

describe('modal dialogs sound (same family, same first-pass miss)', () => {
  it('reconnect prompt: resume taps, decline sounds like back', () => {
    const onReconnect = vi.fn();
    const onDecline = vi.fn();
    const dlg = new ReconnectPromptDialog(800, 1280, { onReconnect, onDecline });

    // No `name` hooks on these two, so reach them the way the guard describes: every pointertap
    // listener the dialog registered, in registration order (resume, then decline).
    const buttons: PIXI.DisplayObject[] = [];
    const visit = (n: PIXI.Container): void => {
      if (n.listenerCount('pointertap') > 0) buttons.push(n);
      for (const c of n.children) visit(c as PIXI.Container);
    };
    visit(dlg.container);
    expect(buttons.length, 'reconnect prompt draws two tappable buttons').toBe(2);

    (buttons[0]!.emit as (e: string) => void)('pointertap');
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(bus.cues).toEqual(['sfx.ui.tap']);

    bus.cues.length = 0;
    (buttons[1]!.emit as (e: string) => void)('pointertap');
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(bus.cues).toEqual(['sfx.ui.back']);
    dlg.destroy();
  });
});


// ── The lobby: a third family, found only on the audit after the second pass ──
//
// LobbyScene routed all eighteen of its buttons through a hand-rolled
// `if (x >= rect.x && …) { …; return; }` chain — no hit table, no PIXI listener, so both scans
// above walked straight past it and the game's HOME SCREEN was silent end to end. The chain is now
// one `Hit[]` + `dispatchHit`; `test/uiTapSoundCoverage.test.ts`'s containment check is the guard.

describe('LobbyScene buttons sound (the home screen was silent until the audit)', () => {
  function buildLobby(): { scene: LobbyScene; input: InputManager; calls: string[] } {
    const calls: string[] = [];
    const input = new InputManager();
    const scene = new LobbyScene(createLayout(800, 1280), input, {
      online: true,
      playerName: 'Tester',
      pvp: { rank: 'bronze', elo: 1000 },
      onStartGame() { calls.push('start'); },
      onStartRanked() { calls.push('ranked'); },
      onOpenCampaign() { calls.push('campaign'); },
      onOpenRoom() { calls.push('room'); },
      onOpenSocial() { calls.push('social'); },
      onOpenShop() { calls.push('shop'); },
      onOpenCards() { calls.push('cards'); },
      onOpenStats() { calls.push('stats'); },
      onOpenProfile() { calls.push('profile'); },
    } as never);
    return { scene, input, calls };
  }

  /** The rects the lobby lays out, read off Core the way its own dispatcher does. */
  function rects(scene: LobbyScene): Record<string, Rect> {
    const core = (scene as unknown as { core: Record<string, Rect> }).core;
    return core;
  }

  it('the profile chip and the campaign button both tap', () => {
    const { scene, input, calls } = buildLobby();
    const core = rects(scene);

    const p = core.profileChipRect;
    input._emitDown(p.x + p.w / 2, p.y + p.h / 2);
    expect(calls).toEqual(['profile']);
    expect(bus.cues).toEqual(['sfx.ui.tap']);

    bus.cues.length = 0;
    const c = core.campaignBtnRect;
    input._emitDown(c.x + c.w / 2, c.y + c.h / 2);
    expect(calls).toEqual(['profile', 'campaign']);
    expect(bus.cues).toEqual(['sfx.ui.tap']);
    scene.destroy();
  });

  it('a tap on empty paper stays silent', () => {
    const { scene, input, calls } = buildLobby();
    input._emitDown(2, 2); // top-left corner, outside every rect the lobby lays out
    expect(calls).toEqual([]);
    expect(bus.cues).toEqual([]);
    scene.destroy();
  });
});

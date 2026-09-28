// SettingsScene's volume section (AUDIO_DESIGN.md §4: three channel volumes + ONE global mute),
// laid out as rows of the flow layout (layout.ts, UI_DESIGN_LOG_2026-09 §65).
//
// The sliders are drag targets, not hits: a hit fires once at a point, while a volume slider has to
// track the finger. They therefore live in their own `audioSliders` list rather than in the shared
// hit table (ui/hits.ts) — the same split CardScene made for its feed-quantity bar.
//
// SettingsScene.handleDown() checks `audioSliders` BEFORE the hit table (and before the page's
// drag-to-scroll), so a slider rect that overlapped a button would silently eat its presses. The
// first placement did exactly that to the "Deutsch" button (AUDIO_DESIGN.md §0.2). In the flow
// layout each slider owns its own row and nothing else is drawn in it, so an overlap can only come
// back through a bug in layout.ts — test/ui/settingsSliderOverlap.ui.ts still asserts it for every
// scene shape.
import { ui as C, txt } from '../../render/sketchUi';
import { t } from '../../i18n';
import { getAudioSettings, setAudioMuted, setAudioVolume } from '../../audio/audioSettings';
import { playSfx } from '../../audio/audioBus';
import * as PIXI from 'pixi.js-legacy';
import type { Rect } from '../../layout/ILayout';
import { section, toggleControl, textW, TYPE, type Column, type Page } from './layout';

/** A live-tracking drag zone. `onDrag` is fed the raw pointer x on press and on every move. */
export interface AudioSlider {
  rect: Rect;
  onDrag: (x: number) => void;
  /**
   * Fired once on pointer-up, if this slider was the one being dragged. Exists so the panel — not
   * the scene — decides whether letting go makes a sound; see the audition note in `drawAudio`.
   */
  onRelease?: () => void;
}

/** What this section needs from SettingsScene beyond the page itself. */
export interface AudioPanelHost {
  /** Re-render at most once per frame (the scene's dirty flag), not once per pointer-move. */
  markAudioDirty(): void;
  render(): void;
}

type Channel = 'master' | 'bgm' | 'sfx';
const CHANNELS: ReadonlyArray<{ id: Channel; key: 'settings.audioMaster' | 'settings.audioBgm' | 'settings.audioSfx' }> = [
  { id: 'master', key: 'settings.audioMaster' },
  { id: 'bgm', key: 'settings.audioBgm' },
  { id: 'sfx', key: 'settings.audioSfx' },
];

export function drawAudio(page: Page, col: Column, host: AudioPanelHost): void {
  const s = getAudioSettings();
  section(page, col, t('settings.audio'), (sec) => {
    // "Sound: On" is the ON state (blue) — the same convention as every other toggle on this page.
    // It used to be a red "Muted" box, which read as an error rather than as a setting.
    sec.row({
      label: t('settings.audioEnabled'),
      control: toggleControl(page, !s.muted, t(s.muted ? 'settings.audioMuteOn' : 'settings.audioMuteOff'), 97,
        () => { setAudioMuted(!s.muted); host.render(); }),
    });

    // Muted greys the sliders out but leaves them draggable: a player who muted, then reaches for a
    // slider, means "unmute me at this level" far more often than "nothing happens".
    const dim = s.muted;
    const names = CHANNELS.map((ch) => txt(t(ch.key), TYPE.hint, dim ? C.mid : C.dark));
    const nameW = Math.max(...names.map((n) => textW(n, TYPE.hint)));
    const knobR = Math.round(page.m.ctrlH * 0.26);
    const trackX = sec.x0 + nameW + page.m.gap + knobR;
    const trackW = sec.x1 - knobR - trackX;
    const rowH = Math.round(page.m.rowMinH * 0.75);

    CHANNELS.forEach((ch, i) => {
      const top = sec.custom(rowH);
      const cy = top + rowH / 2;
      const name = names[i]!;
      name.anchor.set(0, 0.5); name.x = sec.x0; name.y = cy;
      page.add(name);

      const v = s[ch.id];
      const g = new PIXI.Graphics();
      g.beginFill(C.light, dim ? 0.4 : 0.8);
      g.drawRect(trackX, cy - 3, trackW, 6);
      g.endFill();
      g.beginFill(dim ? C.mid : C.accent);
      g.drawRect(trackX, cy - 3, Math.round(trackW * v), 6);
      g.endFill();
      g.beginFill(dim ? C.mid : C.gold);
      g.drawCircle(trackX + trackW * v, cy, knobR);
      g.endFill();
      g.lineStyle(1.6, C.dark, dim ? 0.4 : 1);
      g.drawCircle(trackX + trackW * v, cy, knobR);
      page.add(g);

      page.slider(
        // The whole row, so a finger that misses the 6px track still grabs the slider.
        { x: trackX - knobR, y: top, w: trackW + knobR * 2, h: rowH },
        (px: number) => { setAudioVolume(ch.id, (px - trackX) / trackW); host.markAudioDirty(); },
        // Audition on release, not per move (AUDIO_DESIGN.md §0.2): without it the SFX slider is a
        // blind control, and one cue per pointer-move is a machine gun. `bgm` stays silent — the bed
        // is already audible while the slider is dragged, so a cue would only talk over it.
        ch.id === 'bgm' ? undefined : () => playSfx('sfx.ui.tap'),
      );
    });
  });
}

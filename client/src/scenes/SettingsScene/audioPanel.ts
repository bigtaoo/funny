// SettingsScene's volume block (AUDIO_DESIGN.md §4: three channel volumes + ONE global mute),
// extracted as a free function like the panels beside it (claudedocs/client-modules.md "单文件 500
// 行收敛").
//
// Three sliders + one mute toggle. The sliders are drag targets, not hits: a hit fires once at a
// point, while a volume slider has to track the finger. They therefore live in their own
// `audioSliders` list rather than in the shared hit table (ui/hits.ts) — the same split CardScene
// made for its feed-quantity bar, and the reason ui/hits.ts's `hitTest` is generic over `{ rect }`
// instead of over `Hit`.
//
// ⚠️ Placement is load-bearing, and the first version got it wrong (found by a real-browser
// screenshot, AUDIO_DESIGN.md §0.2). SettingsScene.handleDown() checks `audioSliders` BEFORE the
// hit table, so a slider rect that overlaps a button does not merely sit on top of it — it
// **silently eats** the press: no cue fires (sliders are not hits), the button does not act, and
// the player's volume moves instead. The first version placed the block at x 0.56w / title 0.385h
// on the assumption that the language buttons stay in the left column. They do not: three locales
// at 0.22w + 0.03w gap from 0.12w reach 0.84w, i.e. the language row is a FULL-WIDTH row occupying
// y 0.525h..0.587h. Its third button (Deutsch) therefore lost ~half its area to the third slider.
//
// So the block now sits ABOVE that row, entirely inside the free rectangle bounded by:
//   • the header (~0.11h) above,
//   • the language row (0.525h) below,
//   • the profile block's rename button (left column, x ≤ 0.58w, y ≈ 0.30h..0.37h) to the left —
//     which is why x0 is 0.60w and not 0.56w like drawHelp's column. That button only exists when
//     logged in, so an offline screenshot cannot see this constraint; do not "tidy" x0 back.
// Guarded by test/ui/settingsSliderOverlap.ui.ts, which renders the scene ONLINE (rename button
// present) and fails if any slider rect intersects any hit rect.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { SketchPen } from '../../render/sketch';
import { ui as C } from '../../render/sketchUi';
import { t } from '../../i18n';
import { FS, snapFont } from '../../render/fontScale';
import type { Rect } from '../../layout/ILayout';
import type { Hit } from '../../ui/hits';
import { getAudioSettings, setAudioMuted, setAudioVolume } from '../../audio/audioSettings';
import { playSfx } from '../../audio/audioBus';

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

/** What this panel needs from SettingsScene. */
export interface AudioPanelHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  hits: Hit[];
  audioSliders: AudioSlider[];
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

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return makeText(label, { fontSize: size, fill: color, fontFamily: 'monospace', fontWeight: bold ? 'bold' : 'normal' });
}

export function drawAudio(host: AudioPanelHost): void {
  const { w, h, container } = host;
  const s = getAudioSettings();
  const x0 = Math.round(w * 0.60);
  const titleY = Math.round(h * 0.30);

  const label = txt(t('settings.audio'), FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.x = x0; label.y = titleY;
  container.addChild(label);

  // Mute toggle, right-aligned on the title row — same metrics as the language / data-saver
  // buttons so the three read as one family of control.
  const btnW = Math.round(w * 0.16);
  const btnH = Math.round(h * 0.05);
  const bx = Math.round(w * 0.94) - btnW;
  const by = titleY - Math.round(btnH / 2);
  const box = new PIXI.Graphics();
  box.beginFill(s.muted ? C.red : C.paper);
  box.drawRect(0, 0, btnW, btnH);
  box.endFill();
  new SketchPen(box, 97).rect(2, 2, btnW - 4, btnH - 4, { color: s.muted ? C.gold : C.dark, width: s.muted ? 2.8 : 2, jitter: 1.0 });
  box.x = bx; box.y = by;
  container.addChild(box);
  const btnLbl = txt(t(s.muted ? 'settings.audioMuteOn' : 'settings.audioMuteOff'), snapFont(Math.round(btnH * 0.4)), s.muted ? 0xffffff : C.dark, s.muted);
  btnLbl.anchor.set(0.5, 0.5); btnLbl.x = bx + btnW / 2; btnLbl.y = by + btnH / 2;
  container.addChild(btnLbl);
  host.hits.push({
    rect: { x: bx, y: by, w: btnW, h: btnH },
    fn: () => { setAudioMuted(!s.muted); host.render(); },
  });

  // Sliders. Muted greys the whole block out but leaves it draggable: a player who muted, then
  // reaches for a slider, means "unmute me at this level" far more often than "nothing happens".
  const trackX = x0 + Math.round(w * 0.11);
  const trackW = Math.round(w * 0.94) - trackX;
  const rowGap = Math.round(h * 0.05);
  const knobR = Math.round(h * 0.014);

  CHANNELS.forEach((ch, i) => {
    const cy = titleY + Math.round(h * 0.05) + i * rowGap;
    const dim = s.muted;

    const name = txt(t(ch.key), FS.label, dim ? C.mid : C.dark);
    name.anchor.set(0, 0.5); name.x = x0; name.y = cy;
    container.addChild(name);

    const v = s[ch.id];
    const g = new PIXI.Graphics();
    // Track: a thin hand-drawn rule, filled up to the current value.
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
    container.addChild(g);

    host.audioSliders.push({
      // Vertically generous: the track is 6px of a ~1280px-tall design space, and a finger that
      // misses by 10px must still grab the slider rather than fall through to whatever is behind.
      rect: { x: trackX - knobR, y: cy - rowGap / 2, w: trackW + knobR * 2, h: rowGap },
      onDrag: (px: number) => {
        setAudioVolume(ch.id, (px - trackX) / trackW);
        host.markAudioDirty();
      },
      // Audition on release. Measured in a real browser (AUDIO_DESIGN.md §0.2): dragging a slider
      // produced 0 cues and a bus peak of 0.0000 over 240 pointer-moves — correct, but it also
      // meant the SFX slider was a completely BLIND control. There is no BGM yet and no cue fires
      // during a drag, so a player choosing "0.4" had nothing to compare it against; the volume
      // row of an audio settings screen is the one place in the game where hearing the result is
      // the entire point.
      //
      // On release, not per move: `onDrag` runs on every pointer-move (240 of them in that test),
      // and one cue per move is precisely the machine-gun §0.1 caught `sfx.ink.tick` being.
      //
      // `bgm` stays silent, and **still does now that §7 step 7 has landed** — but the reason
      // changed, so it is restated rather than left to be re-derived. It used to be "the channel
      // drives nothing, so an SFX cue would lie about what the slider controls". Now the channel
      // drives a real bed, and the bed is ALREADY AUDIBLE while the slider is being dragged —
      // `MusicPlayer` picks the new bus volume up on the very next frame. So the audition would be
      // redundant at best, and at worst an SFX cue talking over the thing it is meant to
      // demonstrate. The other two sliders still need it: their channel is silent between cues.
      ...(ch.id === 'bgm' ? {} : { onRelease: () => playSfx('sfx.ui.tap') }),
    });
  });
}

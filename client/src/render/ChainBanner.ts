import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import { drawHudButton, hudButtonText } from '../ui/widgets/hudButton';
import { FS, snapFont } from './fontScale';
import { UI_FONT_FAMILY } from './theme';
import type { ILayout, Rect } from '../layout/ILayout';
import { t } from '../i18n';
import { dispatchHit } from '../ui/hits';

/**
 * What the level-chain banner shows (ONBOARDING_DESIGN §17.3). Built by the campaign nav from the
 * level just cleared and the one coming up; the battle scene only draws it and reports the choice.
 */
export interface ChainBannerSpec {
  /** Stars earned on the level just cleared (0..3); omitted for the tutorial, which has none. */
  stars?: number;
  /** Display name of the level about to start. */
  nextName: string;
  /** Display names of the cards that level adds, if any. */
  newCards?: readonly string[];
  /** The hero-gift line ("yours from tomorrow"), on the gift level's first clear only. */
  giftLine?: string;
  /** Seconds before the next level starts by itself. */
  autoSec: number;
  /** Start the next level now: `auto` = the countdown ran out, else a tap anywhere but the map button. */
  onNext(auto: boolean): void;
  /** Leave the chain for the campaign map. */
  onMap(): void;
}

/** Something that can put the chain banner over a finished battle — the battle scene. */
export interface ChainBannerHost {
  showChainBanner(spec: ChainBannerSpec): void;
}

const PANEL_W = 420;
const BAR_H = 6;
const C_STAR = 0xf2b632;
const C_STAR_OFF = 0x6b6b6b;
const C_NEW = 0xd94a3d;

/**
 * The in-battle "next level" banner: sits under the WIN stamp, counts down, then hands over. One
 * decision fires once — whichever of countdown / tap / map button comes first.
 */
export class ChainBanner {
  readonly container = new PIXI.Container();
  private readonly bar = new PIXI.Graphics();
  private readonly barW: number;
  private readonly mapRect: Rect;
  private readonly panelRect: Rect;
  private elapsed = 0;
  private decided = false;

  constructor(layout: ILayout, private readonly spec: ChainBannerSpec) {
    const cx = layout.designWidth / 2;
    // The HUD's WIN box is 100 tall on the vertical centre; start just below it.
    const top = layout.designHeight / 2 + 66;
    const pad = 14;
    const lines: PIXI.DisplayObject[] = [];
    let y = top + pad;

    const bg = new PIXI.Graphics();
    this.container.addChild(bg);

    if (spec.stars !== undefined) {
      const row = new PIXI.Container();
      const size = snapFont(FS.heading);
      for (let i = 0; i < 3; i++) {
        const s = makeText('★', { fontSize: size, fill: i < spec.stars ? C_STAR : C_STAR_OFF, fontWeight: 'bold' });
        s.anchor.set(0.5, 0);
        s.x = (i - 1) * size * 1.15;
        row.addChild(s);
      }
      row.x = cx; row.y = y;
      lines.push(row);
      y += size + 6;
    }

    const next = makeText(t('chain.next', { name: spec.nextName }), {
      fontSize: snapFont(FS.bodyLg), fill: 0xffffff, fontWeight: 'bold', fontFamily: UI_FONT_FAMILY,
    });
    next.anchor.set(0.5, 0);
    if (next.width > PANEL_W - pad * 2) next.scale.set((PANEL_W - pad * 2) / next.width);
    next.x = cx; next.y = y;
    lines.push(next);
    y += next.height + 6;

    if (spec.newCards && spec.newCards.length > 0) {
      const nc = makeText(`${t('level.newCard.tag')}  ${spec.newCards.join(t('level.newCard.sep'))}`, {
        fontSize: snapFont(FS.body), fill: C_NEW, fontWeight: 'bold', fontFamily: UI_FONT_FAMILY,
      });
      nc.anchor.set(0.5, 0);
      if (nc.width > PANEL_W - pad * 2) nc.scale.set((PANEL_W - pad * 2) / nc.width);
      nc.x = cx; nc.y = y;
      lines.push(nc);
      y += nc.height + 8;
    }

    if (spec.giftLine) {
      const gl = makeText(spec.giftLine, {
        fontSize: snapFont(FS.body), fill: C_STAR, fontWeight: 'bold', fontFamily: UI_FONT_FAMILY,
      });
      gl.anchor.set(0.5, 0);
      if (gl.width > PANEL_W - pad * 2) gl.scale.set((PANEL_W - pad * 2) / gl.width);
      gl.x = cx; gl.y = y;
      lines.push(gl);
      y += gl.height + 8;
    }

    // Countdown bar, then the one button: the map.
    this.barW = PANEL_W - pad * 2;
    this.bar.x = cx - this.barW / 2; this.bar.y = y;
    y += BAR_H + 10;
    const btnH = 40;
    const btnW = 170;
    const btn = new PIXI.Container();
    const bbg = new PIXI.Graphics();
    drawHudButton(bbg, btnW, btnH, 'secondary', { radius: 6 });
    const label = makeText(t('result.backToMap'), {
      fontSize: snapFont(Math.round(btnH * 0.42)), fill: hudButtonText('secondary'), fontWeight: 'bold', fontFamily: UI_FONT_FAMILY,
    });
    label.anchor.set(0.5);
    label.x = btnW / 2; label.y = btnH / 2;
    if (label.width > btnW - 12) label.scale.set((btnW - 12) / label.width);
    btn.addChild(bbg, label);
    btn.x = cx - btnW / 2; btn.y = y;
    this.mapRect = { x: btn.x, y: btn.y, w: btnW, h: btnH };
    y += btnH + pad;

    this.panelRect = { x: cx - PANEL_W / 2, y: top, w: PANEL_W, h: y - top };
    bg.beginFill(0x000000, 0.6);
    bg.drawRoundedRect(this.panelRect.x, this.panelRect.y, this.panelRect.w, this.panelRect.h, 8);
    bg.endFill();
    this.container.addChild(...lines, this.bar, btn);
    this.drawBar(0);
  }

  /** Any tap decides: the map button leaves the chain, anywhere else starts the next level now. */
  handleDown(x: number, y: number): boolean {
    if (this.decided) return true;
    if (!dispatchHit([{ rect: this.mapRect, sound: 'sfx.ui.back', fn: () => this.decide('map') }], x, y)) this.decide('next', false);
    return true;
  }

  update(dt: number): void {
    if (this.decided) return;
    this.elapsed += dt;
    const p = Math.min(1, this.elapsed / this.spec.autoSec);
    this.drawBar(p);
    if (p >= 1) this.decide('next', true);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private decide(which: 'next' | 'map', auto = false): void {
    if (this.decided) return;
    this.decided = true;
    if (which === 'map') this.spec.onMap();
    else this.spec.onNext(auto);
  }

  private drawBar(p: number): void {
    this.bar.clear();
    this.bar.beginFill(0xffffff, 0.2);
    this.bar.drawRect(0, 0, this.barW, BAR_H);
    this.bar.endFill();
    this.bar.beginFill(0xffffff, 0.85);
    this.bar.drawRect(0, 0, this.barW * p, BAR_H);
    this.bar.endFill();
  }
}

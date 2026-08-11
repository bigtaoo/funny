// WorldMap replay panel — this world's recent siege/defense replays, opened from the HUD.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { FS } from '../../../render/fontScale';
import { serverNow } from '../../../net/serverClock';
import { HUD_H } from '../constants';
import type { WorldMapPanelsCore } from './core';

export interface ReplayHandlers {
  openReplayPanel(): void;
  renderReplayPanel(): void;
}

export class ReplayPanel implements ReplayHandlers {
  constructor(private readonly core: WorldMapPanelsCore) {}

  /** Open the replay browser: fetch the recent sieges, then render the list (repaints once the fetch lands). */
  openReplayPanel(): void {
    if (!this.core.ctx.me?.joined) {
      this.core.showToast(t('world.needBase'), C.red);
      return;
    }
    this.core.ctx.replayPanelOpen = true;
    this.core.ctx.infoScrollY = 0;
    this.renderReplayPanel();
    void this.core.ctx.cb.worldApi
      .listSieges(this.core.ctx.cb.worldId)
      .then((rows) => {
        this.core.ctx.sieges = rows;
        if (this.core.ctx.replayPanelOpen) this.renderReplayPanel();
      })
      .catch(() => {
        /* offline — keep whatever is cached */
      });
  }

  /** Render the recent-sieges list as a scrollable modal; each replayable row opens the existing siege replay. */
  renderReplayPanel(): void {
    if (!this.core.ctx.me?.joined) {
      this.core.closeModal();
      return;
    }
    const ml = this.core.ctx.modalLayer;
    tearDownChildren(ml);
    this.core.ctx.modalBtnRects = [];

    const { w, h } = this.core.ctx;
    const pw = Math.min(440, w - 20);
    const ph = Math.min(h * 0.8, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.core.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(12, 12, pw) });
    panel.x = px;
    panel.y = py;
    ml.addChild(panel);

    const title = txt(t('world.replaysTitle'), FS.tiny, C.accent);
    title.anchor.set(0.5, 0);
    title.x = px + pw / 2;
    title.y = py + 10;
    ml.addChild(title);

    const ly = py + 44;
    const bodyBottom = py + ph - 42;
    this.core.ctx.infoScrollRect = null;

    const rows = this.core.ctx.sieges;
    if (rows.length === 0) {
      const empty = txt(t('world.replaysEmpty'), FS.tiny, C.mid);
      empty.x = px + 16;
      empty.y = ly;
      ml.addChild(empty);
    } else {
      const rowH = 40;
      const now = serverNow();
      const listLayer = this.core.beginScrollList(
        px,
        ly,
        pw,
        bodyBottom - ly,
        rows.length * rowH,
        () => this.renderReplayPanel()
      );
      let ry = ly - this.core.ctx.infoScrollY;
      for (const s of rows) {
        if (ry + rowH >= ly && ry <= bodyBottom) {
          const [, sx, sy] = s.tile.split(':');
          const tx = Number(sx),
            ty = Number(sy);
          const roleTxt = s.role === 'attacker' ? t('world.replay.atk') : t('world.replay.def');
          const outTxt =
            s.outcome === 'attacker_win'
              ? t('world.replay.win')
              : s.outcome === 'defender_win'
              ? t('world.replay.loss')
              : t('world.replay.draw');
          // Win/loss is relative to the requester's role: attacker_win is a win for the attacker but a loss for the defender.
          const won = (s.role === 'attacker') === (s.outcome === 'attacker_win');
          const lvlTxt = s.tileLevel ? `Lv.${s.tileLevel}` : '';
          // Coordinate is its own clickable label (jumps the camera to that tile), same pattern as the
          // territory list's territoryJump button / marches list (WorldMapInput.ts) — separate from the
          // rest of the row so its accent color reads as a link without recoloring the win/loss text.
          const coordLbl = txt(`(${sx},${sy})`, FS.tiny, C.accent, true);
          coordLbl.x = px + 14;
          coordLbl.y = ry + 6;
          listLayer.addChild(coordLbl);
          this.core.ctx.modalBtnRects.push({
            rect: { x: coordLbl.x, y: ry, w: coordLbl.width, h: rowH },
            action: () => {
              this.core.ctx.view.centerAt(tx, ty);
              this.core.ctx.view.renderMap();
              this.core.closeModal();
            },
          });
          const restTxt = ` ${lvlTxt}  ${roleTxt}·${outTxt}  ${this.core.agoText(now - s.ts)}`;
          const restLbl = txt(restTxt, FS.tiny, won ? C.dark : C.red);
          restLbl.x = coordLbl.x + coordLbl.width;
          restLbl.y = ry + 6;
          listLayer.addChild(restLbl);
          const btnW = 72;
          if (s.hasReplay) {
            this.core.panelButtonIn(
              listLayer,
              t('world.replaySiege'),
              px + pw - btnW - 14,
              ry + 2,
              btnW,
              28,
              C.accent,
              () => {
                this.core.closeModal();
                this.core.ctx.cb.onReplaySiege(s.siegeId);
              }
            );
          } else {
            const noRep = txt(t('world.replay.none'), FS.micro, C.mid);
            noRep.x = px + pw - btnW - 8;
            noRep.y = ry + 8;
            listLayer.addChild(noRep);
          }
        }
        ry += rowH;
      }
    }

    this.core.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () =>
      this.core.closeModal()
    );
  }
}

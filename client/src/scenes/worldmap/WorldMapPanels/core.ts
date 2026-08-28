// Shared foundation for the WorldMapPanels composition (see ../WorldMapPanels.ts assembly).
//
// WorldMapPanelsCore holds the single `ctx` field (public, so the sibling panel classes below
// can reference `this.core.ctx.*`) + the modal/toast/deploy primitives and the panel chrome
// helpers (panelButton / panelButtonIn / beginScrollList) that every panel draws itself with,
// plus the agoText formatter. Each panel domain (hud / shop / territory / replay) is its own
// independent class in a sibling file, constructed with `core` and composed into the final
// WorldMapPanels facade (2026-08-11: converted from the former `XMixin(Base)` inheritance chain
// — zero cross-domain `this.*` calls, so this was pure file-splitting via a chain, see
// claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { drawScrollIndicator } from '../../../ui/widgets/ScrollIndicator';
import { buildIcon } from '../../../render/icons';
import { FS, snapFont } from '../../../render/fontScale';
import { HUD_H, MARGIN, CONFIRM_H } from '../logic/constants';
import type { WorldMapContext, DeployKind } from '../WorldMapContext';

export class WorldMapPanelsCore {
  constructor(readonly ctx: WorldMapContext) {}

  showModal(
    lines: string[],
    buttons: { label: string; action: () => void; disabled?: boolean }[]
  ): void {
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml);

    const { w, h } = this.ctx;
    // 1.5× the original footprint (600×280 panel, 26/24px text, 56px buttons) — the old fixed
    // size clipped longer confirm copy (e.g. relocate cost text) since lines never wrapped.
    const mw = Math.min(900, w - 32);
    const textPad = 48;
    const textW = mw - textPad * 2;
    const topPad = 42;
    const lineGap = 14;
    const btnH = 84;
    const btnGap = 30;
    const modalMargin = MARGIN * 3;
    const mx = (w - mw) / 2;

    // Wrap into multiple rows once buttons would otherwise be squeezed below a legible width
    // (e.g. the 6-button owned-tile menu: Reinforce/Defense/Watchtower/Relocate/Abandon/✕) —
    // a single row at that count left labels overlapping their neighbors.
    const minBtnW = 150;
    const maxCols = Math.max(1, Math.floor((mw + modalMargin) / (minBtnW + modalMargin)));
    const cols = Math.min(buttons.length, maxCols);
    const rows = Math.ceil(buttons.length / cols);
    const rowGap = 16;

    // Pre-measure wrapped label heights so the panel sizes to content instead of clipping/overlapping.
    const labels = lines.map((line) => {
      const lbl = txt(line, FS.title, C.dark, false, textW);
      lbl.anchor.set(0.5, 0);
      return lbl;
    });
    const textH =
      labels.reduce((sum, lbl) => sum + lbl.height, 0) + lineGap * Math.max(0, labels.length - 1);
    const btnAreaH = btnH * rows + rowGap * (rows - 1);
    const mh = Math.max(CONFIRM_H * 1.5, topPad + textH + btnGap + btnAreaH + btnGap);
    const my = (h - HUD_H - mh) / 2;

    // Dimmer
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx;
    panel.y = my;
    ml.addChild(panel);

    let ly = my + topPad;
    for (const lbl of labels) {
      lbl.x = mx + mw / 2;
      lbl.y = ly;
      ml.addChild(lbl);
      ly += lbl.height + lineGap;
    }

    this.ctx.modalBtnRects = [];
    const btnW = Math.min(300, (mw - modalMargin * (cols + 1)) / cols);
    const btnTop = my + mh - btnAreaH - 30;
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const row = Math.floor(i / cols);
      const rowStart = row * cols;
      const rowCount = Math.min(cols, buttons.length - rowStart);
      const colInRow = i - rowStart;
      const bx =
        mx +
        (mw - (btnW + modalMargin) * rowCount + modalMargin) / 2 +
        colInRow * (btnW + modalMargin);
      const by = btnTop + row * (btnH + rowGap);
      // Disabled buttons (e.g. Occupy on a tile not connected to the player's territory, ADR-039) use the
      // shared pale-grey disabled styling; the action is still registered so tapping it surfaces a toast
      // explaining why, rather than reading as a dead click.
      const disabled = !!btn.disabled;
      const bp = sketchPanel(btnW, btnH, {
        fill: disabled ? C.btnDis : C.dark,
        border: disabled ? C.btnOff : C.accent,
        seed: seedFor(bx, by, btnW),
      });
      bp.x = bx;
      bp.y = by;
      ml.addChild(bp);
      // '✕' cancel buttons render the hand-drawn close glyph instead of the bare dingbat.
      if (btn.label === '✕') {
        const ic = buildIcon('close', 48, C.light);
        ic.x = bx + btnW / 2 - 24;
        ic.y = by + btnH / 2 - 24;
        ml.addChild(ic);
      } else {
        // Word-wrap to the button's own width so long labels (or squeezed columns) never bleed into neighbors.
        const bl = txt(btn.label, FS.title, disabled ? C.mid : C.light, false, btnW - 16);
        bl.anchor.set(0.5, 0.5);
        bl.x = bx + btnW / 2;
        bl.y = by + btnH / 2;
        ml.addChild(bl);
      }
      this.ctx.modalBtnRects.push({ rect: { x: bx, y: by, w: btnW, h: btnH }, action: btn.action });
    }

    // Close on dim
    this.ctx.modalDimRect = { x: 0, y: 0, w: w, h: h };
  }

  closeModal(): void {
    tearDownChildren(this.ctx.modalLayer);
    this.ctx.modalBtnRects = [];
    this.ctx.modalDimRect = null;
    this.ctx.infoScrollRect = null;
    this.ctx.infoScrollRerender = null;
    this.ctx.infoScrollPendingTap = null;
    this.ctx.selectedTile = null;
    this.ctx.territoryPanelOpen = false;
    this.ctx.replayPanelOpen = false;
    this.ctx.shopPanelOpen = false;
    this.ctx.view.renderMap();
  }

  showToast(msg: string, color: number = C.dark): void {
    const tl = this.ctx.toastLayer;
    tearDownChildren(tl);
    const { w, h } = this.ctx;
    // Unified toast box: dark panel + colored border, centered at h*0.8 — matches CityScene.showToast
    // and the global fallback GlobalToast so world-map notices read the same as the rest of the game.
    // (Moved down from h*2/3 on 2026-08-02: that line sat under modal confirm buttons — e.g. the
    // Equipment enhance dialog's own confirm button — and covered them while the toast was visible.)
    const tw = Math.min(w - 40, 720);
    const th = 84;
    const box = sketchPanel(tw, th, {
      fill: C.dark,
      fillAlpha: 0.88,
      border: color,
      width: 1,
      seed: 7,
    });
    box.x = (w - tw) / 2;
    box.y = Math.round(h * 0.8 - th / 2);
    tl.addChild(box);
    const lbl = txt(msg, FS.headline, 0xffffff, false, tw - 48);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = box.x + tw / 2;
    lbl.y = box.y + th / 2;
    tl.addChild(lbl);
    this.ctx.toastTimer = 2500;
  }

  showDeployDialog(tx: number, ty: number, kind: DeployKind): void {
    const me = this.ctx.me;
    if (!me?.joined || !me.mainBaseTile) {
      this.showToast(t('world.needBase'), C.red);
      return;
    }
    const avail = Math.max(0, Math.floor(me.troops ?? 0));
    const kindLabel =
      kind === 'attack'
        ? t('world.actAttack')
        : kind === 'reinforce'
        ? t('world.actReinforce')
        : kind === 'sweep'
        ? t('world.actSweep')
        : t('world.actOccupy');
    const send = (qty: number): void => {
      void this.ctx.net.doMarch(tx, ty, kind, qty);
    };
    this.showModal(
      [t('world.deployTitle').replace('{avail}', String(avail)), `${kindLabel} → (${tx}, ${ty})`],
      [
        { label: t('world.deployQuarter'), action: () => send(Math.floor(avail / 4)) },
        { label: t('world.deployHalf'), action: () => send(Math.floor(avail / 2)) },
        { label: t('world.deployAll'), action: () => send(avail) },
        { label: '✕', action: () => this.closeModal() },
      ]
    );
  }

  panelButton(
    label: string,
    x: number,
    y: number,
    bw: number,
    bh: number,
    fill: number,
    action: () => void,
    fontSize = 11
  ): void {
    const ml = this.ctx.modalLayer;
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x;
    bp.y = y;
    ml.addChild(bp);
    const bl = txt(label, snapFont(fontSize), C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2;
    bl.y = y + bh / 2;
    ml.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  /**
   * `rerender` is required (no default) — the four call sites (hud/shop/territory/replay's own
   * panels) always pass their own re-render closure. There is no cross-domain default to fall
   * back to here: this class has no visibility into which panel is currently open.
   */
  beginScrollList(
    x: number,
    y: number,
    w: number,
    h: number,
    contentH: number,
    rerender: () => void
  ): PIXI.Container {
    this.ctx.infoScrollRect = { x, y, w, h };
    this.ctx.infoMaxScroll = Math.max(0, contentH - h);
    this.ctx.infoScrollY = Math.max(0, Math.min(this.ctx.infoScrollY, this.ctx.infoMaxScroll));
    this.ctx.infoScrollRerender = rerender;
    const ml = this.ctx.modalLayer;
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(x, y, w, h).endFill();
    ml.addChild(mask);
    const layer = new PIXI.Container();
    layer.mask = mask;
    ml.addChild(layer);
    // Position indicator on the list's right edge. Drawn into the modal layer above `layer`
    // so it's never clipped by the mask; renderTerritoryPanel adds the close button after, on top.
    drawScrollIndicator(ml, { x, y, w, h }, this.ctx.infoScrollY, this.ctx.infoMaxScroll);
    return layer;
  }

  /**
   * Like {@link panelButton} but adds into a scroll-list's masked layer instead of the modal layer directly.
   * `disabled` swaps in the shared pale-grey styling (mirrors the tile-action modal's disabled buttons above) —
   * the tap action still fires, so a disabled row can surface an explanatory toast instead of reading as dead.
   */
  panelButtonIn(
    layer: PIXI.Container,
    label: string,
    x: number,
    y: number,
    bw: number,
    bh: number,
    fill: number,
    action: () => void,
    disabled = false
  ): void {
    const bp = sketchPanel(bw, bh, {
      fill: disabled ? C.btnDis : fill,
      border: disabled ? C.btnOff : C.accent,
      seed: seedFor(x, y, bw),
    });
    bp.x = x;
    bp.y = y;
    layer.addChild(bp);
    const bl = txt(label, FS.micro, disabled ? C.mid : C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2;
    bl.y = y + bh / 2;
    layer.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  /** Compact "how long ago" label from a millisecond delta (m/h/d), for battle-report rows. */
  agoText(deltaMs: number): string {
    const min = Math.max(0, Math.floor(deltaMs / 60000));
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  }
}

/**
 * ProfilePopup — a self-contained "view another player's profile" overlay.
 *
 * Tapping an avatar / player slot anywhere (room, in-battle opponent bar,
 * result screen) opens this card: a dimmed full-screen backdrop + a centred
 * card showing the avatar, display name and 9-digit public id (rank optional).
 *
 * It owns its own PIXI interactivity (the same `interactive + pointertap`
 * mechanism ResultScene's buttons use), so it works the same in every scene
 * regardless of whether that scene drives its other input through PIXI
 * interaction or a manual InputManager hit-list. The host scene only needs to:
 *   • add `popup.container` on top of its scene graph, and
 *   • short-circuit its own down-handler while `popup.isOpen` (the popup's dim
 *     backdrop handles the close tap itself).
 *
 * The 9-digit public id is a display-only field — every identity/routing
 * decision still uses the uuid accountId, never publicId.
 */
import * as PIXI from 'pixi.js-legacy';
import { buildAvatar } from './avatar';
import { palette } from './theme';
import { t, type TranslationKey } from '../i18n';

export interface ProfileData {
  /** Display name (nickname). */
  name: string;
  /** 9-digit public id (display only); empty if unknown. */
  publicId: string;
  /** Localized rank key (e.g. 'rank.gold'); omit to hide the rank line. */
  rankKey?: string;
  /** ELO score; shown next to rank when present. */
  elo?: number;
  /** Marks this card as the local player (adds a "you" tag to the name). */
  isSelf?: boolean;
}

export class ProfilePopup {
  readonly container: PIXI.Container;

  private open = false;
  private readonly card: PIXI.Container;

  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {
    this.container = new PIXI.Container();
    this.container.visible = false;

    // Dim backdrop — interactive so a tap outside the card closes the popup and
    // is swallowed (never reaches what's underneath).
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.55);
    dim.drawRect(0, 0, w, h);
    dim.endFill();
    dim.interactive = true;
    dim.cursor = 'default';
    dim.on('pointertap', () => this.hide());
    this.container.addChild(dim);

    this.card = new PIXI.Container();
    // Tapping the card body must NOT close (only the backdrop / close button).
    this.card.interactive = true;
    this.container.addChild(this.card);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Build + reveal the card for `data`. */
  show(data: ProfileData): void {
    this.card.removeChildren();

    const cardW = Math.min(Math.round(this.w * 0.78), 420);
    const cardH = Math.round(Math.min(this.h * 0.5, 360));
    const cardX = (this.w - cardW) / 2;
    const cardY = (this.h - cardH) / 2;

    const bg = new PIXI.Graphics();
    bg.beginFill(palette.paper);
    bg.lineStyle(2.5, palette.pencil);
    bg.drawRoundedRect(0, 0, cardW, cardH, 12);
    bg.endFill();
    this.card.addChild(bg);
    this.card.x = cardX;
    this.card.y = cardY;

    // Title bar.
    const title = new PIXI.Text(t('profile.title'), {
      fontSize: Math.round(cardH * 0.075), fill: palette.pencil,
      fontWeight: 'bold', fontFamily: 'monospace',
    });
    title.anchor.set(0.5, 0);
    title.x = cardW / 2;
    title.y = cardH * 0.06;
    this.card.addChild(title);

    // Avatar.
    const avSize = Math.round(cardH * 0.34);
    const avatar = buildAvatar(avSize, data.name || '?', publicSeed(data.publicId));
    avatar.x = (cardW - avSize) / 2;
    avatar.y = cardH * 0.2;
    this.card.addChild(avatar);

    // Name (+ "you" tag).
    const nameStr = data.name + (data.isSelf ? ' ' + t('profile.you') : '');
    const name = new PIXI.Text(nameStr || '?', {
      fontSize: Math.round(cardH * 0.085), fill: palette.pencil,
      fontWeight: 'bold', fontFamily: 'monospace',
    });
    name.anchor.set(0.5, 0);
    name.x = cardW / 2;
    name.y = cardH * 0.2 + avSize + cardH * 0.04;
    this.card.addChild(name);

    let yBottom = name.y + name.height;

    // Public id line (display-only identifier).
    if (data.publicId) {
      const idLine = new PIXI.Text(`${t('profile.id')}  #${data.publicId}`, {
        fontSize: Math.round(cardH * 0.05), fill: palette.inkBlue, fontFamily: 'monospace',
      });
      idLine.anchor.set(0.5, 0);
      idLine.x = cardW / 2;
      idLine.y = yBottom + cardH * 0.03;
      this.card.addChild(idLine);
      yBottom = idLine.y + idLine.height;
    }

    // Rank / ELO line (optional — only the local player carries this today).
    if (data.rankKey) {
      const rankName = t(('rank.' + data.rankKey.replace(/^rank\./, '')) as TranslationKey);
      const eloPart = data.elo !== undefined ? `  ·  ELO ${data.elo}` : '';
      const rankLine = new PIXI.Text(`${t('profile.rank')}  ${rankName}${eloPart}`, {
        fontSize: Math.round(cardH * 0.05), fill: palette.pencil, fontFamily: 'monospace',
      });
      rankLine.anchor.set(0.5, 0);
      rankLine.x = cardW / 2;
      rankLine.y = yBottom + cardH * 0.025;
      this.card.addChild(rankLine);
    }

    // Close button.
    const bW = Math.round(cardW * 0.5);
    const bH = Math.round(cardH * 0.16);
    const bX = (cardW - bW) / 2;
    const bY = cardH - bH - cardH * 0.07;
    const btn = new PIXI.Graphics();
    btn.beginFill(0x2c2c2a);
    btn.lineStyle(2, palette.pencil);
    btn.drawRoundedRect(0, 0, bW, bH, 8);
    btn.endFill();
    btn.x = bX; btn.y = bY;
    btn.interactive = true;
    btn.cursor = 'pointer';
    btn.on('pointertap', () => this.hide());
    this.card.addChild(btn);

    const btnLabel = new PIXI.Text(t('profile.close'), {
      fontSize: Math.round(bH * 0.42), fill: 0xffffff, fontWeight: 'bold', fontFamily: 'monospace',
    });
    btnLabel.anchor.set(0.5, 0.5);
    btnLabel.x = bX + bW / 2;
    btnLabel.y = bY + bH / 2;
    this.card.addChild(btnLabel);

    this.open = true;
    this.container.visible = true;
  }

  hide(): void {
    this.open = false;
    this.container.visible = false;
    this.card.removeChildren();
  }

  destroy(): void {
    this.container.removeAllListeners();
    this.container.destroy({ children: true });
  }
}

/** Stable doodle seed from the public id digits (falls back to a constant). */
function publicSeed(publicId: string): number {
  let s = 7;
  for (const ch of publicId) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return s || 7;
}

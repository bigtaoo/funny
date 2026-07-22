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
import { makeText } from './pixiText';
import { buildAvatar } from './avatar';
import { palette } from './theme';
import { t, type TranslationKey } from '../i18n';
import { getTitleKeys, formatLadderTitle } from '../game/meta/titles';
import { tearDownChildren } from './sketchUi';
import { snapFont } from './fontScale';
import { drawHudButton, hudButtonText } from './hudButton';

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
  /** Equipped title id (S10); omit or empty to hide the title line. */
  equippedTitle?: string;
  /** Equipped avatar id (composite "<category>:<key>", see render/avatar.ts); omit for the letter-initial fallback. */
  avatarId?: string;
  /** Family (家族) name, if the player is in one; omit to hide the line. */
  familyName?: string;
  /** Sect (帮会/宗门) name, if the player's family is in one; omit to hide the line. */
  sectName?: string;
  /**
   * Optional action buttons rendered above Close (e.g. Send Message / Block from the friends
   * list). Each runs its `fn` then auto-closes the popup. Omit for display-only cards.
   */
  actions?: ProfileAction[];
}

export interface ProfileAction {
  labelKey: TranslationKey;
  fn: () => void;
  /** Render in a warning style (e.g. block / remove). */
  danger?: boolean;
}

export class ProfilePopup {
  readonly container: PIXI.Container;

  private open = false;
  private readonly card: PIXI.Container;

  // Card bounds + button rects in container-space (design space), refreshed on every show() —
  // back the manual hitTest() fallback below.
  private cardX = 0;
  private cardY = 0;
  private cardW = 0;
  private cardH = 0;
  private tapRects: Array<{ x: number; y: number; w: number; h: number; action: () => void }> = [];

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
    dim.eventMode = 'static';
    dim.cursor = 'default';
    dim.on('pointertap', () => this.hide());
    this.container.addChild(dim);

    this.card = new PIXI.Container();
    // Tapping the card body must NOT close (only the backdrop / close button).
    this.card.eventMode = 'static';
    this.container.addChild(this.card);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Build + reveal the card for `data`. */
  show(data: ProfileData): void {
    tearDownChildren(this.card);
    this.tapRects = [];

    // Caps doubled from the original 420×360 (2026-07-20: card read as too small to use comfortably).
    // `cardH` is a *baseline* used to size the avatar/fonts/buttons; the actual card height is
    // computed from the laid-out content below and grows past this when the info lines + action row
    // would otherwise collide with the bottom-anchored buttons (2026-07-22 fix).
    const cardW = Math.min(Math.round(this.w * 0.78), 840);
    const cardH = Math.round(Math.min(this.h * 0.5, 720));
    const cardX = (this.w - cardW) / 2;
    this.cardX = cardX; this.cardW = cardW;

    // Background is drawn last (once the final height is known) but added first to keep it behind
    // all content in the z-order.
    const bg = new PIXI.Graphics();
    this.card.addChild(bg);
    this.card.x = cardX;

    // Title bar.
    const title = makeText(t('profile.title'), {
      fontSize: snapFont(Math.round(cardH * 0.075)), fill: palette.pencil,
      fontWeight: 'bold', fontFamily: 'monospace',
    });
    title.anchor.set(0.5, 0);
    title.x = cardW / 2;
    title.y = cardH * 0.06;
    this.card.addChild(title);

    // Avatar.
    const avSize = Math.round(cardH * 0.34);
    const avatar = buildAvatar(avSize, data.name || '?', publicSeed(data.publicId), data.avatarId);
    avatar.x = (cardW - avSize) / 2;
    avatar.y = cardH * 0.2;
    this.card.addChild(avatar);

    // Name (+ "you" tag).
    const nameStr = data.name + (data.isSelf ? ' ' + t('profile.you') : '');
    const name = makeText(nameStr || '?', {
      fontSize: snapFont(Math.round(cardH * 0.085)), fill: palette.pencil,
      fontWeight: 'bold', fontFamily: 'monospace',
    });
    name.anchor.set(0.5, 0);
    name.x = cardW / 2;
    name.y = cardH * 0.2 + avSize + cardH * 0.04;
    this.card.addChild(name);

    let yBottom = name.y + name.height;

    // Public id line (display-only identifier) — tap to copy to clipboard.
    if (data.publicId) {
      const idText = `${t('profile.id')}  #${data.publicId}`;
      const idLine = makeText(idText, {
        fontSize: snapFont(Math.round(cardH * 0.05)), fill: palette.inkBlue, fontFamily: 'monospace',
      });
      idLine.anchor.set(0.5, 0);
      idLine.x = cardW / 2;
      idLine.y = yBottom + cardH * 0.03;
      idLine.eventMode = 'static';
      idLine.cursor = 'pointer';
      idLine.on('pointertap', () => this.copyId(idLine, data.publicId, idText));
      this.card.addChild(idLine);
      yBottom = idLine.y + idLine.height;
    }

    // Equipped title line (S10 — optional).
    if (data.equippedTitle) {
      const keys = getTitleKeys(data.equippedTitle);
      const titleLabel = keys
        ? t(keys.shortKey as TranslationKey) || formatLadderTitle(data.equippedTitle)
        : formatLadderTitle(data.equippedTitle);
      const titleLine = makeText(`「${titleLabel}」`, {
        fontSize: snapFont(Math.round(cardH * 0.048)), fill: palette.inkBlue,
        fontFamily: 'monospace',
      });
      titleLine.anchor.set(0.5, 0);
      titleLine.x = cardW / 2;
      titleLine.y = yBottom + cardH * 0.025;
      this.card.addChild(titleLine);
      yBottom = titleLine.y + titleLine.height;
    }

    // Rank / ELO line (optional).
    if (data.rankKey) {
      const rankName = t(('rank.' + data.rankKey.replace(/^rank\./, '')) as TranslationKey);
      const eloPart = data.elo !== undefined ? `  ·  ELO ${data.elo}` : '';
      const rankLine = makeText(`${t('profile.rank')}  ${rankName}${eloPart}`, {
        fontSize: snapFont(Math.round(cardH * 0.05)), fill: palette.pencil, fontFamily: 'monospace',
      });
      rankLine.anchor.set(0.5, 0);
      rankLine.x = cardW / 2;
      rankLine.y = yBottom + cardH * 0.025;
      this.card.addChild(rankLine);
      yBottom = rankLine.y + rankLine.height;
    }

    // Family (家族) / sect (帮会) line (optional — either or both may be present).
    if (data.familyName || data.sectName) {
      const parts: string[] = [];
      if (data.familyName) parts.push(`${t('profile.family')} ${data.familyName}`);
      if (data.sectName) parts.push(`${t('profile.sect')} ${data.sectName}`);
      const orgLine = makeText(parts.join('   '), {
        fontSize: snapFont(Math.round(cardH * 0.05)), fill: palette.pencil, fontFamily: 'monospace',
      });
      orgLine.anchor.set(0.5, 0);
      orgLine.x = cardW / 2;
      orgLine.y = yBottom + cardH * 0.025;
      this.card.addChild(orgLine);
    }

    // ── Buttons, laid out flowing *below* the content (never bottom-anchored, which used to make
    // the action row overlap the name/id lines on a short card). Optional action row (Send Message /
    // Block) sits first, then the Close button; the card height grows to fit whatever is below.
    const bH = Math.round(cardH * 0.16);
    const gapY = Math.round(cardH * 0.05);
    const bottomPad = Math.round(cardH * 0.07);

    let cursorY = yBottom + gapY;

    // Optional action row (Send Message / Block).
    const actions = data.actions ?? [];
    if (actions.length > 0) {
      const gap = Math.round(cardW * 0.04);
      const aW = Math.round((cardW * 0.84 - gap * (actions.length - 1)) / actions.length);
      const aH = bH;
      const aY = cursorY;
      const aX0 = (cardW - (aW * actions.length + gap * (actions.length - 1))) / 2;
      actions.forEach((act, i) => {
        const ax = aX0 + i * (aW + gap);
        const actVariant = act.danger ? 'danger' : 'secondary';
        const ab = new PIXI.Graphics();
        drawHudButton(ab, aW, aH, actVariant, { radius: 8 });
        ab.x = ax; ab.y = aY;
        ab.eventMode = 'static';
        ab.cursor = 'pointer';
        ab.on('pointertap', () => { this.hide(); act.fn(); });
        this.card.addChild(ab);
        const al = makeText(t(act.labelKey), {
          fontSize: snapFont(Math.round(aH * 0.4)), fill: hudButtonText(actVariant),
          fontWeight: 'bold', fontFamily: 'monospace',
        });
        al.anchor.set(0.5, 0.5);
        al.x = ax + aW / 2; al.y = aY + aH / 2;
        this.card.addChild(al);
        // y is card-local here; offset to container space once the final cardY is known below.
        this.tapRects.push({ x: cardX + ax, y: aY, w: aW, h: aH, action: () => { this.hide(); act.fn(); } });
      });
      cursorY = aY + aH + gapY;
    }

    // Close button.
    const bW = Math.round(cardW * 0.5);
    const bX = (cardW - bW) / 2;
    const bY = cursorY;
    const btn = new PIXI.Graphics();
    drawHudButton(btn, bW, bH, 'primary', { radius: 8 });
    btn.x = bX; btn.y = bY;
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointertap', () => this.hide());
    this.card.addChild(btn);

    const btnLabel = makeText(t('profile.close'), {
      fontSize: snapFont(Math.round(bH * 0.42)), fill: hudButtonText('primary'), fontWeight: 'bold', fontFamily: 'monospace',
    });
    btnLabel.anchor.set(0.5, 0.5);
    btnLabel.x = bX + bW / 2;
    btnLabel.y = bY + bH / 2;
    this.card.addChild(btnLabel);

    // Final height = the baseline, or taller when the content flow ran past it. Then draw the bg,
    // centre the card vertically, and register the close tap-rect in the now-final card space.
    const finalH = Math.max(cardH, bY + bH + bottomPad);
    const cardY = Math.round((this.h - finalH) / 2);
    this.cardY = cardY; this.cardH = finalH;
    this.card.y = cardY;

    bg.beginFill(palette.paper);
    bg.lineStyle(2.5, palette.pencil);
    bg.drawRoundedRect(0, 0, cardW, finalH, 12);
    bg.endFill();

    this.tapRects.push({ x: cardX + bX, y: bY, w: bW, h: bH, action: () => this.hide() });
    // Action + close rects were registered in card-local y; shift them into container space.
    for (const r of this.tapRects) r.y += cardY;

    this.open = true;
    this.container.visible = true;
  }

  /**
   * Manual hit-test fallback for host scenes whose input runs through a custom InputManager
   * instead of genuine PIXI pointer events (FamilyScene, FriendsScene, GameRenderer, RoomScene —
   * they all swallow their own manual hit-testing while `isOpen` and rely on this popup's own
   * `eventMode`/`pointertap` wiring above to handle the close/action taps). Call this from the
   * host's own pointer-up handling as a guaranteed-working second path; safe to call even when the
   * native PIXI events also fire for the same tap — whichever runs first flips `open`/`visible` to
   * false, so the second one is always a no-op (checked fresh via `this.open`, not a cached copy).
   * Returns true whenever the popup was open (the caller should always swallow the tap in that case).
   */
  handleTap(x: number, y: number): boolean {
    if (!this.open) return false;
    for (const r of this.tapRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { r.action(); return true; }
    }
    const insideCard = x >= this.cardX && x <= this.cardX + this.cardW && y >= this.cardY && y <= this.cardY + this.cardH;
    if (!insideCard) this.hide();
    return true;
  }

  /** Copy the public id to clipboard and briefly swap the line's text to confirm. */
  private copyId(idLine: PIXI.Text, publicId: string, originalText: string): void {
    try {
      void (navigator as Navigator | undefined)?.clipboard?.writeText(publicId);
      idLine.text = t('profile.copied');
      setTimeout(() => { if (!idLine.destroyed) idLine.text = originalText; }, 1200);
    } catch { /* clipboard unavailable — ignore */ }
  }

  hide(): void {
    this.open = false;
    this.container.visible = false;
    this.tapRects = [];
    tearDownChildren(this.card);
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

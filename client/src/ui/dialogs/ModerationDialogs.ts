/**
 * The three player-safety dialogs (App Review Guideline 1.2, see ui/moderation.ts):
 *
 *  * {@link ReportDialog} — "Report <name>": pick a category, one tap sends it. The message the
 *    report came from (if any) is quoted so the player sees what goes to the team.
 *  * {@link BlockConfirmDialog} — "Block <name>?" with what blocking does, then Block / Cancel.
 *  * {@link BlockedPlayersDialog} — the blocked list with an Unblock button per row (paged, so it
 *    needs no scroll gesture of its own on a stage-level overlay).
 *
 * All three are drawn in DESIGN space (the host, ui/dialogs/moderationHost.ts, mounts them under a
 * container carrying `gameLayer`'s transform), so their proportions and font floor match the
 * ProfilePopup the flow usually starts from. Taps arrive two ways, like ProfilePopup's: their own
 * PIXI `pointertap`s, and {@link ModerationCard.handleTap} fed by the host from the InputManager's
 * modal-tap channel (the guaranteed path — the design-space container is transformed, and the DOM-
 * fed InputManager is what every scene actually trusts). A short same-button debounce keeps a tap
 * that arrives on both paths from firing twice. The host raises `input.holdForModal` for their
 * lifetime so the scene underneath never sees them.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText, monospaceWidth } from '../../render/pixiText';
import { palette } from '../../render/theme';
import { snapFont, fitFont } from '../../render/fontScale';
import { tearDownChildren } from '../../render/sketchUi';
import { drawHudButton, hudButtonText, type HudButtonVariant } from '../widgets/hudButton';
import { fitToWidth } from '../widgets/truncateText';
import { tapHandler, runHit, inRect, type Hit } from '../hits';
import { t, type TranslationKey } from '../../i18n/index';
import type { BlockedUserView } from '../../net/ApiClient/social';
import { REPORT_CATEGORIES, type ModerationTarget, type ReportCategory } from '../moderation';

/**
 * Shared card geometry — ProfilePopup's caps, with a slightly larger landscape unit: these cards are
 * text-heavy (the report reason, the block explanation) and read too small at the popup's h * 0.5
 * on a landscape phone (checked in Chrome, 2026-09-29). Portrait is still capped at 720.
 */
function cardMetrics(w: number, h: number): { cardW: number; unit: number } {
  return {
    cardW: Math.min(Math.round(w * 0.86), 900),
    unit: Math.round(Math.min(h * 0.62, 720)),
  };
}

/** Base: dim backdrop + a card whose height follows its content, re-laid-out on every render(). */
abstract class ModerationCard {
  readonly container = new PIXI.Container();
  protected readonly card = new PIXI.Container();
  protected dead = false;
  /** Button rects in CARD-local space (the card is re-centred after each layout pass). */
  private taps: Hit[] = [];
  /** When the last button action ran, so a tap delivered by both input paths runs once. */
  private lastFireAt = -Infinity;

  constructor(protected readonly w: number, protected readonly h: number, name: string) {
    // Layout sweep: this subtree legitimately sits on top of another screen (see FeedbackDialog).
    this.container.name = `overlay:${name}`;
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.addChild(dim);
    this.card.eventMode = 'static';
    this.container.addChild(this.card);
  }

  destroy(): void {
    this.dead = true;
    this.container.removeAllListeners();
    tearDownChildren(this.card);
    this.container.destroy({ children: true });
  }

  /** Rebuild the card; `draw` lays content out from y=0 in card space and returns the final height. */
  protected render(draw: (cardW: number, unit: number) => number): void {
    if (this.dead) return;
    const { cardW } = cardMetrics(this.w, this.h);
    let { unit } = cardMetrics(this.w, this.h);
    let height = 0;
    // Two passes at most: if the content runs past the screen, shrink the unit once to fit.
    for (let pass = 0; pass < 2; pass++) {
      tearDownChildren(this.card);
      this.taps = [];
      const bg = new PIXI.Graphics();
      this.card.addChild(bg);
      height = draw(cardW, unit);
      const maxH = this.h * 0.94;
      if (height <= maxH || pass === 1) {
        bg.beginFill(palette.paper);
        bg.lineStyle(2.5, palette.pencil);
        bg.drawRoundedRect(0, 0, cardW, height, 12);
        bg.endFill();
        break;
      }
      unit = Math.floor(unit * (maxH / height));
    }
    this.card.x = Math.round((this.w - cardW) / 2);
    this.card.y = Math.round((this.h - height) / 2);
  }

  /**
   * Manual hit-test in design space (the host feeds InputManager modal taps here). A tap inside the
   * card but on no button is swallowed; one outside the card does nothing — these dialogs close only
   * through their own Cancel / Close buttons.
   */
  handleTap(x: number, y: number): void {
    if (this.dead) return;
    const lx = x - this.card.x;
    const ly = y - this.card.y;
    const hit = this.taps.find((h) => inRect(lx, ly, h.rect));
    if (hit) runHit(hit);
  }

  /**
   * Run `fn` unless a button action already ran a moment ago: one physical tap can arrive on both
   * input paths, and the first may already have re-laid the card out (new closures), so this keys
   * on time rather than on which button — nobody taps two different buttons within 250 ms.
   */
  private fire(fn: () => void): void {
    const now = Date.now();
    if (now - this.lastFireAt < 250) return;
    this.lastFireAt = now;
    fn();
  }

  /** Centered wrapped text at `y`; returns its bottom. */
  protected text(label: string, y: number, cardW: number, size: number, color: number, bold = false): number {
    const node = makeText(label, {
      fontSize: size, fill: color, fontFamily: 'monospace', fontWeight: bold ? 'bold' : 'normal',
      wordWrap: true, wordWrapWidth: cardW * 0.86, breakWords: true, align: 'center',
    });
    node.anchor.set(0.5, 0);
    node.x = cardW / 2; node.y = y;
    this.card.addChild(node);
    return y + node.height;
  }

  /** Title line, shrunk to fit the card width rather than wrapped. */
  protected title(label: string, y: number, cardW: number, unit: number): number {
    const size = snapFont(Math.round(unit * 0.07));
    const fitted = fitFont(size, monospaceWidth(label, size), cardW * 0.86);
    return this.text(fitToWidth(label, fitted, cardW * 0.86, true), y, cardW, fitted, palette.pencil, true);
  }

  /**
   * A HUD button with a centred label. The label shrinks to fit; past the font floor it is cut with
   * an ellipsis, unless `wrap` is set — then it breaks onto a second line instead (the report
   * categories: "Harassment / bullying" on a landscape phone was cut to "Harassment / bullyi…").
   */
  protected button(
    label: string, x: number, y: number, bw: number, bh: number, variant: HudButtonVariant, onTap: (() => void) | null,
    wrap = false,
  ): void {
    const g = new PIXI.Graphics();
    drawHudButton(g, bw, bh, onTap ? variant : 'disabled', { radius: 8 });
    g.x = x; g.y = y;
    if (onTap) {
      const sound = variant === 'secondary' ? 'sfx.ui.back' as const : undefined;
      const guarded = (): void => this.fire(onTap);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.on('pointertap', tapHandler(guarded, sound));
      this.taps.push({ rect: { x, y, w: bw, h: bh }, fn: guarded, ...(sound ? { sound } : {}) });
    }
    this.card.addChild(g);
    const size = snapFont(Math.round(bh * 0.38));
    const fitted = fitFont(size, monospaceWidth(label, size), bw * 0.9);
    const style = { fontSize: fitted, fill: hudButtonText(onTap ? variant : 'disabled'), fontWeight: 'bold' as const, fontFamily: 'monospace' };
    // Decided on the MEASURED width (fitToWidth), not the monospace estimate: iOS resolves
    // 'monospace' to Menlo (~0.6 em bold) where the estimate assumes 0.54 em, so only a real
    // measurement sees the overflow.
    const single = fitToWidth(label, fitted, bw * 0.92, true);
    const lbl = wrap && single !== label
      ? makeText(label, { ...style, wordWrap: true, wordWrapWidth: bw * 0.92, breakWords: true, align: 'center', lineHeight: Math.round(fitted * 1.15) })
      : makeText(single, style);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = x + bw / 2; lbl.y = y + bh / 2;
    this.card.addChild(lbl);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface ReportDialogCallbacks {
  /** Send the report; the dialog closes on resolve and says so inline on reject. */
  onSubmit(category: ReportCategory): Promise<void>;
  onClose(): void;
}

const CATEGORY_KEY: Record<ReportCategory, TranslationKey> = {
  harassment: 'moderation.cat.harassment',
  hate: 'moderation.cat.hate',
  sexual: 'moderation.cat.sexual',
  spam: 'moderation.cat.spam',
  cheating: 'moderation.cat.cheating',
  offensive_name: 'moderation.cat.offensiveName',
  other: 'moderation.cat.other',
};

/** Longest quoted message shown in the dialog (the full snapshot still goes to the server). */
const QUOTE_MAX = 90;

export class ReportDialog extends ModerationCard {
  private sending: ReportCategory | null = null;
  private failed = false;

  constructor(w: number, h: number, private readonly target: ModerationTarget, private readonly cb: ReportDialogCallbacks) {
    super(w, h, 'report');
    this.draw();
  }

  private async pick(category: ReportCategory): Promise<void> {
    if (this.sending) return;
    this.sending = category;
    this.failed = false;
    this.draw();
    try {
      await this.cb.onSubmit(category);
      this.cb.onClose();
    } catch {
      this.sending = null;
      this.failed = true;
      this.draw();
    }
  }

  private draw(): void {
    this.render((cardW, unit) => {
      const pad = Math.round(unit * 0.06);
      let y = pad;
      y = this.title(t('moderation.reportTitle', { name: this.target.name }), y, cardW, unit) + Math.round(unit * 0.03);
      y = this.text(t('moderation.reportBody'), y, cardW, snapFont(Math.round(unit * 0.042)), palette.pencil);
      const quoted = this.target.content?.text;
      if (quoted) {
        const q = quoted.length > QUOTE_MAX ? `${quoted.slice(0, QUOTE_MAX)}…` : quoted;
        y = this.text(`“${q}”`, y + Math.round(unit * 0.025), cardW, snapFont(Math.round(unit * 0.038)), palette.inkBlue);
      }
      y += Math.round(unit * 0.045);

      // Category grid: two columns on a portrait card, three when the card is wide.
      const cols = cardW / unit > 1.5 ? 3 : 2;
      const gap = Math.round(cardW * 0.03);
      const innerW = Math.round(cardW * 0.88);
      const bw = Math.floor((innerW - gap * (cols - 1)) / cols);
      const bh = Math.round(unit * 0.12);
      const x0 = Math.round((cardW - innerW) / 2);
      REPORT_CATEGORIES.forEach((cat, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const label = this.sending === cat ? t('moderation.sending') : t(CATEGORY_KEY[cat]);
        this.button(label, x0 + col * (bw + gap), y + row * (bh + gap), bw, bh, 'danger',
          this.sending ? null : () => void this.pick(cat), true);
      });
      y += Math.ceil(REPORT_CATEGORIES.length / cols) * (bh + gap) - gap;

      if (this.failed) {
        y = this.text(t('moderation.reportFailed'), y + Math.round(unit * 0.03), cardW, snapFont(Math.round(unit * 0.04)), palette.inkRed);
      }

      y += Math.round(unit * 0.05);
      const cw = Math.round(cardW * 0.5);
      this.button(t('moderation.cancel'), Math.round((cardW - cw) / 2), y, cw, bh, 'secondary', () => this.cb.onClose());
      return y + bh + pad;
    });
  }
}

// ── Block confirm ─────────────────────────────────────────────────────────────

export interface BlockConfirmCallbacks {
  onConfirm(): void;
  onClose(): void;
}

export class BlockConfirmDialog extends ModerationCard {
  constructor(w: number, h: number, private readonly target: ModerationTarget, private readonly cb: BlockConfirmCallbacks) {
    super(w, h, 'block');
    this.render((cardW, unit) => {
      const pad = Math.round(unit * 0.07);
      let y = pad;
      y = this.title(t('moderation.blockTitle', { name: this.target.name }), y, cardW, unit) + Math.round(unit * 0.04);
      y = this.text(t('moderation.blockBody'), y, cardW, snapFont(Math.round(unit * 0.045)), palette.pencil);
      y += Math.round(unit * 0.07);
      const gap = Math.round(cardW * 0.04);
      const bw = Math.round((cardW * 0.8 - gap) / 2);
      const bh = Math.round(unit * 0.13);
      const x0 = Math.round((cardW - (bw * 2 + gap)) / 2);
      this.button(t('moderation.blockConfirm'), x0, y, bw, bh, 'danger', () => this.cb.onConfirm());
      this.button(t('moderation.cancel'), x0 + bw + gap, y, bw, bh, 'secondary', () => this.cb.onClose());
      return y + bh + pad;
    });
  }
}

// ── Blocked players list ──────────────────────────────────────────────────────

export interface BlockedPlayersCallbacks {
  /** Current list (server-refreshed by the host on open, see ui/moderation.ts reloadBlockedPlayers). */
  load(): Promise<BlockedUserView[]>;
  /** Unblock one player; rejects on failure. */
  onUnblock(p: BlockedUserView): Promise<void>;
  onClose(): void;
}

export class BlockedPlayersDialog extends ModerationCard {
  private list: BlockedUserView[];
  private loading = true;
  private loadFailed = false;
  private page = 0;
  private readonly busy = new Set<string>();

  constructor(w: number, h: number, initial: BlockedUserView[], private readonly cb: BlockedPlayersCallbacks) {
    super(w, h, 'blocked');
    this.list = initial;
    this.draw();
    void cb.load().then(
      (l) => { this.list = l; this.loading = false; this.draw(); },
      () => { this.loading = false; this.loadFailed = true; this.draw(); },
    );
  }

  private perPage(): number {
    return this.w > this.h ? 4 : 6;
  }

  private async unblock(p: BlockedUserView): Promise<void> {
    if (this.busy.has(p.publicId)) return;
    this.busy.add(p.publicId);
    this.draw();
    try {
      await this.cb.onUnblock(p);
      this.list = this.list.filter((x) => x.publicId !== p.publicId);
    } catch { /* host toasts; the row stays */ }
    this.busy.delete(p.publicId);
    this.draw();
  }

  private draw(): void {
    this.render((cardW, unit) => {
      const pad = Math.round(unit * 0.06);
      let y = pad;
      y = this.title(t('moderation.blockedTitle'), y, cardW, unit) + Math.round(unit * 0.04);
      const per = this.perPage();
      const pages = Math.max(1, Math.ceil(this.list.length / per));
      this.page = Math.min(this.page, pages - 1);
      const rowH = Math.round(unit * 0.13);
      const rowGap = Math.round(unit * 0.02);
      const innerW = Math.round(cardW * 0.88);
      const x0 = Math.round((cardW - innerW) / 2);

      if (this.list.length === 0) {
        const key: TranslationKey = this.loading ? 'moderation.loading' : this.loadFailed ? 'moderation.loadFailed' : 'moderation.blockedEmpty';
        y = this.text(t(key), y + Math.round(unit * 0.04), cardW, snapFont(Math.round(unit * 0.045)), palette.pencil);
        y += Math.round(unit * 0.04);
      } else {
        const rows = this.list.slice(this.page * per, this.page * per + per);
        const btnW = Math.round(innerW * 0.34);
        const nameSize = snapFont(Math.round(rowH * 0.34));
        const idSize = snapFont(Math.round(rowH * 0.24));
        for (const p of rows) {
          const line = new PIXI.Graphics();
          line.lineStyle(1.5, palette.pencil, 0.25);
          line.moveTo(x0, y + rowH + rowGap / 2).lineTo(x0 + innerW, y + rowH + rowGap / 2);
          this.card.addChild(line);
          const textW = innerW - btnW - Math.round(innerW * 0.04);
          const name = makeText(fitToWidth(p.displayName || `#${p.publicId}`, nameSize, textW, true), {
            fontSize: nameSize, fill: palette.pencil, fontWeight: 'bold', fontFamily: 'monospace',
          });
          name.x = x0; name.y = y + Math.round(rowH * 0.1);
          this.card.addChild(name);
          const id = makeText(`#${p.publicId}`, { fontSize: idSize, fill: palette.inkBlue, fontFamily: 'monospace' });
          id.x = x0; id.y = name.y + name.height;
          this.card.addChild(id);
          const busy = this.busy.has(p.publicId);
          this.button(busy ? t('moderation.sending') : t('moderation.unblock'), x0 + innerW - btnW, y + Math.round(rowH * 0.12),
            btnW, Math.round(rowH * 0.76), 'accent', busy ? null : () => void this.unblock(p));
          y += rowH + rowGap;
        }
        if (pages > 1) {
          const nbW = Math.round(innerW * 0.26);
          const nbH = Math.round(unit * 0.1);
          y += Math.round(unit * 0.02);
          this.button('<', x0, y, nbW, nbH, 'secondary', this.page > 0 ? () => { this.page--; this.draw(); } : null);
          const pl = makeText(`${this.page + 1} / ${pages}`, { fontSize: snapFont(Math.round(nbH * 0.4)), fill: palette.pencil, fontFamily: 'monospace' });
          pl.anchor.set(0.5, 0.5); pl.x = cardW / 2; pl.y = y + nbH / 2;
          this.card.addChild(pl);
          this.button('>', x0 + innerW - nbW, y, nbW, nbH, 'secondary', this.page < pages - 1 ? () => { this.page++; this.draw(); } : null);
          y += nbH;
        }
      }

      y += Math.round(unit * 0.05);
      const bh = Math.round(unit * 0.12);
      const cw = Math.round(cardW * 0.5);
      this.button(t('moderation.close'), Math.round((cardW - cw) / 2), y, cw, bh, 'primary', () => this.cb.onClose());
      return y + bh + pad;
    });
  }
}

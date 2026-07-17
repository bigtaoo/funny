import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import { ILayout } from '../layout/ILayout';
import { t } from '../i18n';
import { FS } from './fontScale';

/**
 * NetStatusView — thin in-battle network feedback layer (S1-9, UI_DESIGN §5).
 *
 * Lockstep play stalls the engine whenever the confirmed frame stream runs dry
 * (waiting for the opponent's commands, our socket reconnecting, or the peer
 * dropped). Without feedback the frozen board reads as "the game crashed". This
 * overlay shows a small top-center pill with an animated spinner so the player
 * knows it's the network, not a hang.
 *
 * Purely visual + non-interactive; it never swallows input. GameRenderer owns
 * one instance, feeds it state each frame (waiting) and on events (reconnect /
 * peer_dc), and adds its container at the very top of the scene graph.
 *
 * Display priority (most severe wins): peerDc > reconnecting > waiting.
 */
type StatusKind = 'none' | 'waiting' | 'reconnecting' | 'peerDc';

const DOT_PERIOD = 0.45; // seconds per animated dot step

export class NetStatusView {
  readonly container: PIXI.Container;

  private readonly layout: ILayout;
  private readonly pill: PIXI.Graphics;
  private readonly label: PIXI.Text;

  private waiting       = false;
  private reconnecting  = false;
  private peerDc        = false;

  private shownKind: StatusKind = 'none';
  private animTime    = 0;

  constructor(layout: ILayout) {
    this.layout    = layout;
    this.container = new PIXI.Container();
    this.container.interactiveChildren = false;
    this.container.visible = false;

    this.pill = new PIXI.Graphics();
    this.label = makeText('', {
      fontSize: FS.label, fill: 0xffffff, fontWeight: 'bold', fontFamily: 'monospace',
    });
    this.label.anchor.set(0.5);
    this.container.addChild(this.pill, this.label);
  }

  // ── State inputs ───────────────────────────────────────────────────────────

  /** Engine stalled waiting for the next confirmed frame (set every frame). */
  setWaiting(v: boolean): void {
    if (this.waiting === v) return;
    this.waiting = v;
    this.refresh();
  }

  /** Our own socket is down and retrying (NetState 'reconnecting'). */
  setReconnecting(v: boolean): void {
    if (this.reconnecting === v) return;
    this.reconnecting = v;
    this.refresh();
  }

  /** The opponent dropped; server is holding a grace window. */
  setPeerDc(v: boolean): void {
    if (this.peerDc === v) return;
    this.peerDc = v;
    this.refresh();
  }

  /** Clear everything (match ended). */
  clear(): void {
    this.waiting = this.reconnecting = this.peerDc = false;
    this.refresh();
  }

  // ── Per-frame animation ──────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.shownKind === 'none') return;
    this.animTime += dt;
    const dots = 1 + (Math.floor(this.animTime / DOT_PERIOD) % 3); // 1..3
    this.label.text = this.baseText(this.shownKind) + '.'.repeat(dots);
    this.layoutPill();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private currentKind(): StatusKind {
    if (this.peerDc)       return 'peerDc';
    if (this.reconnecting) return 'reconnecting';
    if (this.waiting)      return 'waiting';
    return 'none';
  }

  private refresh(): void {
    const kind = this.currentKind();
    if (kind === this.shownKind) return;
    this.shownKind = kind;
    if (kind === 'none') {
      this.container.visible = false;
      return;
    }
    this.animTime = 0;
    this.label.text = this.baseText(kind) + '.';
    this.container.visible = true;
    this.layoutPill();
  }

  private baseText(kind: StatusKind): string {
    switch (kind) {
      case 'peerDc':       return t('net.peerDc');
      case 'reconnecting': return t('net.reconnecting');
      case 'waiting':      return t('net.waiting');
      default:             return '';
    }
  }

  private layoutPill(): void {
    const padX = 28;
    const padY = 14;
    const w = this.label.width + padX * 2;
    const h = this.label.height + padY * 2;
    const cx = this.layout.designWidth / 2;
    // A little below the top HUD strip so it doesn't collide with the timer.
    const cy = this.layout.hudTopRect.h + h / 2 + 24;

    const color = this.shownKind === 'peerDc' ? 0xaa2222 : 0x2c2c2a;
    this.pill.clear();
    this.pill.beginFill(color, 0.85);
    this.pill.lineStyle(2, 0xffffff, 0.25);
    this.pill.drawRoundedRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    this.pill.endFill();

    this.label.x = cx;
    this.label.y = cy;
  }
}

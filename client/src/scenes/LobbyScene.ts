import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';
import { bake } from '../render/bake';
import { buildWearOverlay } from '../render/wearOverlay';
import { BoilingSprite } from '../render/boil';
import { buildAvatar } from '../render/avatar';

// ── AI name pool ───────────────────────────────────────────────────────────────

const AI_NAMES = [
  'Scribble', 'Doodler', 'InkMaster', 'PencilWarrior', 'Eraserhead',
  'LoopyLines', 'SketchBot', 'NoteSlayer', 'RuledPage', 'BlotterKing',
  'QuillStrike', 'MarginNotes', 'CrayonCrusher', 'GraphiteFist', 'InkWell',
];

function randomAiName(): string {
  return AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)]!;
}

const C = {
  bg:     0xf5f0e8,
  paper:  0xfaf6ee,
  dark:   0x2c2c2a,
  mid:    0x888888,
  light:  0xdddddd,
  btnOff: 0xbbbbbb,
  accent: 0x4477cc,
  gold:   0xcc9900,
  green:  0x4a9e4a,
  red:    0xcc3333,
};

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return new PIXI.Text(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

// ── LobbyScene ────────────────────────────────────────────────────────────────

export interface LobbySceneCallbacks {
  onStartGame(opponentName: string): void;
  /** Launch a campaign level by its 0-based index in CAMPAIGN_LEVEL_ORDER. */
  onStartCampaign(levelIndex: number): void;
  /** Open the friend room (online play). Wired to the bottom-nav "social" slot. */
  onOpenRoom(): void;
  /** Open the shop (economy). Wired to the bottom-nav "shop" slot (S2-6). */
  onOpenShop(): void;
  /** Open the personal profile / settings screen (top-left profile chip). */
  onOpenProfile(): void;
  /** Player display name shown in the top-left profile chip. */
  playerName: string;
  /** Server-authoritative ladder standing (SaveData.pvp); shown as a header badge. */
  pvp?: { rank: string; elo: number };
  /** SA-4: offline single-player mode — online entries route to login instead. */
  offline?: boolean;
  /** Open the login screen (offline mode header chip + gated online entries). */
  onLogin?(): void;
  /** Log out (clear persisted session) — shown when logged in. */
  onLogout?(): void;
}

/** Campaign levels exposed in the lobby picker (1-3 = content, 4 = swarm stress test). */
const CAMPAIGN_LEVEL_COUNT = 4;

type LobbyState = 'idle' | 'matching' | 'vs';

export class LobbyScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: LobbySceneCallbacks;

  private state:        LobbyState = 'idle';
  private matchTimer    = 0;
  private vsTimer       = 0;
  private dotsTimer     = 0;
  private dotCount      = 0;
  private opponentName  = '';

  private btnBg!:    PIXI.Graphics;
  private btnLabel!: PIXI.Text;
  private vsLayer!:  PIXI.Container;
  private oppLabel!: PIXI.Text;
  /** Boiling-line title underline (art-direction §5.4); cleaned up in destroy. */
  private titleBoil: BoilingSprite | null = null;

  /** Hit rect for the start/matching button, in design space. */
  private btnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rects for the campaign (PvE) level-picker buttons, in design space. */
  private campaignBtnRects: Rect[] = [];
  /** Hit rect for the bottom-nav "social" slot (opens RoomScene). */
  private socialNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "shop" slot (opens ShopScene). */
  private shopNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the top-right account chip (login when offline / logout when on). */
  private accountChipRect: Rect | null = null;
  private accountChipFn: (() => void) | null = null;
  /** Hit rect for the top-left profile chip (opens SettingsScene). */
  private profileChipRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: LobbySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w  = layout.designWidth;
    this.h  = layout.designHeight;
    this.cb = cb;
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
  }

  // ── Scene interface ────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.state === 'matching') {
      this.matchTimer += dt;
      this.dotsTimer  += dt;
      if (this.dotsTimer >= 0.4) {
        this.dotsTimer = 0;
        this.dotCount  = (this.dotCount + 1) % 4;
        this.btnLabel.text = t('lobby.matching') + '.'.repeat(this.dotCount);
      }
      if (this.matchTimer >= 1.8) this.matchFound();
    } else if (this.state === 'vs') {
      this.vsTimer += dt;
      if (this.vsTimer >= 2.5) this.cb.onStartGame(this.opponentName);
    }
  }

  destroy(): void {
    this.unsubs.forEach(u => u());
    this.titleBoil?.destroy();
    this.titleBoil = null;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.state !== 'idle') return;
    const p = this.profileChipRect;
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) {
      this.cb.onOpenProfile();
      return;
    }
    if (x >= this.btnRect.x && x <= this.btnRect.x + this.btnRect.w &&
        y >= this.btnRect.y && y <= this.btnRect.y + this.btnRect.h) {
      this.onStartPressed();
      return;
    }
    for (let i = 0; i < this.campaignBtnRects.length; i++) {
      const r = this.campaignBtnRects[i]!;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        this.cb.onStartCampaign(i);
        return;
      }
    }
    const ac = this.accountChipRect;
    if (ac && this.accountChipFn &&
        x >= ac.x && x <= ac.x + ac.w && y >= ac.y && y <= ac.y + ac.h) {
      this.accountChipFn();
      return;
    }
    const s = this.socialNavRect;
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      // Online play requires an account; in offline mode route to login.
      if (this.cb.offline && this.cb.onLogin) this.cb.onLogin();
      else this.cb.onOpenRoom();
      return;
    }
    const sh = this.shopNavRect;
    if (x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) {
      // The shop spends server-authoritative coins → requires an account too.
      if (this.cb.offline && this.cb.onLogin) this.cb.onLogin();
      else this.cb.onOpenShop();
      return;
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private build(): void {
    const { w, h } = this;

    // Background — procedural notebook paper (sketch.ts), baked once per size.
    this.container.addChild(this.buildBackground());

    // Worn-notebook overlay (art-direction §3.1) — faint grain/creases over the
    // page, below the header/panels so it never hurts UI readability.
    const wear = buildWearOverlay(w, h);
    wear.alpha = 0.55;
    this.container.addChild(wear);

    // Header block
    const tbH = Math.round(h * 0.14);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark);
    titleBg.drawRect(0, 0, w, tbH);
    titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('lobby.title'), Math.round(h * 0.048), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH * 0.45;
    this.container.addChild(title);

    const subtitle = txt(t('lobby.subtitle'), Math.round(h * 0.022), C.light);
    subtitle.anchor.set(0.5, 0.5); subtitle.x = w / 2; subtitle.y = tbH * 0.78;
    this.container.addChild(subtitle);

    // Top-left profile chip (avatar + name) — opens the personal settings screen.
    const av = Math.round(tbH * 0.46);
    const avX = Math.round(w * 0.03);
    const avY = Math.round(tbH * 0.5 - av / 2);
    const avatar = buildAvatar(av, this.cb.playerName, 21);
    avatar.x = avX; avatar.y = avY;
    this.container.addChild(avatar);

    const nameGap = Math.round(w * 0.02);
    const nameLabel = txt(this.cb.playerName, Math.round(tbH * 0.24), 0xffffff, true);
    nameLabel.anchor.set(0, 0.5);
    nameLabel.x = avX + av + nameGap;
    nameLabel.y = tbH * 0.5;
    // Keep the chip clear of the centred title.
    const nameMax = w * 0.36 - (av + nameGap);
    if (nameLabel.width > nameMax) nameLabel.scale.set(nameMax / nameLabel.width);
    this.container.addChild(nameLabel);

    const pad = Math.round(tbH * 0.12);
    this.profileChipRect = {
      x: avX - pad, y: avY - pad,
      w: av + nameGap + nameLabel.width + 2 * pad, h: av + 2 * pad,
    };

    // Boiling-line title underline (art-direction §5.4) — a hand-drawn marker
    // stroke that subtly wobbles ~8fps. Cycles baked variants; near-zero cost.
    const ulW = Math.min(w * 0.6, title.width * 1.15);
    const ulH = Math.round(h * 0.02);
    this.titleBoil = new BoilingSprite(ulW, ulH, (pen) => {
      pen.stroke(
        [{ x: 2, y: ulH * 0.5 }, { x: ulW - 2, y: ulH * 0.5 }],
        { color: palette.marker, width: Math.max(4, ulH * 0.5), taper: 0.6, double: false },
      );
    }, { tag: 'lobby-title', variants: 3, fps: 8 });
    this.titleBoil.x = w / 2 - ulW / 2;
    this.titleBoil.y = tbH * 0.45 + title.height / 2;
    this.container.addChild(this.titleBoil);

    // Top-right account chip (SA-4): offline → login/register entry; online →
    // server-authoritative ladder badge with a small logout affordance.
    const chipX = w - Math.round(w * 0.04);
    if (this.cb.offline) {
      const login = txt(t('auth.loginEntry'), Math.round(h * 0.024), C.gold, true);
      login.anchor.set(1, 0.5); login.x = chipX; login.y = tbH * 0.5;
      this.container.addChild(login);
      const pad = Math.round(h * 0.02);
      this.accountChipRect = {
        x: login.x - login.width - pad, y: tbH * 0.5 - login.height / 2 - pad,
        w: login.width + 2 * pad, h: login.height + 2 * pad,
      };
      this.accountChipFn = this.cb.onLogin ?? null;
    } else if (this.cb.pvp) {
      const pvp = this.cb.pvp;
      const rankName = t(('rank.' + pvp.rank) as TranslationKey);
      const badge = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
      const badgeLabel = txt(badge, Math.round(h * 0.022), C.gold, true);
      badgeLabel.anchor.set(1, 0.5); badgeLabel.x = chipX; badgeLabel.y = tbH * 0.40;
      this.container.addChild(badgeLabel);
      if (this.cb.onLogout) {
        const out = txt(t('auth.logout'), Math.round(h * 0.018), C.light);
        out.anchor.set(1, 0.5); out.x = chipX; out.y = tbH * 0.68;
        this.container.addChild(out);
        const pad = Math.round(h * 0.012);
        this.accountChipRect = {
          x: out.x - out.width - pad, y: out.y - out.height / 2 - pad,
          w: out.width + 2 * pad, h: out.height + 2 * pad,
        };
        this.accountChipFn = this.cb.onLogout;
      }
    }

    // Feature blocks
    const blockY   = tbH + Math.round(h * 0.06);
    const blockH   = Math.round(h * 0.10);
    const blockW   = Math.round(w * 0.82);
    const blockX   = (w - blockW) / 2;
    const blockGap = Math.round(h * 0.015);

    [
      t('lobby.feature.1'),
      t('lobby.feature.2'),
      t('lobby.feature.3'),
    ].forEach((label, i) => {
      const box = this.sketchPanel(blockW, blockH, { fill: C.paper, border: C.dark, width: 2, seed: 11 + i });
      box.x = blockX;
      box.y = blockY + i * (blockH + blockGap);
      this.container.addChild(box);

      // Blue ink accent stroke down the left edge (replaces the flat bar).
      new SketchPen(box, 31 + i).line(4, 5, 4, blockH - 5, { color: C.accent, width: 4, jitter: 0.8, taper: 0.85 });

      const lbl = txt(label, Math.round(blockH * 0.28), C.dark);
      lbl.anchor.set(0, 0.5); lbl.x = 16; lbl.y = blockH / 2;
      box.addChild(lbl);
    });

    // Start button
    const btnW = Math.round(w * 0.72);
    const btnH = Math.round(h * 0.082);
    const btnX = (w - btnW) / 2;
    const btnY = Math.round(h * 0.63);
    this.btnRect = { x: btnX, y: btnY, w: btnW, h: btnH };

    this.btnBg = new PIXI.Graphics();
    this.drawBtn(this.btnBg, btnW, btnH, true);
    this.btnBg.x = btnX; this.btnBg.y = btnY;
    this.container.addChild(this.btnBg);

    this.btnLabel = txt(t('lobby.startMatch'), Math.round(btnH * 0.42), 0xffffff, true);
    this.btnLabel.anchor.set(0.5, 0.5);
    this.btnLabel.x = btnX + btnW / 2;
    this.btnLabel.y = btnY + btnH / 2;
    this.container.addChild(this.btnLabel);

    // Campaign (PvE) level picker — a label + numbered buttons below the match button.
    const campLabelY = btnY + btnH + Math.round(h * 0.022);
    const campTitle = txt(t('lobby.campaign'), Math.round(h * 0.024), C.dark, true);
    campTitle.anchor.set(0.5, 0.5);
    campTitle.x = btnX + btnW / 2;
    campTitle.y = campLabelY;
    this.container.addChild(campTitle);

    const campH   = Math.round(h * 0.07);
    const campY   = campLabelY + Math.round(h * 0.028);
    const campGap = Math.round(btnW * 0.04);
    const campW   = Math.round((btnW - campGap * (CAMPAIGN_LEVEL_COUNT - 1)) / CAMPAIGN_LEVEL_COUNT);
    this.campaignBtnRects = [];
    for (let i = 0; i < CAMPAIGN_LEVEL_COUNT; i++) {
      const cx = btnX + i * (campW + campGap);
      this.campaignBtnRects.push({ x: cx, y: campY, w: campW, h: campH });

      const cbg = this.sketchPanel(campW, campH, { fill: C.paper, border: C.gold, width: 2.4, seed: 51 + i });
      cbg.x = cx; cbg.y = campY;
      this.container.addChild(cbg);

      const cl = txt(String(i + 1), Math.round(campH * 0.46), C.dark, true);
      cl.anchor.set(0.5, 0.5);
      cl.x = cx + campW / 2;
      cl.y = campY + campH / 2;
      this.container.addChild(cl);
    }

    // Bottom nav bar
    const navH  = Math.round(h * 0.08);
    const navBg = new PIXI.Graphics();
    navBg.beginFill(C.dark, 0.9);
    navBg.drawRect(0, h - navH, w, navH);
    navBg.endFill();
    this.container.addChild(navBg);

    [
      t('lobby.nav.cards'), t('lobby.nav.stats'), t('lobby.nav.home'),
      t('lobby.nav.shop'), t('lobby.nav.social'),
    ].forEach((name, i) => {
      const slotW = w / 5;
      const slotX = i * slotW + slotW / 2;
      const slotY = h - navH / 2;
      // Wired slots: home (2), shop (3), social (4) → shown active.
      const active = i === 2 || i === 3 || i === 4;
      const dotColor = i === 2 ? C.accent : (i === 3 ? C.green : (i === 4 ? C.gold : C.mid));

      const dot = new PIXI.Graphics();
      dot.beginFill(dotColor, active ? 0.8 : 0.3);
      dot.drawCircle(0, 0, Math.round(navH * 0.17));
      dot.endFill();
      dot.x = slotX; dot.y = slotY - Math.round(navH * 0.18);
      navBg.addChild(dot);

      const navLabel = txt(name, Math.round(navH * 0.22), active ? C.light : C.mid);
      navLabel.anchor.set(0.5, 0);
      navLabel.x = slotX; navLabel.y = slotY + Math.round(navH * 0.04);
      navBg.addChild(navLabel);

      if (i === 3) {
        this.shopNavRect = { x: i * slotW, y: h - navH, w: slotW, h: navH };
      } else if (i === 4) {
        this.socialNavRect = { x: i * slotW, y: h - navH, w: slotW, h: navH };
      }
    });

    // VS overlay
    this.vsLayer = this.buildVsLayer(w, h);
    this.vsLayer.visible = false;
    this.container.addChild(this.vsLayer);
  }

  /**
   * Procedural notebook background drawn with the shared SketchPen: aged paper,
   * hand-drawn faint-blue ruled lines, and a red "teacher's margin" line down
   * the left (diegetic correcting pen, double-stroked for emphasis). Baked to a
   * texture cached per (w,h) so it costs nothing per frame; falls back to live
   * Graphics if no renderer is wired.
   */
  private buildBackground(): PIXI.DisplayObject {
    const { w, h } = this;
    const gfx = new PIXI.Graphics();
    gfx.beginFill(C.bg);
    gfx.drawRect(0, 0, w, h);
    gfx.endFill();

    const pen = new SketchPen(gfx, 0x5bd1c7);
    const lineGap = Math.round(h / 28);
    for (let y = lineGap; y < h; y += lineGap) {
      pen.line(0, y, w, y, { color: palette.ruleLine, width: 1.1, jitter: 0.7, taper: 0.9, double: false });
    }
    const mx = Math.round(w * 0.09);
    pen.line(mx, 0, mx, h, { color: palette.inkRed, width: 2.2, jitter: 1.0, taper: 0.95 });

    const tex = bake(`lobbybg:${Math.round(w)}x${Math.round(h)}`, gfx, w, h);
    if (tex) {
      const s = new PIXI.Sprite(tex);
      gfx.destroy();
      return s;
    }
    return gfx;
  }

  /**
   * Shared hand-drawn panel: flat fill + a scribbled SketchPen border. A fixed
   * seed keeps each panel's scrawl stable across redraws. Used for the feature
   * blocks, campaign buttons, start button, and VS player cards so the whole
   * lobby reads as one notebook doodle.
   */
  private sketchPanel(
    w: number, h: number,
    opts: { fill: number; border: number; width?: number; seed?: number },
  ): PIXI.Graphics {
    const g = new PIXI.Graphics();
    g.beginFill(opts.fill);
    g.drawRect(0, 0, w, h);
    g.endFill();
    new SketchPen(g, opts.seed ?? 7).rect(2, 2, w - 4, h - 4, {
      color: opts.border, width: opts.width ?? 2, jitter: 1.0,
    });
    return g;
  }

  private drawBtn(gfx: PIXI.Graphics, w: number, h: number, enabled: boolean): void {
    gfx.clear();
    gfx.beginFill(enabled ? C.dark : C.btnOff);
    gfx.drawRect(0, 0, w, h);
    gfx.endFill();
    new SketchPen(gfx, 5).rect(2, 2, w - 4, h - 4, {
      color: enabled ? C.accent : C.light, width: 2.4, jitter: 1.0,
    });
  }

  private buildVsLayer(w: number, h: number): PIXI.Container {
    const c = new PIXI.Container();

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.82);
    dim.drawRect(0, 0, w, h);
    dim.endFill();
    c.addChild(dim);

    const cardW = Math.round(w * 0.62);
    const cardH = Math.round(h * 0.12);
    const cardX = (w - cardW) / 2;

    const youCard = this.buildPlayerCard(cardW, cardH, t('lobby.you'), C.accent);
    youCard.x = cardX; youCard.y = Math.round(h * 0.28);
    c.addChild(youCard);

    const vs = txt(t('lobby.vs'), Math.round(h * 0.09), C.gold, true);
    vs.anchor.set(0.5, 0.5); vs.x = w / 2; vs.y = h * 0.5;
    c.addChild(vs);

    const oppCard = this.buildPlayerCard(cardW, cardH, '', C.red);
    oppCard.x = cardX; oppCard.y = Math.round(h * 0.58);
    c.addChild(oppCard);
    this.oppLabel = oppCard.getChildByName('nameLabel') as PIXI.Text;

    const hint = txt(t('lobby.loading'), Math.round(h * 0.022), C.mid);
    hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = h * 0.8;
    c.addChild(hint);

    return c;
  }

  private buildPlayerCard(w: number, h: number, name: string, accentColor: number): PIXI.Container {
    // Seed by side colour so the you/opp cards scrawl differently.
    const bg = this.sketchPanel(w, h, { fill: C.paper, border: accentColor, width: 2.4, seed: accentColor });
    // Ink accent stroke down the left edge.
    new SketchPen(bg, accentColor ^ 0x55).line(4, 5, 4, h - 5, { color: accentColor, width: 5, jitter: 0.8, taper: 0.85 });
    const nameLabel = txt(name, Math.round(h * 0.45), C.dark, true);
    nameLabel.name = 'nameLabel'; nameLabel.anchor.set(0, 0.5);
    nameLabel.x = Math.round(w * 0.08); nameLabel.y = h / 2;
    bg.addChild(nameLabel);
    return bg;
  }

  private onStartPressed(): void {
    this.state = 'matching'; this.matchTimer = 0; this.dotsTimer = 0; this.dotCount = 0;
    // Use the stored rect, not gfx.width — the sketch stroke overshoots the box,
    // so re-reading bounds would grow the button on every redraw.
    this.drawBtn(this.btnBg, this.btnRect.w, this.btnRect.h, false);
    this.btnLabel.text = t('lobby.matching') + '...';
  }

  private matchFound(): void {
    this.state = 'vs'; this.vsTimer = 0;
    this.opponentName  = randomAiName();
    this.oppLabel.text = this.opponentName;
    this.vsLayer.visible = true;
  }
}

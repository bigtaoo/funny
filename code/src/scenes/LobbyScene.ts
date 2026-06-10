import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';

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
  line:   0xc8d8e8,
  margin: 0xffb3b3,
  dark:   0x2c2c2a,
  mid:    0x888888,
  light:  0xdddddd,
  btnOff: 0xbbbbbb,
  accent: 0x4477cc,
  gold:   0xcc9900,
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
}

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

  /** Hit rect for the start/matching button, in design space. */
  private btnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

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
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.state !== 'idle') return;
    if (x >= this.btnRect.x && x <= this.btnRect.x + this.btnRect.w &&
        y >= this.btnRect.y && y <= this.btnRect.y + this.btnRect.h) {
      this.onStartPressed();
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private build(): void {
    const { w, h } = this;

    // Background + notebook lines
    const bg = new PIXI.Graphics();
    bg.beginFill(C.bg);
    bg.drawRect(0, 0, w, h);
    bg.endFill();

    const lineGap = Math.round(h / 28);
    bg.lineStyle(1, C.line, 0.6);
    for (let y = lineGap; y < h; y += lineGap) { bg.moveTo(0, y); bg.lineTo(w, y); }
    bg.lineStyle(1, C.margin, 0.7);
    const mx = Math.round(w * 0.09);
    bg.moveTo(mx, 0); bg.lineTo(mx, h);
    this.container.addChild(bg);

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
      const box = new PIXI.Graphics();
      box.beginFill(C.paper);
      box.lineStyle(1, C.line);
      box.drawRoundedRect(0, 0, blockW, blockH, 4);
      box.endFill();
      box.x = blockX;
      box.y = blockY + i * (blockH + blockGap);
      this.container.addChild(box);

      const accent = new PIXI.Graphics();
      accent.beginFill(C.accent, 0.7);
      accent.drawRect(0, 0, 4, blockH);
      accent.endFill();
      box.addChild(accent);

      const lbl = txt(label, Math.round(blockH * 0.28), C.dark);
      lbl.anchor.set(0, 0.5); lbl.x = 14; lbl.y = blockH / 2;
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

      const dot = new PIXI.Graphics();
      dot.beginFill(i === 2 ? C.accent : C.mid, i < 3 ? 0.8 : 0.3);
      dot.drawCircle(0, 0, Math.round(navH * 0.17));
      dot.endFill();
      dot.x = slotX; dot.y = slotY - Math.round(navH * 0.18);
      navBg.addChild(dot);

      const navLabel = txt(name, Math.round(navH * 0.22), i < 3 ? C.light : C.mid);
      navLabel.anchor.set(0.5, 0);
      navLabel.x = slotX; navLabel.y = slotY + Math.round(navH * 0.04);
      navBg.addChild(navLabel);
    });

    // VS overlay
    this.vsLayer = this.buildVsLayer(w, h);
    this.vsLayer.visible = false;
    this.container.addChild(this.vsLayer);
  }

  private drawBtn(gfx: PIXI.Graphics, w: number, h: number, enabled: boolean): void {
    gfx.clear();
    gfx.beginFill(enabled ? C.dark : C.btnOff);
    gfx.lineStyle(2, enabled ? C.accent : C.light);
    gfx.drawRoundedRect(0, 0, w, h, 6);
    gfx.endFill();
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
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(C.paper);
    bg.lineStyle(2, accentColor);
    bg.drawRoundedRect(0, 0, w, h, 6);
    bg.endFill();
    const bar = new PIXI.Graphics();
    bar.beginFill(accentColor); bar.drawRect(0, 0, 5, h); bar.endFill();
    const nameLabel = txt(name, Math.round(h * 0.45), C.dark, true);
    nameLabel.name = 'nameLabel'; nameLabel.anchor.set(0, 0.5);
    nameLabel.x = Math.round(w * 0.08); nameLabel.y = h / 2;
    c.addChild(bg, bar, nameLabel);
    return c;
  }

  private onStartPressed(): void {
    this.state = 'matching'; this.matchTimer = 0; this.dotsTimer = 0; this.dotCount = 0;
    this.drawBtn(this.btnBg, this.btnBg.width, this.btnBg.height, false);
    this.btnLabel.text = t('lobby.matching') + '...';
  }

  private matchFound(): void {
    this.state = 'vs'; this.vsTimer = 0;
    this.opponentName  = randomAiName();
    this.oppLabel.text = this.opponentName;
    this.vsLayer.visible = true;
  }
}

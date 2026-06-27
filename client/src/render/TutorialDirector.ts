import * as PIXI from 'pixi.js-legacy';
import { CardType, SpellType, GameState } from '../game';
import { ILayout, Rect } from '../layout/ILayout';
import { t, type TranslationKey } from '../i18n';

/**
 * 教学导演（TutorialDirector）—— 专属教学关 `ch0_tutorial` 的表现层编排（ONBOARDING_DESIGN §3.4）。
 *
 * 只在教学关激活。**纯表现层**：只读同步态做差分、控引擎时钟（冻结/放行）、控引导 UI，
 * 绝不改写战斗状态（永不失败的基地兜底是唯一例外，§3.5）。引擎确定性/回放/裁判不受影响。
 *
 * 三段流程：
 *  - 阶段 A 认知导览（O1–O7）：引擎全程冻结，点「下一步」推进纯讲解。
 *  - 阶段 B 动手三拍：放兵 → 放建筑 → 放法术。每拍高亮目标卡 + 目标道，冻结直到玩家打出
 *    对应类别的卡；放行后引擎推进、脚本反应波（关卡 JSON 的 atTick）随即播出，到达本拍
 *    gate tick 再冻结进入下一拍。
 *  - 阶段 C 自由发挥 + 毕业：解除冻结、抽牌切回随机、常驻「完成教学」按钮 → 脚本胜利。
 *
 * 永不失败：每段反应波都撞在玩家刚布防的同一条道；冻结期零威胁；外加基地血量夹住（host 兜底）。
 */

// ── Host hooks: GameRenderer 提供，导演借此读视图几何 / 委托高亮 / 控引擎，零内部耦合。 ───
export interface TutorialHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  /** 高亮一条单位车道（蓝，放兵拍）。 */
  highlightUnitLane(col: number): void;
  /** 高亮一格建筑位（蓝，放建筑拍）。 */
  highlightBuildingLane(col: number): void;
  /** 清掉棋盘高亮。 */
  clearLaneHighlights(): void;
  /** 本地玩家手牌某槽的设计空间中心（用于围住引导卡）。 */
  handSlotCenter(index: number): { x: number; y: number };
  /** 进阶段 C：把抽牌策略切回随机（替换 TutorialDrawPolicy）。 */
  switchToFreePlayDraw(): void;
  /** 毕业：触发本地玩家脚本胜利。 */
  forceVictory(): void;
  /** 跳过教学：落大厅（host 负责写 tutorial_done）。 */
  onSkip(): void;
}

type Phase = 'orientation' | 'beat' | 'freeplay' | 'done';

interface BeatSpec {
  cardId: string;
  cardType: CardType;
  col: number;
  /** 放行后引擎跑到该 tick（反应波已结束）即冻结进入下一拍 / 自由发挥。 */
  gateTick: number;
  kind: 'unit' | 'building' | 'spell';
  /**
   * clear 模式（法术拍）：进入本拍先解冻跑到该 tick 让铺垫敌团刷出来，再冻结弹提示
   * （敌人先在、玩家后清，§3.2 Beat 3）。place 模式（兵/建筑拍）省略：先放后反应。
   */
  setupTick?: number;
}

// 三拍配置：列号与关卡 JSON 反应波列号一致（4/7/2），gate/ setup tick 与 atTick(20/140/300) 对齐（§3.3）。
//   Beat1 兵：freeze@0 → 放兵 → 放行 → 反应波@20 → gate120
//   Beat2 塔：freeze@120 → 放塔 → 放行 → 反应波@140 → gate280
//   Beat3 法：进拍跑到 setup320（铺垫团@300~316 刷完）→ freeze → 放法术 → 放行清场 → gate360
const BEATS: BeatSpec[] = [
  { cardId: 'infantry_1', cardType: CardType.Unit,     col: 4, gateTick: 120, kind: 'unit' },
  { cardId: 'tower_1',    cardType: CardType.Building,  col: 7, gateTick: 280, kind: 'building' },
  { cardId: 'meteor_1',   cardType: CardType.Spell,     col: 2, gateTick: 360, kind: 'spell', setupTick: 320 },
];

const ORIENTATION_STEPS = 7; // O1–O7

// 基地永不破：低于此值即夹住（§3.5 兜底）。
const NEVER_FAIL_BASE_FLOOR = 1;

// 手绘笔记本调色（局部，避免跨模块耦合）。我蓝 = 玩家高亮。
const C_PAPER  = 0xf6efdd;
const C_DARK   = 0x2b2b2b;
const C_BLUE   = 0x4a7fc1;
const C_MID    = 0x6b6b6b;

export class TutorialDirector {
  private readonly host: TutorialHost;
  private readonly layout: ILayout;
  private readonly root: PIXI.Container;

  private phase: Phase = 'orientation';
  private orientStep = 0;
  private beatIndex = 0;
  /**
   * 引擎是否冻结。初始 false：先让引擎跑第一 tick 发开局手牌（emitInitialEvents 在
   * firstStep 内，GameEngine §step）——否则导览期一直冻结、手牌为空、Beat 1 无牌可放。
   * 发牌后（elapsedTicks≥1）立即冻结进入导览。波次最早在 atTick 20，发牌窗安全。
   */
  engineFrozen = false;
  /** 是否已喂过开局第一 tick（发牌）。 */
  private primed = false;
  /** 已放行、正在等本拍反应波跑到 gate tick。 */
  private beatReleased = false;
  /** allowCardPlay 命中本拍引导卡后置位，下一 onTick 解冻。 */
  private pendingRelease = false;
  /** clear 模式：正在解冻刷铺垫敌团，到 setupTick 再冻结弹提示。 */
  private awaitingSetup = false;

  private pulse = 0;

  // UI 层
  private dim!: PIXI.Graphics;          // 阶段 A/C 的半透明遮罩
  private cardPanel!: PIXI.Container;    // 指令卡（标题 + 正文 + 按钮）
  private slotRing!: PIXI.Graphics;      // 围住引导卡的脉冲环
  private clusterRing!: PIXI.Graphics;   // 法术拍：敌团位置脉冲环
  private nextBtnRect: Rect | null = null;
  private actionBtnRect: Rect | null = null; // 「完成教学」
  private skipBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(host: TutorialHost) {
    this.host = host;
    this.layout = host.layout;
    this.root = new PIXI.Container();
    host.container.addChild(this.root);
    this.buildLayers();
    this.renderOrientation();
  }

  get isFinished(): boolean { return this.phase === 'done'; }

  // ── 输入门控（GameRenderer.handleDown 先问导演，避免引入 PIXI interactive）─────────────
  /** 返回 true = 本次 tap 被导演消费，GameRenderer 不再处理。 */
  handleDown(x: number, y: number): boolean {
    if (this.hit(this.skipBtnRect, x, y)) { this.host.onSkip(); return true; }
    if (this.phase === 'orientation') {
      if (this.nextBtnRect && this.hit(this.nextBtnRect, x, y)) { this.advanceOrientation(); }
      return true; // 导览期吞掉一切（无需操作棋盘）
    }
    if (this.phase === 'freeplay') {
      if (this.actionBtnRect && this.hit(this.actionBtnRect, x, y)) { this.graduate(); return true; }
      return false; // 自由发挥：放过棋盘/手牌交互
    }
    if (this.phase === 'done') return true;
    // 阶段 B：只吞按钮，其余放过让玩家拖卡
    return false;
  }

  /**
   * GameRenderer.commitCardPlay 调用：本拍只放行对应类别的卡。
   * 返回 false → renderer 跳过 engine.playCard（避免误打浪费）。
   */
  allowCardPlay(cardType: CardType, _spellType: SpellType | undefined): boolean {
    if (this.phase === 'freeplay') return true;
    if (this.phase !== 'beat') return false;
    if (this.awaitingSetup || this.beatReleased) return false; // 铺垫中 / 已放行 → 不再受理
    const beat = BEATS[this.beatIndex]!;
    if (cardType === beat.cardType) { this.pendingRelease = true; return true; }
    return false;
  }

  // ── 每帧（GameRenderer.update 末尾）：读态、控时钟、永不失败兜底、推进状态机。 ──────────
  onTick(state: GameState, dt: number): void {
    // 开局喂一 tick 发牌后立即冻结进入导览（见 engineFrozen 注释）。
    if (!this.primed) {
      if (state.elapsedTicks >= 1) { this.primed = true; this.engineFrozen = true; }
      return;
    }

    // 永不失败：基地血量夹住（§3.5 表现层兜底）。
    if (state.bottomPlayer.baseHp < NEVER_FAIL_BASE_FLOOR) {
      state.bottomPlayer.baseHp = NEVER_FAIL_BASE_FLOOR;
    }

    this.pulse += dt;
    this.setBeatSlotIndex(state);
    this.animatePulse();

    if (this.phase === 'beat') {
      const beat = BEATS[this.beatIndex]!;
      if (this.awaitingSetup) {
        // clear 模式铺垫中：敌团刷完（到 setupTick）→ 冻结，玩家此刻才动手清场。
        if (state.elapsedTicks >= beat.setupTick!) {
          this.awaitingSetup = false;
          this.engineFrozen = true;
        }
      } else if (this.pendingRelease) {
        // 引导卡已打出 → 解冻，反应波 / 清场随即播出。
        this.pendingRelease = false;
        this.beatReleased = true;
        this.engineFrozen = false;
        this.host.clearLaneHighlights();
        this.slotRing.visible = false;
        this.clusterRing.visible = false;
        this.showBeatCollapse();
      } else if (this.beatReleased && state.elapsedTicks >= beat.gateTick) {
        // 本拍结束 → 进入下一拍 / 自由发挥。
        this.beatReleased = false;
        if (this.beatIndex + 1 < BEATS.length) {
          this.enterBeat(this.beatIndex + 1);
        } else {
          this.startFreePlay();
        }
      }
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  // ── 阶段迁移 ────────────────────────────────────────────────────────────────
  private advanceOrientation(): void {
    this.orientStep++;
    if (this.orientStep < ORIENTATION_STEPS) {
      this.renderOrientation();
    } else {
      this.phase = 'beat';
      this.dim.visible = false;
      this.enterBeat(0);
    }
  }

  /** 进入第 i 拍：clear 模式先放行刷铺垫敌团，place 模式直接冻结弹提示。 */
  private enterBeat(i: number): void {
    this.beatIndex = i;
    this.beatReleased = false;
    this.pendingRelease = false;
    const beat = BEATS[i]!;
    if (beat.setupTick !== undefined) {
      this.awaitingSetup = true;
      this.engineFrozen = false;  // 解冻让铺垫敌团刷出来
    } else {
      this.awaitingSetup = false;
      this.engineFrozen = true;
    }
    this.renderBeatPrompt();
  }

  private startFreePlay(): void {
    this.phase = 'freeplay';
    this.engineFrozen = false;
    this.host.switchToFreePlayDraw();
    this.host.clearLaneHighlights();
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    this.renderFreePlay();
  }

  private graduate(): void {
    this.phase = 'done';
    this.clearPanel();
    this.dim.visible = false;
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    this.host.clearLaneHighlights();
    this.host.forceVictory();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  private renderOrientation(): void {
    const n = this.orientStep + 1; // O1..O7
    this.dim.visible = true;
    const isLandscape = this.layout.orientation === 'landscape';
    const bodyKey = (isLandscape && (n === 1 || n === 2))
      ? `tutorial.o${n}.body.landscape`
      : `tutorial.o${n}.body`;
    this.drawPanel(
      tk(`tutorial.o${n}.title`),
      tk(bodyKey),
      t('tutorial.next' as TranslationKey),
      'next',
    );
  }

  private renderBeatPrompt(): void {
    const beat = BEATS[this.beatIndex]!;
    this.dim.visible = false;
    const i = this.beatIndex + 1; // 1..3
    this.drawPanel(tk(`tutorial.beat${i}.title`), tk(`tutorial.beat${i}.body`), null, 'beat');

    // 高亮目标道。
    if (beat.kind === 'unit') this.host.highlightUnitLane(beat.col);
    else if (beat.kind === 'building') this.host.highlightBuildingLane(beat.col);
    else this.host.clearLaneHighlights();

    // 围住手牌里的引导卡（按 id 找当前槽；找不到则不画，靠文案兜底）。
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    if (beat.kind === 'spell') {
      // 法术拍：在铺垫敌团落点（目标道偏敌方上侧，高 row=上）画脉冲环引导落点。
      const rows = this.layout.boardRect.h / this.layout.cellSize;
      const p = this.layout.gridToScreen(beat.col, Math.round(rows * 0.72));
      this.clusterRing.position.set(p.x, p.y);
      this.clusterRing.visible = true;
    }
  }

  /** 引导卡命中后的「收束」反馈：换正文、暂留。 */
  private showBeatCollapse(): void {
    const i = this.beatIndex + 1;
    this.drawPanel(tk(`tutorial.beat${i}.title`), tk(`tutorial.beat${i}.done`), null, 'beat');
  }

  private renderFreePlay(): void {
    this.dim.visible = false;
    this.drawPanel(
      t('tutorial.free.title' as TranslationKey),
      t('tutorial.free.body' as TranslationKey),
      t('tutorial.complete' as TranslationKey),
      'action',
    );
  }

  // ── UI 构建 ─────────────────────────────────────────────────────────────────
  private buildLayers(): void {
    const { designWidth: W, designHeight: H } = this.layout;

    this.dim = new PIXI.Graphics();
    this.dim.beginFill(0x000000, 0.55).drawRect(0, 0, W, H).endFill();
    this.dim.visible = false;
    this.root.addChild(this.dim);

    this.slotRing = new PIXI.Graphics();
    this.slotRing.visible = false;
    this.root.addChild(this.slotRing);

    this.clusterRing = new PIXI.Graphics();
    this.clusterRing.visible = false;
    this.root.addChild(this.clusterRing);

    this.cardPanel = new PIXI.Container();
    this.root.addChild(this.cardPanel);

    // 常驻跳过按钮（右上）。
    this.drawSkipButton();
  }

  private drawSkipButton(): void {
    const { designWidth: W } = this.layout;
    const bw = Math.round(W * 0.18);
    const bh = Math.round(bw * 0.42);
    const bx = W - bw - Math.round(W * 0.03);
    const by = Math.round(bh * 0.6);
    this.skipBtnRect = { x: bx, y: by, w: bw, h: bh };
    const g = new PIXI.Graphics();
    g.beginFill(C_DARK, 0.78).drawRoundedRect(bx, by, bw, bh, bh * 0.3).endFill();
    this.root.addChild(g);
    const lbl = new PIXI.Text(t('tutorial.skip' as TranslationKey), {
      fontFamily: 'monospace', fontSize: Math.round(bh * 0.42), fill: 0xffffff,
    });
    lbl.anchor.set(0.5);
    lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    this.root.addChild(lbl);
  }

  /** 指令卡：底部居中（阶段 B/C 不挡棋盘上方），含标题 + 正文 + 可选按钮。 */
  private drawPanel(title: string, body: string, btnLabel: string | null, btnKind: 'next' | 'action' | 'beat'): void {
    this.clearPanel();
    const { designWidth: W, designHeight: H } = this.layout;
    const pw = Math.round(W * 0.86);
    const px = (W - pw) / 2;
    const hasBtn = !!btnLabel;
    const ph = Math.round(H * (hasBtn ? 0.22 : 0.15));
    // 阶段 B 卡点放在棋盘下方上沿（手牌之上）；导览/自由发挥居中靠下。
    const py = this.phase === 'beat'
      ? Math.round(this.layout.handRect.y - ph - H * 0.02)
      : Math.round(H * 0.6);

    const bg = new PIXI.Graphics();
    bg.beginFill(C_PAPER, 0.97);
    bg.lineStyle(2.4, C_BLUE, 1);
    bg.drawRoundedRect(px, py, pw, ph, 12).endFill();
    this.cardPanel.addChild(bg);

    const titleLbl = new PIXI.Text(title, {
      fontFamily: 'monospace', fontSize: Math.round(ph * 0.18), fontWeight: 'bold', fill: C_DARK,
      wordWrap: true, wordWrapWidth: pw - 32,
    });
    titleLbl.x = px + 16; titleLbl.y = py + 14;
    this.cardPanel.addChild(titleLbl);

    const bodyLbl = new PIXI.Text(body, {
      fontFamily: 'monospace', fontSize: Math.round(ph * 0.13), fill: C_MID,
      wordWrap: true, wordWrapWidth: pw - 32,
    });
    bodyLbl.x = px + 16; bodyLbl.y = py + 14 + Math.round(ph * 0.26);
    this.cardPanel.addChild(bodyLbl);

    this.nextBtnRect = null;
    this.actionBtnRect = null;
    if (hasBtn) {
      const bw = Math.round(pw * 0.32);
      const bh = Math.round(ph * 0.28);
      const bx = px + pw - bw - 16;
      const by = py + ph - bh - 14;
      const btn = new PIXI.Graphics();
      btn.beginFill(C_BLUE).drawRoundedRect(bx, by, bw, bh, bh * 0.3).endFill();
      this.cardPanel.addChild(btn);
      const bl = new PIXI.Text(btnLabel!, {
        fontFamily: 'monospace', fontSize: Math.round(bh * 0.46), fontWeight: 'bold', fill: 0xffffff,
      });
      bl.anchor.set(0.5);
      bl.x = bx + bw / 2; bl.y = by + bh / 2;
      this.cardPanel.addChild(bl);
      const rect = { x: bx, y: by, w: bw, h: bh };
      if (btnKind === 'next') this.nextBtnRect = rect;
      else if (btnKind === 'action') this.actionBtnRect = rect;
    }
  }

  private clearPanel(): void {
    this.cardPanel.removeChildren().forEach((c) => c.destroy());
    this.nextBtnRect = null;
    this.actionBtnRect = null;
  }

  /** 脉冲动画：引导卡环 + 法术敌团环呼吸。 */
  private animatePulse(): void {
    if (this.phase !== 'beat') return;
    const beat = BEATS[this.beatIndex]!;
    const a = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.pulse * 5));

    // 引导卡环（按 id 找当前槽）。
    if (beat.kind !== 'spell' && !this.beatReleased) {
      const idx = this.lastSlotIndex;
      if (idx >= 0) {
        const c = this.host.handSlotCenter(idx);
        const w = this.layout.cardWidth + 10;
        const h = this.layout.cardHeight + 10;
        this.slotRing.clear();
        this.slotRing.lineStyle(4, C_BLUE, a);
        this.slotRing.drawRoundedRect(c.x - w / 2, c.y - h / 2, w, h, 8);
        this.slotRing.visible = true;
      } else {
        this.slotRing.visible = false;
      }
    }

    if (this.clusterRing.visible) {
      const r = this.layout.cellSize * (1.1 + 0.15 * Math.sin(this.pulse * 5));
      this.clusterRing.clear();
      this.clusterRing.lineStyle(4, C_BLUE, a);
      this.clusterRing.drawCircle(0, 0, r);
    }
  }

  /** 由 GameRenderer 在 onTick 前喂入当前引导卡所在槽（按 id 差分）。-1 表示不在手。 */
  private lastSlotIndex = -1;
  setBeatSlotIndex(state: GameState): void {
    if (this.phase !== 'beat') { this.lastSlotIndex = -1; return; }
    const beat = BEATS[this.beatIndex]!;
    this.lastSlotIndex = state.bottomPlayer.hand.slots.findIndex((s) => s?.card.id === beat.cardId);
  }

  private hit(r: Rect, x: number, y: number): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
}

/** 收窄到 TranslationKey 的小工具（教学键由 §3.4 全量补齐，运行时缺失会回退键名）。 */
function tk(key: string): string {
  return t(key as TranslationKey);
}

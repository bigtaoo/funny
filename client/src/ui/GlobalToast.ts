import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, seedFor } from '../render/sketchUi';

// 全局兜底 toast：浮在所有场景之上的一条临时提示条，专供 createAppCore / 全局错误处理器
// 在「场景没有自己的提示」时弹用（非 200 回复 / 网络失败的兜底）。各场景仍用各自的 showToast，
// 不经过这里——这只是漏网错误的安全网。
//
// 直接挂在 app.stage（屏幕像素坐标，非 gameLayer 设计坐标），故不受 Contain 缩放 / 场景切换影响；
// 位置每帧按 app.screen 重算，天然跟随窗口 resize。

const HOLD_S = 3.2;  // 完全不透明的停留秒数
const FADE_S = 0.3;  // 淡入 / 淡出各自时长

export class GlobalToast {
  private readonly layer = new PIXI.Container();
  private current: PIXI.Container | null = null;
  private age = 0;
  private ttl = 0;

  constructor(private readonly app: PIXI.Application) {
    this.layer.zIndex = 10_000; // 盖住一切场景内容
    app.stage.sortableChildren = true;
    app.stage.addChild(this.layer);
    app.ticker.add(this.tick, this);
  }

  /** 弹一条提示（默认红色错误条）。重复调用会替换当前条。 */
  show(text: string, color: number = C.red): void {
    this.clear();
    const { width: w, height: h } = this.app.screen;
    const lbl = txt(text, Math.round(h * 0.026), 0xffffff, true);
    const padX = Math.round(w * 0.04);
    const padY = Math.round(h * 0.012);
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.86);
    const bg = sketchPanel(bw, bh, {
      fill: color, fillAlpha: 0.95, border: color, width: 2, seed: seedFor(bw, bh, 2),
    });
    bg.x = bx; bg.y = by;
    lbl.anchor.set(0.5, 0.5);
    lbl.x = bx + bw / 2;
    lbl.y = by + bh / 2;

    const c = new PIXI.Container();
    c.alpha = 0;
    c.addChild(bg, lbl);
    this.layer.addChild(c);
    this.current = c;
    this.age = 0;
    this.ttl = FADE_S + HOLD_S + FADE_S;
  }

  private tick = (): void => {
    if (!this.current) return;
    this.age += this.app.ticker.deltaMS / 1000;
    const remain = this.ttl - this.age;
    if (remain <= 0) { this.clear(); return; }
    // 淡入 min(age/FADE)，淡出 min(remain/FADE)，取小者 → 梯形透明度曲线。
    this.current.alpha = Math.min(1, this.age / FADE_S, remain / FADE_S);
  };

  private clear(): void {
    if (!this.current) return;
    this.layer.removeChild(this.current);
    this.current.destroy({ children: true });
    this.current = null;
  }
}

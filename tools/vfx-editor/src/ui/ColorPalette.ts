/**
 * ColorPalette.ts — fixed in-game preview colours (DESIGN §3.8 V10).
 *
 * Switching a swatch changes only the preview colour passed to interpret(); the
 * effect data itself stays colour-agnostic (runtime colour comes from the
 * caller's play(...)). "默认色" resolves to the effect's own defaultColor.
 */
import { PALETTE, Swatch, toHex } from '../model/color';
import { EffectModel } from '../model/EffectModel';

export class ColorPalette {
  private activeKey = 'default';

  constructor(
    private readonly mount: HTMLElement,
    private readonly model: EffectModel,
    private readonly onChange: () => void,
  ) {
    this.render();
  }

  /** Resolved hex colour to feed the preview. */
  get color(): number {
    const sw = PALETTE.find((s) => s.key === this.activeKey) ?? PALETTE[0];
    if (sw.color === -1) return toHex(this.model.effect.defaultColor, 0x222222);
    return sw.color;
  }

  private render(): void {
    this.mount.innerHTML = '';
    for (const sw of PALETTE) {
      const el = document.createElement('div');
      el.className = 'swatch' + (sw.key === this.activeKey ? ' active' : '');
      el.style.background = sw.color === -1 ? 'repeating-linear-gradient(45deg,#444,#444 4px,#666 4px,#666 8px)'
        : `#${(sw.color >>> 0).toString(16).padStart(6, '0')}`;
      el.title = sw.label;
      const label = document.createElement('span');
      label.textContent = sw.label;
      el.appendChild(label);
      el.addEventListener('click', () => { this.activeKey = sw.key; this.render(); this.onChange(); });
      this.mount.appendChild(el);
    }
  }
}

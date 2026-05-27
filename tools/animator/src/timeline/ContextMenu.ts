/**
 * Lightweight right-click context menu component.
 * Call show() to position and display; items are rendered as buttons.
 */

export interface MenuItem {
  label: string;
  disabled?: boolean;
  action: () => void;
}

export class ContextMenu {
  private readonly el: HTMLDivElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'background:#242436', 'border:1px solid #3a3a58',
      'border-radius:6px', 'padding:4px 0', 'z-index:9999',
      'font-size:12px', 'color:#cdd6f4', 'min-width:160px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.5)', 'display:none',
    ].join(';');
    document.body.appendChild(this.el);

    document.addEventListener('mousedown', e => {
      if (!this.el.contains(e.target as Node)) this.hide();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.hide();
    });
  }

  show(x: number, y: number, items: MenuItem[]): void {
    this.el.innerHTML = '';

    for (const item of items) {
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.disabled    = item.disabled ?? false;
      btn.style.cssText = [
        'display:block', 'width:100%', 'padding:5px 14px', 'text-align:left',
        'background:none', 'border:none', 'color:inherit', 'cursor:pointer',
        'font-size:12px', 'border-radius:0',
      ].join(';');
      btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#3a3a58'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
      btn.addEventListener('click', () => { if (!item.disabled) { item.action(); this.hide(); } });
      this.el.appendChild(btn);
    }

    // Position, keeping menu in viewport
    this.el.style.display = 'block';
    const rect = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, window.innerWidth  - rect.width  - 4)}px`;
    this.el.style.top  = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  destroy(): void {
    this.el.remove();
  }
}

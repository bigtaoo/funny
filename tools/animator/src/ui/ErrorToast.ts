// ── ErrorToast ────────────────────────────────────────────────────────────────
// Floating popup for error / blocked-action messages. Important feedback that the
// artist must not miss (failures, unsupported files, "do X first") lands here —
// a red, dismissible card stacked top-center — instead of the bottom status bar,
// which is reserved for low-stakes progress chatter (Saving…, Loaded, Ready).
//
// Self-contained: builds its own container on document.body, listens to the
// 'error' event on the bus. Multiple errors stack and each auto-dismisses.

import type { EventBus, AppEvents } from '../core/EventBus';

const AUTO_DISMISS_MS = 8000;   // errors linger long enough to read, never block

export class ErrorToast {
  private readonly container: HTMLElement;

  constructor(bus: EventBus<AppEvents>) {
    const c = document.createElement('div');
    c.id = 'error-toast-container';
    c.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2000;' +
      'display:flex;flex-direction:column;gap:8px;align-items:center;' +
      'pointer-events:none;max-width:min(90vw,520px)';
    document.body.appendChild(c);
    this.container = c;

    bus.on('error', msg => this.show(msg));
  }

  private show(msg: string): void {
    const toast = document.createElement('div');
    toast.style.cssText =
      'pointer-events:auto;display:flex;align-items:flex-start;gap:10px;' +
      'background:var(--surface,#2a2a2a);color:var(--text,#eee);' +
      'border:1px solid var(--danger,#e0564b);border-left:3px solid var(--danger,#e0564b);' +
      'border-radius:6px;padding:10px 12px;font-size:13px;line-height:1.5;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.4);max-width:100%';

    const icon = document.createElement('span');
    icon.textContent = '⚠';
    icon.style.cssText = 'color:var(--danger,#e0564b);font-size:15px;flex:0 0 auto;line-height:1.4';

    const text = document.createElement('span');
    text.textContent = msg;
    text.style.cssText = 'flex:1;word-break:break-word';

    const close = document.createElement('button');
    close.textContent = '✕';
    close.className = 'sm';
    close.style.cssText =
      'flex:0 0 auto;margin:0;padding:0 4px;background:transparent;border:none;' +
      'color:var(--text-dim,#999);cursor:pointer;font-size:13px';

    const dismiss = (): void => { toast.remove(); };
    close.addEventListener('click', dismiss);

    toast.append(icon, text, close);
    this.container.appendChild(toast);
    window.setTimeout(dismiss, AUTO_DISMISS_MS);
  }
}

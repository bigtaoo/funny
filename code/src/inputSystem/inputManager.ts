import { UIElement } from './uiElement';

type InputType = 'down' | 'up' | 'tap';

type InputEvent = {
  x: number;
  y: number;
  type: InputType;
};

type Handler = (e: InputEvent) => void;

export class InputManager {
  private handlers: Map<InputType, Handler[]> = new Map();
  private uiElements: UIElement[] = [];

  constructor() {
    this.handlers.set('down', []);
    this.handlers.set('up', []);
    this.handlers.set('tap', []);
  }

  // ---------- Public API ----------

  on(type: InputType, handler: Handler) {
    this.handlers.get(type)!.push(handler);
  }

  registerUI(element: UIElement) {
    this.uiElements.push(element);
    this.sortUI();
  }

  unregisterUI(element: UIElement) {
    this.uiElements = this.uiElements.filter((e) => e !== element);
  }

  emit(e: InputEvent) {
    // 1️⃣ UI priority (top-most first)
    for (let i = this.uiElements.length - 1; i >= 0; i--) {
      const el = this.uiElements[i];

      if (!el.visible) continue;

      if (el.contains(e.x, e.y)) {
        el.handle(e);
        return; // 🔥 stop propagation
      }
    }

    // 2️⃣ fallback to global handlers
    const list = this.handlers.get(e.type)!;
    for (const h of list) h(e);
  }

  private sortUI() {
    this.uiElements.sort((a, b) => a.zIndex - b.zIndex);
  }
}

export const Input = new InputManager();

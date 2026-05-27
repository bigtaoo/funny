import type { EventBus, AppEvents } from '../core/EventBus';

export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    bus: EventBus<AppEvents>,
  ) {
    bus.on('status', msg => {
      el.textContent = msg;
      // Auto-clear after 3 s
      setTimeout(() => { if (el.textContent === msg) el.textContent = 'Ready'; }, 3000);
    });

    bus.on('history:change', ({ label }) => {
      // Show hint about last action when nothing else is displayed
      if (el.textContent === 'Ready') el.textContent = label;
    });
  }
}

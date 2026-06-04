/**
 * Injects resize handles between the editor's panels and wires up drag behaviour.
 *
 * Vertical handles:  left-panel | canvas | right-panel | atlas-panel
 * Horizontal handle: main area  | timeline
 */
export class ResizablePanels {
  constructor(rootEl: HTMLElement) {
    this.setupVertical(rootEl);
    this.setupHorizontal(rootEl);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private createHandle(type: 'v' | 'h'): HTMLElement {
    const el = document.createElement('div');
    el.className = `resize-handle resize-handle-${type}`;
    return el;
  }

  private makeDragger(
    handle: HTMLElement,
    axis: 'x' | 'y',
    onDrag: (delta: number) => void,
  ) {
    let prev = 0;

    const onMove = (e: MouseEvent) => {
      const cur = axis === 'x' ? e.clientX : e.clientY;
      onDrag(cur - prev);
      prev = cur;
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      prev = axis === 'x' ? e.clientX : e.clientY;
      handle.classList.add('dragging');
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── vertical splitters ────────────────────────────────────────────────────

  private setupVertical(rootEl: HTMLElement) {
    const mainEl     = rootEl.querySelector<HTMLElement>('.main')!;
    const leftPanel  = rootEl.querySelector<HTMLElement>('.left-panel')!;
    const canvasWrap = rootEl.querySelector<HTMLElement>('#canvas-wrap')!;
    const rightPanel = rootEl.querySelector<HTMLElement>('.right-panel')!;
    const atlasPanel = rootEl.querySelector<HTMLElement>('#atlas-panel')!;
    const MIN = 80;

    // left | canvas
    const h1 = this.createHandle('v');
    mainEl.insertBefore(h1, canvasWrap);
    this.makeDragger(h1, 'x', delta => {
      const w = leftPanel.offsetWidth + delta;
      if (w >= MIN) leftPanel.style.width = `${w}px`;
    });

    // canvas | right
    const h2 = this.createHandle('v');
    mainEl.insertBefore(h2, rightPanel);
    this.makeDragger(h2, 'x', delta => {
      const w = rightPanel.offsetWidth - delta;
      if (w >= MIN) rightPanel.style.width = `${w}px`;
    });

    // right | atlas
    const h3 = this.createHandle('v');
    mainEl.insertBefore(h3, atlasPanel);
    this.makeDragger(h3, 'x', delta => {
      const rw = rightPanel.offsetWidth + delta;
      const aw = atlasPanel.offsetWidth - delta;
      if (rw >= MIN && aw >= MIN) {
        rightPanel.style.width = `${rw}px`;
        atlasPanel.style.width = `${aw}px`;
      }
    });
  }

  // ── horizontal splitter ────────────────────────────────────────────────────

  private setupHorizontal(rootEl: HTMLElement) {
    const timelineEl = rootEl.querySelector<HTMLElement>('.timeline')!;
    const MIN = 60;

    const h = this.createHandle('h');
    rootEl.insertBefore(h, timelineEl);
    this.makeDragger(h, 'y', delta => {
      const newH = timelineEl.offsetHeight - delta;
      if (newH >= MIN) timelineEl.style.height = `${newH}px`;
    });
  }
}

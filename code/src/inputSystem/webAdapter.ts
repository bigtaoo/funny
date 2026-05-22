import { InputManager } from './inputManager';

export function setupWebInput(canvas: HTMLCanvasElement, input: InputManager) {
  canvas.addEventListener('pointerdown', (e) => {
    input.emit({ x: e.clientX, y: e.clientY, type: 'down' });
  });

  canvas.addEventListener('pointerup', (e) => {
    input.emit({ x: e.clientX, y: e.clientY, type: 'tap' });
  });
}

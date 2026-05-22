import { InputManager } from './inputManager';

export function setupWeChatInput(input: InputManager) {
  wx.onTouchStart((res) => {
    const t = res.changedTouches[0];

    input.emit({
      x: t.clientX,
      y: t.clientY,
      type: 'down',
    });
  });

  wx.onTouchEnd((res) => {
    const t = res.changedTouches[0];
    // console.log('wechat touch end x: ', t.clientX, ' y: ', t.clientY);
    input.emit({
      x: t.clientX,
      y: t.clientY,
      type: 'tap',
    });
  });
}

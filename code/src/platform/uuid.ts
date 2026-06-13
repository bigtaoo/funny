// 设备 UUID 生成 + 持久化（S0-4，Web / CrazyGames 匿名身份）。
// 同设备稳定返回同 id：首次生成落 storage，之后读回。

import type { IStorage } from './IPlatform';

const DEVICE_ID_KEY = 'nw_device_id';

/** RFC4122 v4，优先用 crypto.randomUUID，缺省回退手搓。 */
function genUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }
  // 极端回退（无 crypto）：时间 + Math.random（仅作设备 id，非安全用途）。
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 取稳定设备 id（首次生成并持久化）。 */
export function getOrCreateDeviceId(storage: IStorage): string {
  let id = storage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = genUuid();
    storage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

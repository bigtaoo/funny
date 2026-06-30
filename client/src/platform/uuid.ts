// Device UUID generation + persistence (S0-4, Web / CrazyGames anonymous identity).
// Same device always returns the same id: generated on first use and persisted to storage, then read back.

import type { IStorage } from './IPlatform';

const DEVICE_ID_KEY = 'nw_device_id';

/** RFC4122 v4 — prefers crypto.randomUUID, falls back to manual construction. */
export function genUuid(): string {
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
  // Extreme fallback (no crypto): time + Math.random (device id only, not for security purposes).
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Get stable device id (generated and persisted on first call). */
export function getOrCreateDeviceId(storage: IStorage): string {
  let id = storage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = genUuid();
    storage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

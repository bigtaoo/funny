// HeadlessPlatform — an IPlatform with no rendering, for the full-link E2E.
// Drives the real client orchestration (createAppCore) in Node:
//   - REST goes through the real ApiClient (global fetch).
//   - WS goes through the real NetClient → connectSocket here wraps Node's global
//     WebSocket and RECORDS every opened url (the assertion seam: did the client
//     open the right gateway/game endpoints, with the right query param?).
//   - getCanvas / setupInput throw — createAppCore must never touch them; if it
//     does, that's a bug the harness catches loudly.

import type {
  AuthCredential,
  IGameSocket,
  IPlatform,
  IStorage,
  ShareResult,
  SocketHandlers,
} from '../../src/platform/IPlatform';
import type { Locale } from '../../src/i18n';

class MemoryStorage implements IStorage {
  private readonly map = new Map<string, string>();
  constructor(seed?: Record<string, string>) {
    if (seed) for (const [k, v] of Object.entries(seed)) this.map.set(k, v);
  }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  snapshot(): Record<string, string> { return Object.fromEntries(this.map); }
}

/** Wraps Node's global WebSocket; mirrors BrowserGameSocket (binary, arraybuffer). */
class HeadlessSocket implements IGameSocket {
  private ws: WebSocket;
  constructor(url: string, handlers: SocketHandlers) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(ev.data));
    };
    ws.onclose = (ev: CloseEvent) => handlers.onClose(ev.code, ev.reason);
    ws.onerror = (ev: Event) => handlers.onError(ev);
  }
  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }
  close(): void {
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export interface HeadlessPlatformOpts {
  /** Seed storage (e.g. { nw_api_base, nw_token }). */
  storage?: Record<string, string>;
  /** Stable device id traded for a JWT via /auth/device (default: random per instance). */
  deviceId?: string;
  language?: string;
}

export class HeadlessPlatform implements IPlatform {
  readonly storage: IStorage;
  readonly devicePixelRatio = 1;
  readonly supportedLocales: readonly Locale[] = ['zh', 'en', 'de'];

  /** Every WS url the client asked to open, in order — the port-assertion seam. */
  readonly openedSockets: string[] = [];

  private readonly mem: MemoryStorage;
  private readonly deviceId: string;
  private readonly language: string;

  constructor(opts: HeadlessPlatformOpts = {}) {
    // Pre-seed tutorial_done inside nw_save_v1 so headless tests skip the FTUE
    // tutorial gate. The flag lives in SaveData.flags (migrate preserves extra keys).
    // Tests that explicitly want to exercise the tutorial can override via opts.storage.
    const defaultSave = JSON.stringify({ flags: { tutorial_done: true } });
    const defaultStorage: Record<string, string> = { nw_save_v1: defaultSave };
    this.mem = new MemoryStorage({ ...defaultStorage, ...opts.storage });
    this.storage = this.mem;
    this.deviceId = opts.deviceId ?? `dev-${Math.random().toString(36).slice(2)}`;
    this.language = opts.language ?? 'en';
  }

  /** Dump all persisted keys — seed another HeadlessPlatform with this to simulate
   * an app restart on the same device (token re-login keeps the persisted JWT). */
  snapshotStorage(): Record<string, string> { return this.mem.snapshot(); }

  getLanguage(): string { return this.language; }
  getScreenSize(): { width: number; height: number } { return { width: 800, height: 1280 }; }

  onAppReady(): void { /* no-op */ }
  onLoadingComplete(): Promise<void> { return Promise.resolve(); }
  onGameplayStart(): void { /* no-op */ }
  onGameplayStop(): void { /* no-op */ }
  showMidgameAd(): Promise<void> { return Promise.resolve(); }

  getAuthCredential(): Promise<AuthCredential> {
    return Promise.resolve({ kind: 'device', deviceId: this.deviceId });
  }

  connectSocket(url: string, handlers: SocketHandlers): IGameSocket {
    this.openedSockets.push(url);
    return new HeadlessSocket(url, handlers);
  }

  async shareReplay(): Promise<ShareResult> { return { method: 'native' }; }
  getLaunchShareCode(): string | null { return null; }

  // In-app recharge is not exercised in headless E2E (no store SDK / no DOM).
  iapKind(): null { return null; }
  openPaddleCheckout(): Promise<{ completed: boolean }> {
    return Promise.reject(new Error('openPaddleCheckout unsupported in headless'));
  }
  nativeIapPurchase(): Promise<{ receipt: string }> {
    return Promise.reject(new Error('nativeIapPurchase unsupported in headless'));
  }

  // ── Render-only methods the core must never call ────────────────────────────
  getCanvas(): HTMLCanvasElement {
    throw new Error('HeadlessPlatform.getCanvas() called — core leaked a render dependency');
  }
  setupInput(): void {
    throw new Error('HeadlessPlatform.setupInput() called — core leaked a render dependency');
  }
}

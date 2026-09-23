// Regression coverage for CrazyGamesPlatform.getAuthCredential() / signInWithCrazyGames()
// (RETENTION_LAUNCH_PLAN.md §1.1/§3.1 — CrazyGames portal SSO). Same minimal-DOM-stub pattern as
// crazyGamesMidgameAdTimeout.test.ts; `sdk` is overridden directly on the instance the same way that
// file does, bypassing the real SDK.init() network call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

function stubMinimalDom(): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
  });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
  vi.stubGlobal('localStorage', memStorage());
  vi.stubGlobal('navigator', { language: 'en' });
}

describe('CrazyGamesPlatform.getAuthCredential()', () => {
  beforeEach(() => {
    vi.resetModules();
    stubMinimalDom();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('already signed into the portal (getUserToken succeeds silently) → kind:crazygames, no prompt shown', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    let showAuthPromptCalled = false;
    (platform as unknown as { sdk: unknown }).sdk = {
      user: {
        getUserToken: async () => 'portal-jwt-123',
        showAuthPrompt: async () => { showAuthPromptCalled = true; return {}; },
      },
    };
    const cred = await platform.getAuthCredential();
    expect(cred).toEqual({ kind: 'crazygames', token: 'portal-jwt-123' });
    expect(showAuthPromptCalled).toBe(false); // silent check only, never prompts
  });

  it('not signed into the portal (getUserToken throws userNotAuthenticated) → falls back to device credential', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = {
      user: { getUserToken: async () => { throw { error: 'userNotAuthenticated' }; } },
    };
    const cred = await platform.getAuthCredential();
    expect(cred.kind).toBe('device');
    expect((cred as { kind: 'device'; deviceId: string }).deviceId.length).toBeGreaterThan(0);
  });

  it('no SDK at all (dev server / non-portal host) → device credential, same as before this method existed', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = null;
    const cred = await platform.getAuthCredential();
    expect(cred.kind).toBe('device');
  });
});

describe('CrazyGamesPlatform.signInWithCrazyGames()', () => {
  beforeEach(() => {
    vi.resetModules();
    stubMinimalDom();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('shows the prompt then exchanges for a token → kind:crazygames', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = {
      user: {
        showAuthPrompt: async () => ({ username: 'Ola', profilePictureUrl: '' }),
        getUserToken: async () => 'fresh-jwt',
      },
    };
    await expect(platform.signInWithCrazyGames!()).resolves.toEqual({ kind: 'crazygames', token: 'fresh-jwt' });
  });

  it('showAuthPrompt throws userAlreadySignedIn → not a failure, still exchanges for a token', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = {
      user: {
        showAuthPrompt: async () => { throw { error: 'userAlreadySignedIn' }; },
        getUserToken: async () => 'already-signed-in-jwt',
      },
    };
    await expect(platform.signInWithCrazyGames!()).resolves.toEqual({ kind: 'crazygames', token: 'already-signed-in-jwt' });
  });

  it('showAuthPrompt throws userCancelled → resolves null, no error surfaced', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = {
      user: { showAuthPrompt: async () => { throw { error: 'userCancelled' }; } },
    };
    await expect(platform.signInWithCrazyGames!()).resolves.toBeNull();
  });

  it('no SDK at all → resolves null', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    (platform as unknown as { sdk: unknown }).sdk = null;
    await expect(platform.signInWithCrazyGames!()).resolves.toBeNull();
  });
});

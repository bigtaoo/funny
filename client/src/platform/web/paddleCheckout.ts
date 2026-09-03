// Paddle.js overlay checkout — the web build's real-money payment channel (COMMERCIAL_DESIGN §IAP).
//
// Split out of WebPlatform (2026-09-03) so the whole channel is one module with one import edge,
// which is what lets the `mobile` build swap it for `platform/stubs/paddleCheckout.ts` (see the
// NormalModuleReplacementPlugin table in webpack.config.js). Inside a store build the web checkout
// must not merely be unreachable at runtime — the loader, the CDN URL and the Paddle API calls have
// no business being in the binary at all (App Review 3.1.1, and Paddle is a payment SDK we would
// otherwise be shipping undisclosed in an app that bills through StoreKit).
//
// So: everything that knows the word "Paddle" lives here. WebPlatform only holds an instance and
// forwards to it.

// ── Paddle.js type shim ─────────────────────────────────────────────────────
interface PaddleCheckoutEvent { name?: string }
interface PaddleGlobal {
  Environment?: { set(env: 'sandbox' | 'production'): void };
  Initialize(opts: { token: string; eventCallback?: (ev: PaddleCheckoutEvent) => void }): void;
  Checkout: { open(opts: { transactionId: string; settings?: { displayMode?: string } }): void };
}
const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

export class PaddleCheckout {
  /** Loaded once the token is known; re-initialized if the token (env) changes in dev. */
  private token: string | null = null;
  /** Active checkout event sink — Paddle.Initialize's single callback routes here. */
  private event: ((ev: PaddleCheckoutEvent) => void) | null = null;
  /** The in-flight open() call's resolve, if any — see its doc comment. */
  private pendingResolve: ((r: { completed: boolean }) => void) | null = null;

  async open(transactionId: string, clientToken: string): Promise<{ completed: boolean }> {
    const P = await this.load(clientToken);
    // A prior call's checkout.closed may never arrive if this is invoked again before it does (e.g. a
    // fast double-tap on a recharge tier before Paddle's overlay actually mounts, since load()
    // awaits a one-time script load on the very first call) — the shared `event` sink below is
    // about to be overwritten, which would otherwise strand that earlier call's resolve forever
    // (2026-08-03 fix). Settle it now as "not completed" rather than leave it hanging.
    this.pendingResolve?.({ completed: false });
    this.pendingResolve = null;
    return new Promise<{ completed: boolean }>((resolve) => {
      this.pendingResolve = resolve;
      let completed = false;
      this.event = (ev) => {
        if (ev.name === 'checkout.completed') completed = true;
        else if (ev.name === 'checkout.closed') {
          this.event = null;
          this.pendingResolve = null;
          resolve({ completed });
        }
      };
      P.Checkout.open({ transactionId, settings: { displayMode: 'overlay' } });
    });
  }

  /** Inject Paddle.js on first use and Initialize with the seller client token. */
  private async load(clientToken: string): Promise<PaddleGlobal> {
    const win = window as unknown as { Paddle?: PaddleGlobal };
    if (!win.Paddle) {
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector('script[data-paddle]') as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('paddle.js load failed')));
          return;
        }
        const s = document.createElement('script');
        s.src = PADDLE_JS_URL;
        s.async = true;
        s.dataset.paddle = '1';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('paddle.js load failed'));
        document.head.appendChild(s);
      });
    }
    const P = (window as unknown as { Paddle?: PaddleGlobal }).Paddle;
    if (!P) throw new Error('paddle.js unavailable after load');
    // Initialize once per token; sandbox tokens are prefixed `test_` (prod `live_`).
    if (this.token !== clientToken) {
      if (clientToken.startsWith('test_')) P.Environment?.set('sandbox');
      P.Initialize({ token: clientToken, eventCallback: (ev) => this.event?.(ev) });
      this.token = clientToken;
    }
    return P;
  }
}

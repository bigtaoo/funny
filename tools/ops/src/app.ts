// Ops admin frontend shell (OPS_DESIGN §7): login page → main shell renders navigation based on capabilities.
// The nav table and its capability filter live in src/logic/nav.ts (ADR-070 Phase 4e); this file binds
// each entry's id to the page renderer that draws it.
import { Api, ApiError } from './api';
import { clear, h } from './dom';
import {
  buildLabel, buildTitle, LOGGED_OUT_MESSAGE, type NavEntry, NO_CAPABILITIES_MESSAGE,
  SESSION_EXPIRED_MESSAGE, visibleNav, whoText,
} from './logic/nav';
import { pageAccounts, pageAnalytics, pageAppeals, pageAudit, pageAuctionAudit, pageEvents, pageFeedback, pageFlags, pageGachaPools, pageLadderSeason, pageModerationWordlist, pageMonitor, pagePaddleEvents, pagePlayer, pagePromo, pagePvpBalance, pageReports, pageSLGSeason, pageSlgShop, pageSuspicions, pageTickets } from './pages';
import type { Session } from './types';

type PageRender = (ctx: {
  api: Api;
  session: Session;
  root: HTMLElement;
  onTeardown: (fn: () => void) => void;
}) => void | Promise<void>;

/** id → renderer, keyed on logic/nav.ts's NAV_ENTRIES. A missing id renders nothing, which is why
 *  visibleNav's output is filtered through this map rather than trusted blindly. */
const RENDERERS: Record<string, PageRender> = {
  monitor: pageMonitor,
  analytics: pageAnalytics,
  'pvp-balance': pagePvpBalance,
  player: pagePlayer,
  suspicions: pageSuspicions,
  reports: pageReports,
  appeals: pageAppeals,
  feedback: pageFeedback,
  tickets: pageTickets,
  audit: pageAudit,
  'paddle-events': pagePaddleEvents,
  'slg-season': pageSLGSeason,
  'slg-audit': pageAuctionAudit,
  ladder: pageLadderSeason,
  events: pageEvents,
  'gacha-pools': pageGachaPools,
  promo: pagePromo,
  'slg-shop': pageSlgShop,
  flags: pageFlags,
  'moderation-wordlist': pageModerationWordlist,
  accounts: pageAccounts,
};

export class App {
  /** Teardown callbacks registered for the current page (run on navigation, logout, or session expiry to stop timers etc.). */
  private teardowns: (() => void)[] = [];

  constructor(
    private readonly api: Api,
    private readonly mount: HTMLElement,
  ) {
    // Mid-session 401 → tear down the current page and redirect to the login page.
    this.api.onUnauthorized = () => {
      this.runTeardowns();
      this.renderLogin(SESSION_EXPIRED_MESSAGE);
    };
  }

  private runTeardowns(): void {
    for (const fn of this.teardowns.splice(0)) {
      try {
        fn();
      } catch {
        /* teardown failure must not block navigation */
      }
    }
  }

  renderLogin(message?: string): void {
    clear(this.mount);
    const apiInput = h('input', { value: this.api.baseUrl, placeholder: 'Admin API base URL' });
    const userInput = h('input', { placeholder: 'Username' });
    const passInput = h('input', { type: 'password', placeholder: 'Password' });
    const err = h('div', { class: 'err' }, message ?? '');
    const btn = h('button', {}, 'Log in');
    const submit = async (): Promise<void> => {
      err.textContent = '';
      this.api.setBaseUrl(apiInput.value.trim());
      btn.disabled = true;
      try {
        const session = await this.api.login(userInput.value.trim(), passInput.value);
        this.renderApp(session);
      } catch (e) {
        err.textContent = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', submit);
    passInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void submit();
    });
    this.mount.append(
      h(
        'div',
        { class: 'login-wrap' },
        h('div', { class: 'card' },
          h('h2', {}, 'Notebook Wars Admin'),
          h('label', {}, 'API Base URL'), apiInput,
          h('label', {}, 'Username'), userInput,
          h('label', {}, 'Password'), passInput,
          h('div', { style: 'margin-top:12px' }, btn),
          err,
        ),
      ),
    );
  }

  renderApp(session: Session): void {
    clear(this.mount);
    const items = visibleNav(session.capabilities).filter((n) => RENDERERS[n.id]);
    const main = h('main', {});
    const navEl = h('nav', {});

    const select = (item: NavEntry): void => {
      this.runTeardowns(); // stop timers and other cleanup from the previous page
      for (const a of Array.from(navEl.children)) a.classList.toggle('active', a.getAttribute('data-id') === item.id);
      clear(main);
      const onTeardown = (fn: () => void): void => {
        this.teardowns.push(fn);
      };
      void Promise.resolve(RENDERERS[item.id]!({ api: this.api, session, root: main, onTeardown })).catch((e) => {
        main.append(h('div', { class: 'err' }, (e as Error).message));
      });
    };
    for (const item of items) {
      const a = h('a', { 'data-id': item.id, onclick: () => select(item) }, item.label);
      navEl.append(a);
    }

    const logout = h('button', { class: 'ghost', onclick: () => void this.doLogout() }, 'Log out');
    const header = h(
      'header',
      {},
      h('span', { class: 'brand' }, '🛠 Admin Panel'),
      h('span', { class: 'who' }, whoText(session.admin)),
      h('span', { class: 'build', title: buildTitle(__BUILD_TIME__) }, buildLabel(__BUILD_VERSION__)),
      logout,
    );
    this.mount.append(header, navEl, main);
    if (items[0]) select(items[0]);
    else main.append(h('div', { class: 'err' }, NO_CAPABILITIES_MESSAGE));
  }

  private async doLogout(): Promise<void> {
    this.runTeardowns();
    await this.api.logout();
    this.renderLogin(LOGGED_OUT_MESSAGE);
  }
}

// Ops admin frontend shell (OPS_DESIGN §7): login page → main shell renders navigation based on capabilities.
import { Api, ApiError } from './api';
import { clear, h } from './dom';
import { pageAccounts, pageAnalytics, pageAudit, pageAuctionAudit, pageEvents, pageFlags, pageGachaPools, pageLadderSeason, pageMonitor, pagePlayer, pageSLGSeason, pageSuspicions, pageTickets } from './pages';
import type { AdminCapability, Session } from './types';

interface NavItem {
  id: string;
  label: string;
  cap: AdminCapability;
  render: (ctx: {
    api: Api;
    session: Session;
    root: HTMLElement;
    onTeardown: (fn: () => void) => void;
  }) => void | Promise<void>;
}

const NAV: NavItem[] = [
  { id: 'monitor', label: 'Monitor', cap: 'monitor.view', render: pageMonitor },
  { id: 'analytics', label: 'Analytics', cap: 'analytics.view', render: pageAnalytics },
  { id: 'player', label: 'Player Lookup', cap: 'player.lookup', render: pagePlayer },
  { id: 'suspicions', label: 'Anti-Cheat Review', cap: 'anticheat.view', render: pageSuspicions },
  { id: 'tickets', label: 'Comp Tickets', cap: 'comp.view', render: pageTickets },
  { id: 'audit', label: 'Audit', cap: 'audit.view.self', render: pageAudit },
  { id: 'slg-season', label: 'SLG Season', cap: 'slg.season.view', render: pageSLGSeason },
  { id: 'slg-audit', label: 'SLG Audit', cap: 'slg.audit.view', render: pageAuctionAudit },
  { id: 'ladder', label: 'Ladder Season', cap: 'ladder.season.manage', render: pageLadderSeason },
  { id: 'events', label: 'Timed Events', cap: 'events.manage', render: pageEvents },
  { id: 'gacha-pools', label: 'Gacha Pools', cap: 'gacha.pools.manage', render: pageGachaPools },
  { id: 'flags', label: 'Feature Flags', cap: 'config.manage', render: pageFlags },
  { id: 'accounts', label: 'Account Mgmt', cap: 'admin.manage', render: pageAccounts },
];

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
      this.renderLogin('Session expired. Please log in again.');
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
    const items = NAV.filter((n) => session.capabilities.includes(n.cap));
    const main = h('main', {});
    const navEl = h('nav', {});

    const select = (item: NavItem): void => {
      this.runTeardowns(); // stop timers and other cleanup from the previous page
      for (const a of Array.from(navEl.children)) a.classList.toggle('active', a.getAttribute('data-id') === item.id);
      clear(main);
      const onTeardown = (fn: () => void): void => {
        this.teardowns.push(fn);
      };
      void Promise.resolve(item.render({ api: this.api, session, root: main, onTeardown })).catch((e) => {
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
      h('span', { class: 'who' }, `${session.admin.displayName} · ${session.admin.role}`),
      h('span', { class: 'build', title: `Built at ${__BUILD_TIME__} (UTC)` }, `v ${__BUILD_VERSION__}`),
      logout,
    );
    this.mount.append(header, navEl, main);
    if (items[0]) select(items[0]);
    else main.append(h('div', { class: 'err' }, 'This account has no visible capabilities. Contact a super-admin.'));
  }

  private async doLogout(): Promise<void> {
    this.runTeardowns();
    await this.api.logout();
    this.renderLogin('Logged out.');
  }
}

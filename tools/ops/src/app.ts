// 运维后台前端壳（OPS_DESIGN §7）：登录页 → 主框架按 capabilities 渲染导航。
import { Api, ApiError } from './api';
import { clear, h } from './dom';
import { pageAccounts, pageAnalytics, pageAudit, pageMonitor, pagePlayer, pageSuspicions, pageTickets } from './pages';
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
  { id: 'monitor', label: '监控', cap: 'monitor.view', render: pageMonitor },
  { id: 'analytics', label: '数据分析', cap: 'analytics.view', render: pageAnalytics },
  { id: 'player', label: '玩家查询', cap: 'player.lookup', render: pagePlayer },
  { id: 'suspicions', label: '反作弊审查', cap: 'anticheat.view', render: pageSuspicions },
  { id: 'tickets', label: '补偿工单', cap: 'comp.view', render: pageTickets },
  { id: 'audit', label: '审计', cap: 'audit.view.self', render: pageAudit },
  { id: 'accounts', label: '账号管理', cap: 'admin.manage', render: pageAccounts },
];

export class App {
  /** 当前页面注册的清理回调（导航/登出/会话失效时执行，停掉定时器等）。 */
  private teardowns: (() => void)[] = [];

  constructor(
    private readonly api: Api,
    private readonly mount: HTMLElement,
  ) {
    // 会话中途 401 → 清理当前页 + 弹回登录页。
    this.api.onUnauthorized = () => {
      this.runTeardowns();
      this.renderLogin('会话已过期，请重新登录。');
    };
  }

  private runTeardowns(): void {
    for (const fn of this.teardowns.splice(0)) {
      try {
        fn();
      } catch {
        /* 清理失败不应阻断导航 */
      }
    }
  }

  renderLogin(message?: string): void {
    clear(this.mount);
    const apiInput = h('input', { value: this.api.baseUrl, placeholder: 'admin API 基址' });
    const userInput = h('input', { placeholder: '用户名' });
    const passInput = h('input', { type: 'password', placeholder: '密码' });
    const err = h('div', { class: 'err' }, message ?? '');
    const btn = h('button', {}, '登录');
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
          h('h2', {}, 'Notebook Wars 运维后台'),
          h('label', {}, 'API 基址'), apiInput,
          h('label', {}, '用户名'), userInput,
          h('label', {}, '密码'), passInput,
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
      this.runTeardowns(); // 停掉上一页的定时器等
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

    const logout = h('button', { class: 'ghost', onclick: () => void this.doLogout() }, '退出');
    const header = h(
      'header',
      {},
      h('span', { class: 'brand' }, '🛠 运维后台'),
      h('span', { class: 'who' }, `${session.admin.displayName} · ${session.admin.role}`),
      logout,
    );
    this.mount.append(header, navEl, main);
    if (items[0]) select(items[0]);
    else main.append(h('div', { class: 'err' }, '当前账号无任何可见能力，请联系超管。'));
  }

  private async doLogout(): Promise<void> {
    this.runTeardowns();
    await this.api.logout();
    this.renderLogin('已退出。');
  }
}

// 运维后台前端入口（OPS_DESIGN §7）。持久化 token 续登：有 token 先 me() 验活，过期回登录页。
import { Api } from './api';
import { App } from './app';

async function main(): Promise<void> {
  const mount = document.getElementById('root');
  if (!mount) return;
  const api = new Api();
  const app = new App(api, mount);

  if (api.hasToken) {
    try {
      const { admin, capabilities } = await api.me();
      app.renderApp({ token: '', admin, capabilities });
      return;
    } catch {
      api.setToken(null);
    }
  }
  app.renderLogin();
}

void main();

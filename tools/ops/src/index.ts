// Ops admin frontend entry point (OPS_DESIGN §7). Persistent-token re-login: if a token exists, validate it via me() first; redirect to login on expiry.
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

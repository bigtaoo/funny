// Bots log in exactly like a real Web/CrazyGames client: metaserver's public anonymous device-login
// (contracts/openapi.yml POST /auth/device), no bot-specific account API (BOTSVC_DESIGN §3.1/B2).
export interface DeviceLoginResult {
  token: string;
  accountId: string;
  isNew: boolean;
  gatewayUrl?: string;
}

export class MetaClient {
  constructor(private readonly baseUrl: string) {}

  async deviceLogin(deviceId: string): Promise<DeviceLoginResult> {
    const res = await fetch(`${this.baseUrl}/auth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) throw new Error(`device-login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { ok: boolean; data: DeviceLoginResult };
    if (!body.ok) throw new Error('device-login: server returned ok:false');
    return body.data;
  }
}

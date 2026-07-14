// Family join/leave (BOTSVC_DESIGN §3.3): public /social/* REST, same as any real client — auth is the
// bot's own player JWT from metaserver device-login, not the internal key.
export interface FamilyView {
  familyId: string;
  tag: string;
  memberCount: number;
  prosperity: number;
}

export class SocialClient {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json()) as { ok: boolean; data?: T; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? `social call failed: ${method} ${path}`);
    return parsed.data as T;
  }

  myFamily(token: string): Promise<FamilyView | null> {
    return this.call<FamilyView | null>('GET', '/social/family/mine', token);
  }

  /** Returns a small sample of open families to pick from; empty search term matches broadly. */
  searchFamilies(token: string, tag: string): Promise<FamilyView[]> {
    return this.call<FamilyView[]>('GET', `/social/family/search?tag=${encodeURIComponent(tag)}`, token);
  }

  joinFamily(token: string, tag: string): Promise<void> {
    return this.call<void>('POST', `/social/family/${encodeURIComponent(tag)}/join`, token);
  }

  leaveFamily(token: string): Promise<void> {
    return this.call<void>('POST', '/social/family/leave', token);
  }
}

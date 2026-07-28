import { fetchInternalJson, type EventDoc, type EventInput } from '@nw/shared';

// ── Limited-time event management (meta /admin/events, B6 events.manage) ────────
export interface EventsClient {
  readonly available: boolean;
  list(): Promise<EventDoc[]>;
  create(input: EventInput): Promise<EventDoc>;
  update(eventId: string, input: EventInput): Promise<EventDoc>;
  remove(eventId: string): Promise<void>;
}

/** Business error returned by meta (detail lets operators see the validation reason); admin httpApi responds with 4xx accordingly. */
export class EventsClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EventsClientError';
  }
}

export class HttpEventsClient implements EventsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(): Promise<EventDoc[]> {
    if (!this.metaBaseUrl) return [];
    const r = await fetchInternalJson<{ events?: EventDoc[] }>(`${this.metaBaseUrl}/admin/events`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta /admin/events',
    });
    // status 0 = network error / timeout → surface as 502 so the ops frontend sees the failure.
    if (!r.ok) throw new EventsClientError(r.status || 502, `list events ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.events ?? [];
  }

  async create(input: EventInput): Promise<EventDoc> {
    return this.write('POST', '/admin/events', input);
  }
  async update(eventId: string, input: EventInput): Promise<EventDoc> {
    return this.write('PATCH', `/admin/events/${encodeURIComponent(eventId)}`, input);
  }
  async remove(eventId: string): Promise<void> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const path = `/admin/events/${encodeURIComponent(eventId)}`;
    const r = await fetchInternalJson<{ detail?: string; error?: string }>(`${this.metaBaseUrl}${path}`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'DELETE',
      timeoutMs: 10000,
      label: `meta DELETE ${path}`,
    });
    if (!r.ok) {
      throw new EventsClientError(r.status || 502, r.body?.detail ?? r.body?.error ?? r.error ?? `delete event HTTP ${r.status}`);
    }
  }

  private async write(method: 'POST' | 'PATCH', path: string, input: EventInput): Promise<EventDoc> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const r = await fetchInternalJson<{ event?: EventDoc; detail?: string; error?: string }>(`${this.metaBaseUrl}${path}`, {
      caller: 'admin',
      key: this.internalKey,
      method,
      body: input,
      timeoutMs: 10000,
      label: `meta ${method} ${path}`,
    });
    if (!r.ok || !r.body?.event) {
      throw new EventsClientError(r.status || 502, r.body?.detail ?? r.body?.error ?? r.error ?? `${path} HTTP ${r.status}`);
    }
    return r.body.event;
  }
}

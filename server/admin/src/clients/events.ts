import { internalHeaders, type EventDoc, type EventInput } from '@nw/shared';

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
    const res = await fetch(`${this.metaBaseUrl}/admin/events`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list events HTTP ${res.status}`);
    const body = (await res.json()) as { events?: EventDoc[] };
    return body.events ?? [];
  }

  async create(input: EventInput): Promise<EventDoc> {
    return this.write('POST', '/admin/events', input);
  }
  async update(eventId: string, input: EventInput): Promise<EventDoc> {
    return this.write('PATCH', `/admin/events/${encodeURIComponent(eventId)}`, input);
  }
  async remove(eventId: string): Promise<void> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
      throw new EventsClientError(res.status, body.detail ?? body.error ?? `delete event HTTP ${res.status}`);
    }
  }

  private async write(method: string, path: string, input: EventInput): Promise<EventDoc> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as { event?: EventDoc; detail?: string; error?: string };
    if (!res.ok || !body.event) {
      throw new EventsClientError(res.status, body.detail ?? body.error ?? `${path} HTTP ${res.status}`);
    }
    return body.event;
  }
}

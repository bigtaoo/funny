// Time-limited event management (B6, events.manage). Proxies the meta events store + audit.
import type { EventDoc, EventInput } from '@nw/shared';
import type { Actor, AdminBaseCtor, Constructor } from './base';

export interface EventsHandlers {
  listEvents(): Promise<EventDoc[]>;
  createEvent(actor: Actor, input: EventInput): Promise<EventDoc>;
  updateEvent(actor: Actor, eventId: string, input: EventInput): Promise<EventDoc>;
  deleteEvent(actor: Actor, eventId: string): Promise<void>;
}

export function EventsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<EventsHandlers> {
  return class extends Base {
    // ───────────────────── Time-limited event management (B6, events.manage) ──────────────────
    /** List all event definitions (including not-yet-started and ended). Returns empty if meta is unreachable. */
    async listEvents(): Promise<EventDoc[]> {
      if (!this.events.available) return [];
      return this.events.list();
    }

    /** Create an event; validation failure on the meta side throws EventsClientError (httpApi maps to 4xx). Audited. */
    async createEvent(actor: Actor, input: EventInput): Promise<EventDoc> {
      const ev = await this.events.create(input);
      await this.audit(actor.adminId, 'event.create', { target: ev._id, summary: ev.title });
      return ev;
    }

    /** Full replacement of an event definition. Audited. */
    async updateEvent(actor: Actor, eventId: string, input: EventInput): Promise<EventDoc> {
      const ev = await this.events.update(eventId, input);
      await this.audit(actor.adminId, 'event.update', { target: ev._id, summary: ev.title });
      return ev;
    }

    /** Delete an event definition. Audited. */
    async deleteEvent(actor: Actor, eventId: string): Promise<void> {
      await this.events.remove(eventId);
      await this.audit(actor.adminId, 'event.delete', { target: eventId });
    }
  };
}

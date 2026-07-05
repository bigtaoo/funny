// Time-limited event management (B6, admin events.manage; ADR-014). Player-facing GET /events only returns
// events within the active window; these endpoints let the ops backend list/create/edit/delete all events.
import type { FastifyInstance } from 'fastify';
import { createLogger, type EventInput } from '@nw/shared';
import { adminListEvents, adminCreateEvent, adminUpdateEvent, adminDeleteEvent } from '../events.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

export function registerEventAdminRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now } = ctx;

  // GET /admin/events — all events (including not-yet-started and ended).
  app.get('/admin/events', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const events = await adminListEvents(cols);
    return reply.send({ ok: true, events });
  });
  // POST /admin/events — create an event. body = EventInput.
  app.post('/admin/events', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const r = await adminCreateEvent(cols, req.body as EventInput, now());
    if (!r.ok) {
      const code = r.error === 'DUPLICATE_ID' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: r.error, detail: r.detail });
    }
    log.info('POST /admin/events', { eventId: r.event._id });
    return reply.send({ ok: true, event: r.event });
  });
  // PATCH /admin/events/:id — full replacement of event definition. body = EventInput.
  app.patch('/admin/events/:id', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const r = await adminUpdateEvent(cols, id, req.body as EventInput);
    if (!r.ok) {
      const code = r.error === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: r.error, detail: r.detail });
    }
    log.info('PATCH /admin/events/:id', { eventId: id });
    return reply.send({ ok: true, event: r.event });
  });
  // DELETE /admin/events/:id — delete event definition (participation history is retained).
  app.delete('/admin/events/:id', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const r = await adminDeleteEvent(cols, id);
    if (!r.ok) return reply.code(404).send({ ok: false, error: r.error });
    log.info('DELETE /admin/events/:id', { eventId: id });
    return reply.send({ ok: true });
  });
}

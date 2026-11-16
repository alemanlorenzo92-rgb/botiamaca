import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import type { BusEvent } from '../../core/events.js';
import { can, requireUser, type AuthUser } from '../auth.js';

function visible(user: AuthUser, event: BusEvent): boolean {
  switch (event.type) {
    case 'whatsapp.status':
      return can(user, 'whatsapp') || can(user, 'inbox');
    case 'followup.due':
      return can(user, 'followups');
    default:
      return can(user, 'inbox');
  }
}

/** Server-Sent Events para refrescar el panel en vivo. */
export function registerEventsRoute(c: Container) {
  return async (app: FastifyInstance) => {
    app.get('/events', async (request, reply) => {
      const user = requireUser(request);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const send = (event: BusEvent) => {
        if (visible(user, event)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = c.bus.subscribe(send);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });
  };
}

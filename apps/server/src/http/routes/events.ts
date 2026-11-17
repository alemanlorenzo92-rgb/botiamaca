import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import type { BusEvent } from '../../core/events.js';
import { SESSION_COOKIE, can, requireUser, type AuthUser } from '../auth.js';

const REVALIDATE_MS = 25_000;

/** Qué ve cada usuario: el QR de vinculación solo con permiso de WhatsApp. */
export function projectEvent(user: AuthUser, event: BusEvent): BusEvent | null {
  switch (event.type) {
    case 'whatsapp.status':
      if (can(user, 'whatsapp')) return event;
      return can(user, 'inbox') ? { type: event.type, status: event.status } : null;
    case 'followup.due':
      return can(user, 'followups') ? event : null;
    default:
      return can(user, 'inbox') ? event : null;
  }
}

/** Server-Sent Events para refrescar el panel en vivo. */
export function registerEventsRoute(c: Container) {
  return async (app: FastifyInstance) => {
    const open = new Set<ServerResponse>();
    app.addHook('preClose', async () => {
      for (const res of open) res.end();
    });

    app.get('/events', async (request, reply) => {
      let user = requireUser(request);
      const token = request.cookies[SESSION_COOKIE];
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      open.add(res);
      const send = (event: BusEvent) => {
        const visible = projectEvent(user, event);
        if (visible) res.write(`event: ${visible.type}\ndata: ${JSON.stringify(visible)}\n\n`);
      };
      const unsubscribe = c.bus.subscribe(send);
      // Revalida la sesión: logout, usuario desactivado o permisos cambiados cortan o ajustan el stream.
      const heartbeat = setInterval(() => {
        void c.auth
          .fromToken(token)
          .catch(() => null)
          .then((fresh) => {
            if (!fresh) return res.end();
            user = fresh;
            res.write(': ping\n\n');
          });
      }, REVALIDATE_MS);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        open.delete(res);
      };
      request.raw.on('close', cleanup);
      res.on('close', cleanup);
    });
  };
}

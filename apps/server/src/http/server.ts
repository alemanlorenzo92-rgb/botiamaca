import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { InvalidTransitionError } from '../conversations/handoff.service.js';
import type { Container } from '../container.js';
import { HttpError, SESSION_COOKIE } from './auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerEventsRoute } from './routes/events.js';
import { registerSalesRoutes } from './routes/sales.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export interface ServerOptions {
  /** Carpeta del panel exportado (Next.js `out`). */
  panelDir?: string;
}

export async function buildServer(c: Container, options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: c.logger as FastifyBaseLogger, trustProxy: true, bodyLimit: 1024 * 1024 });
  const publicUrl = new URL(c.env.PUBLIC_URL);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    request.user = await c.auth.fromToken(request.cookies[SESSION_COOKIE]);
    // Defensa CSRF: las mutaciones solo se aceptan desde el mismo origen del panel.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && origin !== publicUrl.origin && c.env.NODE_ENV === 'production') {
        throw new HttpError(403, 'Origen no permitido');
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.message });
    if (error instanceof InvalidTransitionError) return reply.status(409).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
    request.log.error({ err: error }, 'error no controlado');
    return reply.status(500).send({ error: 'Error interno' });
  });

  app.get('/health', async () => {
    await c.db.$queryRaw`SELECT 1`;
    return { ok: true, whatsapp: c.gateway?.getStatus().status ?? 'DISABLED' };
  });

  await app.register(registerWebhookRoutes(c));
  await app.register(
    async (api) => {
      await api.register(registerAuthRoutes(c));
      await api.register(registerConversationRoutes(c));
      await api.register(registerCatalogRoutes(c));
      await api.register(registerSalesRoutes(c));
      await api.register(registerAdminRoutes(c));
      await api.register(registerEventsRoute(c));
    },
    { prefix: '/api' },
  );

  const panelDir = options.panelDir ?? resolve(process.cwd(), '../panel/out');
  if (existsSync(panelDir)) {
    await app.register(fastifyStatic, { root: panelDir, extensions: ['html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'No encontrado' });
    });
  }

  return app;
}

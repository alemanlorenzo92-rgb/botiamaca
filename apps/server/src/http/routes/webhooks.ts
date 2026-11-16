import type { FastifyInstance } from 'fastify';
import { WebhookSignatureError } from '../../catalog/tiendanube-webhook.js';
import type { Container } from '../../container.js';

export function registerWebhookRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    // La firma se calcula sobre el body crudo: este scope no parsea JSON.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));

    app.post('/webhooks/tiendanube', async (request, reply) => {
      if (!c.webhooks.isConfigured()) return reply.status(503).send({ error: 'Tiendanube no está configurado' });
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const header = request.headers['x-linkedstore-hmac-sha256'];
      try {
        const result = await c.webhooks.receive(raw, Array.isArray(header) ? header[0] : header);
        if (result.status === 'accepted') {
          // Se responde enseguida; el producto se re-consulta a la API en segundo plano.
          void c.webhooks.process(result.eventId).catch((err: unknown) => request.log.error({ err }, 'webhook'));
        }
        return { ok: true, status: result.status };
      } catch (error) {
        if (error instanceof WebhookSignatureError) return reply.status(401).send({ error: error.message });
        throw error;
      }
    });
  };
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError, requirePermission, requireUser } from '../auth.js';
import { parse } from '../validate.js';

export function registerCatalogRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requirePermission('catalog'));

    app.get('/catalog/products', async (request) => {
      const q = parse(
        z.object({
          q: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        request.query,
      );
      const where = {
        deletedAt: null,
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
      };
      const [products, total] = await Promise.all([
        c.db.product.findMany({
          where,
          orderBy: { name: 'asc' },
          take: q.limit,
          skip: q.offset,
          include: {
            variants: {
              where: { deletedAt: null },
              include: { inventory: true, prices: { where: { validTo: null }, include: { priceList: true } } },
            },
          },
        }),
        c.db.product.count({ where }),
      ]);
      return { products, total };
    });

    app.get('/catalog/status', async () => {
      const [lastRun, lastOk, products, integration, pendingWebhooks] = await Promise.all([
        c.db.syncRun.findFirst({ where: { provider: 'tiendanube' }, orderBy: { startedAt: 'desc' } }),
        c.catalog.lastSync(),
        c.db.product.count({ where: { deletedAt: null } }),
        c.db.integrationSetting.findUnique({ where: { provider: 'tiendanube' } }),
        c.db.webhookEvent.count({ where: { provider: 'tiendanube', processedAt: null } }),
      ]);
      return {
        configured: c.catalogSync.isConfigured(),
        webhooksConfigured: c.webhooks.isConfigured(),
        lastRun,
        lastOk,
        products,
        integration,
        pendingWebhooks,
      };
    });

    app.post('/catalog/sync', async (request) => {
      const user = requireUser(request);
      if (!c.catalogSync.isConfigured()) throw new HttpError(409, 'Tiendanube no está configurado');
      await c.audit.log({ actorType: 'USER', actorId: user.id, action: 'catalog.sync_requested' });
      void c.catalogSync.syncAll().catch((err: unknown) => request.log.error({ err }, 'sincronización manual falló'));
      return { ok: true };
    });
  };
}

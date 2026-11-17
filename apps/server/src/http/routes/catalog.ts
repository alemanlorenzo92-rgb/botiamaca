import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requirePermission } from '../auth.js';
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

  };
}

import multipart from '@fastify/multipart';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CatalogNotFoundError } from '../../catalog/catalog-admin.service.js';
import type { Container } from '../../container.js';
import { MediaError } from '../../media/media.service.js';
import { HttpError, requirePermission, requireUser } from '../auth.js';
import { parse } from '../validate.js';

const id = z.string().uuid();
const optText = (max: number) => z.string().max(max).nullable().optional();
const faqs = z.array(z.object({ q: z.string().max(300), a: z.string().max(2000) })).max(50);
const service = z.enum(['GLITTER_BAR', 'SHIMMER_WALL']);
const money = z.number().nonnegative().max(1e10).nullable().optional();

const productBody = z.object({
  name: z.string().min(1).max(200),
  description: optText(5000),
  features: optText(3000),
  usage: optText(3000),
  recommendations: optText(3000),
  faqs: faqs.optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  brand: optText(120),
  url: z.string().url().max(500).nullable().optional(),
  published: z.boolean().optional(),
  categoryIds: z.array(id).max(20).optional(),
  variants: z
    .array(
      z.object({
        id: id.nullable().optional(),
        values: z.array(z.string().min(1).max(60)).max(5),
        sku: optText(80),
        retailPrice: money,
        wholesalePrice: money,
        stock: z.number().int().min(0).max(1e7).nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
});

const mediaFields = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  isTutorial: z.boolean().optional(),
  active: z.boolean().optional(),
  productId: id.nullable().optional(),
  categoryId: id.nullable().optional(),
  service: service.nullable().optional(),
});

const tutorialBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10000).optional(),
  productId: id.nullable().optional(),
  categoryId: id.nullable().optional(),
  service: service.nullable().optional(),
  mediaIds: z.array(id).max(20).optional(),
  active: z.boolean().optional(),
});

function mediaHttpError(error: unknown): never {
  if (error instanceof MediaError) throw new HttpError(error.code === 'NOT_FOUND' ? 404 : 400, error.message);
  if (error instanceof CatalogNotFoundError) throw new HttpError(404, error.message);
  throw error;
}

/** Biblioteca comercial propia: productos, categorías, servicios, fotos/videos y tutoriales. */
export function registerCatalogRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requirePermission('catalog'));
    await app.register(multipart, {
      limits: { fileSize: Math.max(c.env.MEDIA_MAX_IMAGE_MB, c.env.MEDIA_MAX_VIDEO_MB) * 1024 * 1024, files: 1, fields: 20 },
    });

    const audit = (request: Parameters<typeof requireUser>[0], action: string, entityType: string, entityId: string, data?: Prisma.InputJsonObject) =>
      c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action, entityType, entityId, data });

    // --- Productos ---
    app.get('/catalog/products', async (request) => {
      const q = parse(
        z.object({
          q: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        request.query,
      );
      const where = { deletedAt: null, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
      const [products, total] = await Promise.all([
        c.db.product.findMany({
          where,
          orderBy: { name: 'asc' },
          take: q.limit,
          skip: q.offset,
          include: {
            categories: { include: { category: { select: { id: true, name: true } } } },
            _count: { select: { media: true } },
            variants: {
              where: { deletedAt: null },
              orderBy: { id: 'asc' },
              include: { inventory: true, prices: { where: { validTo: null }, include: { priceList: true } } },
            },
          },
        }),
        c.db.product.count({ where }),
      ]);
      return { products, total };
    });

    app.post('/catalog/products', async (request) => {
      const body = parse(productBody, request.body);
      const product = await c.catalogAdmin.createProduct(body);
      await audit(request, 'product.created', 'product', product.id, { name: product.name });
      return { product };
    });

    app.patch('/catalog/products/:id', async (request) => {
      const { id: productId } = parse(z.object({ id }), request.params);
      const body = parse(productBody.partial(), request.body);
      const product = await c.catalogAdmin.updateProduct(productId, body).catch(mediaHttpError);
      await audit(request, 'product.updated', 'product', productId, { fields: Object.keys(body) });
      return { product };
    });

    app.delete('/catalog/products/:id', async (request) => {
      const { id: productId } = parse(z.object({ id }), request.params);
      await c.catalogAdmin.deleteProduct(productId);
      await audit(request, 'product.deleted', 'product', productId);
      return { ok: true };
    });

    // --- Categorías ---
    app.get('/catalog/categories', async () => ({
      categories: await c.db.category.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } }),
    }));

    app.post('/catalog/categories', async (request) => {
      const body = parse(z.object({ id: id.optional(), name: z.string().min(1).max(120), description: optText(1000), visible: z.boolean().optional() }), request.body);
      const category = await c.catalogAdmin.saveCategory(body);
      await audit(request, body.id ? 'category.updated' : 'category.created', 'category', category.id);
      return { category };
    });

    app.delete('/catalog/categories/:id', async (request) => {
      const { id: categoryId } = parse(z.object({ id }), request.params);
      await c.catalogAdmin.deleteCategory(categoryId);
      await audit(request, 'category.deleted', 'category', categoryId);
      return { ok: true };
    });

    // --- Servicios ---
    app.get('/catalog/services', async () => ({ services: await c.services.list() }));

    app.patch('/catalog/services/:service', async (request) => {
      const { service: code } = parse(z.object({ service }), request.params);
      const body = parse(
        z.object({
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(5000).optional(),
          conditions: z.string().max(5000).optional(),
          faqs: faqs.optional(),
          info: z.record(z.string(), z.unknown()).optional(),
          active: z.boolean().optional(),
        }),
        request.body,
      );
      const saved = await c.services.update(code, body);
      await audit(request, 'service.updated', 'service', code, { fields: Object.keys(body) });
      return { service: saved };
    });

    // --- Biblioteca multimedia ---
    app.get('/media', async (request) => {
      const q = parse(
        z.object({
          q: z.string().max(100).optional(),
          kind: z.enum(['IMAGE', 'VIDEO']).optional(),
          active: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
        request.query,
      );
      const media = await c.db.mediaAsset.findMany({
        where: {
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.active ? { active: q.active === 'true' } : {}),
          ...(q.q ? { searchText: { contains: q.q.toLowerCase() } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        include: { product: { select: { id: true, name: true } }, category: { select: { id: true, name: true } } },
      });
      return { media };
    });

    app.post('/media', async (request) => {
      const file = await request.file();
      if (!file) throw new HttpError(400, 'Falta el archivo');
      const data = await file.toBuffer().catch(() => {
        throw new HttpError(413, 'El archivo es demasiado grande');
      });
      const raw = Object.fromEntries(
        Object.entries(file.fields)
          .filter(([k]) => k !== 'file')
          .map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : undefined]),
      ) as Record<string, string | undefined>;
      const fields = parse(mediaFields, {
        title: raw.title,
        description: raw.description,
        tags: raw.tags ? raw.tags.split(',') : undefined,
        isTutorial: raw.isTutorial === 'true',
        productId: raw.productId || undefined,
        categoryId: raw.categoryId || undefined,
        service: raw.service || undefined,
      });
      const result = await c.media.upload({ data, originalName: file.filename, fields }).catch(mediaHttpError);
      if (!result.duplicate) await audit(request, 'media.uploaded', 'media', result.asset.id, { name: file.filename });
      return result;
    });

    app.patch('/media/:id', async (request) => {
      const { id: mediaId } = parse(z.object({ id }), request.params);
      const body = parse(mediaFields, request.body);
      const asset = await c.media.update(mediaId, body);
      await audit(request, 'media.updated', 'media', mediaId, { fields: Object.keys(body) });
      return { asset };
    });

    app.delete('/media/:id', async (request) => {
      const { id: mediaId } = parse(z.object({ id }), request.params);
      await c.media.remove(mediaId);
      await audit(request, 'media.deleted', 'media', mediaId);
      return { ok: true };
    });

    app.get('/media/:id/file', async (request, reply) => {
      const { id: mediaId } = parse(z.object({ id }), request.params);
      const { asset, data } = await c.media.load(mediaId).catch(mediaHttpError);
      return reply.header('content-type', asset.mime).header('cache-control', 'private, max-age=3600').send(data);
    });

    // --- Tutoriales ---
    app.get('/tutorials', async () => ({
      tutorials: await c.db.tutorial.findMany({
        orderBy: { updatedAt: 'desc' },
        include: { media: { select: { id: true, kind: true, title: true } }, product: { select: { id: true, name: true } } },
      }),
    }));

    app.post('/tutorials', async (request) => {
      const body = parse(tutorialBody.extend({ id: id.optional() }), request.body);
      const tutorial = await c.catalogAdmin.saveTutorial(body.id ?? null, body);
      await audit(request, body.id ? 'tutorial.updated' : 'tutorial.created', 'tutorial', tutorial.id);
      return { tutorial };
    });

    app.delete('/tutorials/:id', async (request) => {
      const { id: tutorialId } = parse(z.object({ id }), request.params);
      await c.db.tutorial.delete({ where: { id: tutorialId } });
      await audit(request, 'tutorial.deleted', 'tutorial', tutorialId);
      return { ok: true };
    });
  };
}

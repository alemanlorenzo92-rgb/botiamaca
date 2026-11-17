import { Prisma, type PrismaClient } from '@prisma/client';
import type { Logger } from '../core/logger.js';
import { normalize, stripHtml } from '../core/text.js';
import { pickI18n, type TiendanubeClient, type TnProduct } from './tiendanube.client.js';

export const RETAIL_PRICE_LIST = 'retail';
export const WHOLESALE_PRICE_LIST = 'wholesale';
const PROVIDER = 'tiendanube';

export class CatalogSyncService {
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly client: TiendanubeClient | null,
    private readonly logger: Logger,
  ) {}

  isConfigured() {
    return !!this.client;
  }

  private async retailListId(): Promise<string> {
    const list = await this.db.priceList.upsert({
      where: { code: RETAIL_PRICE_LIST },
      create: { code: RETAIL_PRICE_LIST, name: 'Minorista (Tiendanube)', source: PROVIDER },
      update: {},
    });
    return list.id;
  }

  async upsertProduct(tn: TnProduct, retailListId?: string): Promise<void> {
    const listId = retailListId ?? (await this.retailListId());
    const name = pickI18n(tn.name);
    const description = stripHtml(pickI18n(tn.description));
    const tags = (tn.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const attributes = (tn.attributes ?? []).map(pickI18n).filter(Boolean);
    const variantValues = tn.variants.flatMap((v) => v.values.map(pickI18n));
    const searchText = normalize([name, description, tn.brand ?? '', ...tags, ...variantValues].join(' '));
    const images = [...(tn.images ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((i) => i.src);
    const now = new Date();

    await this.db.$transaction(async (tx) => {
      const product = await tx.product.upsert({
        where: { externalId: String(tn.id) },
        create: {
          externalId: String(tn.id),
          name,
          description,
          handle: pickI18n(tn.handle) || null,
          url: tn.canonical_url ?? null,
          brand: tn.brand ?? null,
          tags,
          attributes,
          imageUrls: images.slice(0, 5),
          published: tn.published,
          freeShipping: !!tn.free_shipping,
          searchText,
          sourceUpdatedAt: tn.updated_at ? new Date(tn.updated_at) : null,
          syncedAt: now,
        },
        update: {
          name,
          description,
          handle: pickI18n(tn.handle) || null,
          url: tn.canonical_url ?? null,
          brand: tn.brand ?? null,
          tags,
          attributes,
          imageUrls: images.slice(0, 5),
          published: tn.published,
          freeShipping: !!tn.free_shipping,
          searchText,
          sourceUpdatedAt: tn.updated_at ? new Date(tn.updated_at) : null,
          syncedAt: now,
          deletedAt: null,
        },
      });

      if (tn.categories) {
        const cats = await tx.category.findMany({ where: { externalId: { in: tn.categories.map((c) => String(c.id)) } } });
        await tx.productCategory.deleteMany({ where: { productId: product.id } });
        if (cats.length) {
          await tx.productCategory.createMany({ data: cats.map((c) => ({ productId: product.id, categoryId: c.id })) });
        }
      }

      const seen: string[] = [];
      for (const v of tn.variants) {
        seen.push(String(v.id));
        const variant = await tx.productVariant.upsert({
          where: { externalId: String(v.id) },
          create: {
            externalId: String(v.id),
            productId: product.id,
            sku: v.sku,
            values: v.values.map(pickI18n).filter(Boolean),
            weightKg: v.weight ? new Prisma.Decimal(v.weight) : null,
            syncedAt: now,
          },
          update: {
            productId: product.id,
            sku: v.sku,
            values: v.values.map(pickI18n).filter(Boolean),
            weightKg: v.weight ? new Prisma.Decimal(v.weight) : null,
            syncedAt: now,
            deletedAt: null,
          },
        });

        await tx.inventory.upsert({
          where: { variantId: variant.id },
          create: { variantId: variant.id, managed: v.stock_management, quantity: v.stock_management ? (v.stock ?? 0) : null, syncedAt: now },
          update: { managed: v.stock_management, quantity: v.stock_management ? (v.stock ?? 0) : null, syncedAt: now },
        });

        const effective = v.promotional_price && Number(v.promotional_price) > 0 ? v.promotional_price : v.price;
        const current = await tx.variantPrice.findFirst({ where: { variantId: variant.id, priceListId: listId, validTo: null } });
        const same = current && effective !== null && current.amount.equals(new Prisma.Decimal(effective));
        if (!same) {
          if (current) await tx.variantPrice.update({ where: { id: current.id }, data: { validTo: now } });
          if (effective !== null && Number(effective) > 0) {
            await tx.variantPrice.create({
              data: { variantId: variant.id, priceListId: listId, amount: new Prisma.Decimal(effective), validFrom: now },
            });
          }
        }
      }
      await tx.productVariant.updateMany({
        where: { productId: product.id, externalId: { notIn: seen }, deletedAt: null },
        data: { deletedAt: now },
      });
    });
  }

  async markProductDeleted(externalId: string): Promise<void> {
    await this.db.product.updateMany({ where: { externalId }, data: { deletedAt: new Date() } });
  }

  async syncProduct(externalId: string): Promise<'updated' | 'deleted'> {
    if (!this.client) throw new Error('Tiendanube no está configurado');
    const product = await this.client.getProduct(externalId);
    if (!product) {
      await this.markProductDeleted(externalId);
      return 'deleted';
    }
    await this.upsertProduct(product);
    return 'updated';
  }

  /** Espera a que termine la sincronización completa en curso (para no pisar datos más nuevos). */
  async idle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** Sincronización completa. Si ya hay una corriendo, espera esa. */
  syncAll(): Promise<unknown> {
    if (!this.running) {
      this.running = this.doSyncAll().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doSyncAll() {
    if (!this.client) throw new Error('Tiendanube no está configurado');
    const run = await this.db.syncRun.create({ data: { provider: PROVIDER, kind: 'full', status: 'RUNNING' } });
    const startedAt = new Date();
    try {
      const categories = await this.client.listCategories();
      for (const c of categories) {
        await this.db.category.upsert({
          where: { externalId: String(c.id) },
          create: { externalId: String(c.id), name: pickI18n(c.name), handle: pickI18n(c.handle) || null, parentId: c.parent ? String(c.parent) : null },
          update: { name: pickI18n(c.name), handle: pickI18n(c.handle) || null, parentId: c.parent ? String(c.parent) : null, syncedAt: new Date() },
        });
      }
      const products = await this.client.listProducts();
      const listId = await this.retailListId();
      let failed = 0;
      for (const p of products) {
        try {
          await this.upsertProduct(p, listId);
        } catch (error) {
          failed += 1;
          this.logger.error({ err: error, productId: p.id }, 'no se pudo sincronizar el producto');
        }
      }
      const removed = await this.db.product.updateMany({
        where: { syncedAt: { lt: startedAt }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const stats = { categories: categories.length, products: products.length, failed, removed: removed.count };
      await this.db.syncRun.update({ where: { id: run.id }, data: { status: failed ? 'PARTIAL' : 'OK', stats, finishedAt: new Date() } });
      await this.db.integrationSetting.upsert({
        where: { provider: PROVIDER },
        create: { provider: PROVIDER, enabled: true, status: 'OK', lastSyncAt: new Date() },
        update: { status: failed ? 'PARTIAL' : 'OK', lastSyncAt: new Date(), lastError: null },
      });
      this.logger.info(stats, 'catálogo sincronizado');
      return stats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.syncRun.update({ where: { id: run.id }, data: { status: 'ERROR', error: message, finishedAt: new Date() } });
      await this.db.integrationSetting.upsert({
        where: { provider: PROVIDER },
        create: { provider: PROVIDER, status: 'ERROR', lastError: message },
        update: { status: 'ERROR', lastError: message },
      });
      throw error;
    }
  }
}

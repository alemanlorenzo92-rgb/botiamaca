import type { EventService, Prisma, PrismaClient } from '@prisma/client';
import { normalize, searchKey } from '../core/text.js';
import { RETAIL_PRICE_LIST, WHOLESALE_PRICE_LIST } from './catalog.service.js';

export interface Faq {
  q: string;
  a: string;
}

export interface VariantInput {
  id?: string | null;
  values: string[];
  sku?: string | null;
  /** null = sin precio cargado (la IA dice que no tiene el dato) */
  retailPrice?: number | null;
  wholesalePrice?: number | null;
  /** null = sin dato de stock; número = unidades disponibles */
  stock?: number | null;
}

export interface ProductInput {
  name: string;
  description?: string | null;
  features?: string | null;
  usage?: string | null;
  recommendations?: string | null;
  faqs?: Faq[];
  tags?: string[];
  brand?: string | null;
  url?: string | null;
  published?: boolean;
  categoryIds?: string[];
  variants?: VariantInput[];
}

export interface TutorialInput {
  title: string;
  content?: string;
  productId?: string | null;
  categoryId?: string | null;
  service?: EventService | null;
  mediaIds?: string[];
  active?: boolean;
}

export class CatalogNotFoundError extends Error {}

const productSearchSelect = {
  id: true,
  name: true,
  brand: true,
  description: true,
  features: true,
  usage: true,
  recommendations: true,
  faqs: true,
  tags: true,
  searchText: true,
  categories: { select: { category: { select: { name: true } } } },
  variants: { where: { deletedAt: null }, select: { values: true } },
} satisfies Prisma.ProductSelect;

type ProductSearchData = Prisma.ProductGetPayload<{ select: typeof productSearchSelect }>;

function productSearchText(p: ProductSearchData) {
  const faqs = Array.isArray(p.faqs) ? (p.faqs as unknown as Faq[]).map((f) => `${f.q} ${f.a}`).join(' ') : '';
  return searchKey(
    [p.name, p.brand, p.description, p.features, p.usage, p.recommendations, faqs, p.tags.join(' '), p.categories.map((c) => c.category.name).join(' '), p.variants.flatMap((v) => v.values).join(' ')]
      .filter(Boolean)
      .join(' '),
  );
}

/** Alta, baja y modificación del catálogo propio de Male Style (la fuente de verdad es el panel). */
export class CatalogAdminService {
  constructor(private readonly db: PrismaClient) {}

  async ensurePriceLists() {
    const retail = await this.db.priceList.upsert({
      where: { code: RETAIL_PRICE_LIST },
      create: { code: RETAIL_PRICE_LIST, name: 'Minorista', source: 'manual' },
      update: {},
    });
    const wholesale = await this.db.priceList.upsert({
      where: { code: WHOLESALE_PRICE_LIST },
      create: { code: WHOLESALE_PRICE_LIST, name: 'Mayorista', source: 'manual' },
      update: {},
    });
    return { retail, wholesale };
  }

  async saveCategory(data: { id?: string; name: string; description?: string | null; visible?: boolean }) {
    const description = data.description === undefined ? undefined : data.description?.trim() || null;
    if (!data.id) return this.db.category.create({ data: { name: data.name.trim(), description, visible: data.visible ?? true } });
    const category = await this.db.category.update({ where: { id: data.id }, data: { name: data.name.trim(), description, visible: data.visible } });
    const [products, tutorials] = await Promise.all([
      this.db.product.findMany({ where: { categories: { some: { categoryId: category.id } } }, select: { id: true } }),
      this.db.tutorial.findMany({ where: { categoryId: category.id }, select: { id: true } }),
    ]);
    for (const { id } of products) await this.refreshSearch(id);
    for (const { id } of tutorials) await this.refreshTutorialSearch(id);
    return category;
  }

  async deleteCategory(id: string) {
    await this.db.category.delete({ where: { id } });
  }

  async createProduct(input: ProductInput) {
    const product = await this.db.product.create({ data: { name: input.name.trim() } });
    try {
      return await this.updateProduct(product.id, input);
    } catch (error) {
      await this.db.product.delete({ where: { id: product.id } });
      throw error;
    }
  }

  async updateProduct(id: string, input: Partial<ProductInput>) {
    const lists = await this.ensurePriceLists();
    await this.db.$transaction(async (tx) => {
      const exists = await tx.product.findFirst({ where: { id, deletedAt: null } });
      if (!exists) throw new CatalogNotFoundError('Producto inexistente');
      await tx.product.update({
        where: { id },
        data: {
          name: input.name?.trim(),
          description: input.description === undefined ? undefined : input.description?.trim() || null,
          features: input.features === undefined ? undefined : input.features?.trim() || null,
          usage: input.usage === undefined ? undefined : input.usage?.trim() || null,
          recommendations: input.recommendations === undefined ? undefined : input.recommendations?.trim() || null,
          faqs: input.faqs === undefined ? undefined : (input.faqs.filter((f) => f.q.trim() && f.a.trim()) as unknown as Prisma.InputJsonValue),
          tags: input.tags?.map((t) => t.trim()).filter(Boolean),
          brand: input.brand === undefined ? undefined : input.brand?.trim() || null,
          url: input.url === undefined ? undefined : input.url?.trim() || null,
          published: input.published,
        },
      });
      if (input.categoryIds) {
        await tx.productCategory.deleteMany({ where: { productId: id } });
        if (input.categoryIds.length) {
          await tx.productCategory.createMany({ data: input.categoryIds.map((categoryId) => ({ productId: id, categoryId })) });
        }
      }
      if (input.variants) {
        const keep: string[] = [];
        // Un producto sin variantes explícitas tiene una "Única" para poder llevar precio y stock.
        const variants = input.variants.length ? input.variants : [{ values: [] }];
        for (const v of variants) {
          const variant = v.id
            ? await tx.productVariant.update({ where: { id: v.id, productId: id }, data: { values: v.values, sku: v.sku === undefined ? undefined : v.sku, deletedAt: null } })
            : await tx.productVariant.create({ data: { productId: id, values: v.values, sku: v.sku ?? null } });
          keep.push(variant.id);
          for (const [listId, amount] of [
            [lists.retail.id, v.retailPrice],
            [lists.wholesale.id, v.wholesalePrice],
          ] as const) {
            if (amount === undefined) continue;
            const current = await tx.variantPrice.findFirst({ where: { variantId: variant.id, priceListId: listId, validTo: null } });
            if (current && amount !== null && Number(current.amount) === amount) continue;
            if (current) await tx.variantPrice.update({ where: { id: current.id }, data: { validTo: new Date() } });
            if (amount !== null) await tx.variantPrice.create({ data: { variantId: variant.id, priceListId: listId, amount } });
          }
          if (v.stock !== undefined) {
            if (v.stock === null) await tx.inventory.deleteMany({ where: { variantId: variant.id } });
            else
              await tx.inventory.upsert({
                where: { variantId: variant.id },
                create: { variantId: variant.id, managed: true, quantity: v.stock },
                update: { managed: true, quantity: v.stock, syncedAt: new Date() },
              });
          }
        }
        await tx.productVariant.updateMany({ where: { productId: id, id: { notIn: keep }, deletedAt: null }, data: { deletedAt: new Date() } });
      }
    });
    return this.refreshSearch(id);
  }

  async deleteProduct(id: string) {
    await this.db.product.update({ where: { id }, data: { deletedAt: new Date(), published: false } });
  }

  async refreshProductSearchTexts() {
    const products = await this.db.product.findMany({ where: { deletedAt: null }, select: productSearchSelect });
    const updates = products.flatMap((p) => {
      const searchText = productSearchText(p);
      return p.searchText === searchText ? [] : [{ id: p.id, searchText }];
    });
    if (!updates.length) return 0;
    await this.db.$transaction(updates.map(({ id, searchText }) => this.db.product.update({ where: { id }, data: { searchText } })));
    return updates.length;
  }

  private async refreshSearch(id: string) {
    const p = await this.db.product.findUniqueOrThrow({ where: { id }, select: productSearchSelect });
    const searchText = productSearchText(p);
    return this.db.product.update({ where: { id }, data: { searchText } });
  }

  async saveTutorial(id: string | null, input: TutorialInput) {
    const data = {
      title: input.title.trim(),
      content: input.content?.trim() ?? '',
      productId: input.productId ?? null,
      categoryId: input.categoryId ?? null,
      service: input.service ?? null,
      active: input.active ?? true,
    };
    const media = input.mediaIds ? { set: input.mediaIds.map((m) => ({ id: m })) } : undefined;
    const t = id
      ? await this.db.tutorial.update({ where: { id }, data: { ...data, media } })
      : await this.db.tutorial.create({ data: { ...data, media: input.mediaIds ? { connect: input.mediaIds.map((m) => ({ id: m })) } : undefined } });
    return this.refreshTutorialSearch(t.id);
  }

  private async refreshTutorialSearch(id: string) {
    const full = await this.db.tutorial.findUniqueOrThrow({ where: { id }, include: { product: true, category: true } });
    const searchText = normalize([full.title, full.content, full.product?.name, full.category?.name, full.service?.replace('_', ' ')].filter(Boolean).join(' '));
    return this.db.tutorial.update({ where: { id }, data: { searchText } });
  }
}

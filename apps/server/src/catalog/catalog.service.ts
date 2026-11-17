import type { BuyerType, Prisma, PrismaClient } from '@prisma/client';
import { searchKey, truncate } from '../core/text.js';

export const RETAIL_PRICE_LIST = 'retail';
export const WHOLESALE_PRICE_LIST = 'wholesale';

const productInclude = {
  variants: {
    where: { deletedAt: null },
    include: { inventory: true, prices: { where: { validTo: null }, include: { priceList: true } } },
  },
  categories: { include: { category: true } },
} satisfies Prisma.ProductInclude;

type ProductWithVariants = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type VariantWithData = ProductWithVariants['variants'][number];

export interface StockInfo {
  status: 'IN_STOCK' | 'OUT_OF_STOCK' | 'NOT_TRACKED' | 'UNKNOWN';
  quantity: number | null;
}

export function stockOf(variant: { inventory: { managed: boolean; quantity: number | null } | null }): StockInfo {
  if (!variant.inventory) return { status: 'UNKNOWN', quantity: null };
  if (!variant.inventory.managed) return { status: 'NOT_TRACKED', quantity: null };
  const q = variant.inventory.quantity ?? 0;
  return { status: q > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK', quantity: q };
}

export function priceOf(variant: VariantWithData, listCode: string): number | null {
  const p = variant.prices.find((x) => x.priceList.code === listCode);
  return p ? Number(p.amount) : null;
}

const STOP_WORDS = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'para', 'con', 'y', 'o', 'que', 'en', 'del', 'por', 'tenes', 'tienen', 'hay', 'quiero', 'busco', 'precio']);

function tokens(query: string): string[] {
  return searchKey(query)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('es') ? t.slice(0, -2) : t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Consultas de catálogo para la IA y el panel. Solo devuelve datos sincronizados. */
export class CatalogService {
  constructor(private readonly db: PrismaClient) {}

  private summarize(p: ProductWithVariants, buyerType: BuyerType) {
    const variants = p.variants.map((v) => this.variantView(v, buyerType));
    const retailPrices = variants.map((v) => v.retail_price).filter((x): x is number => x !== null);
    return {
      product_id: p.id,
      name: p.name,
      url: p.url,
      categories: p.categories.map((c) => c.category.name),
      price_from: retailPrices.length ? Math.min(...retailPrices) : null,
      any_in_stock: variants.some((v) => v.stock.status === 'IN_STOCK' || v.stock.status === 'NOT_TRACKED'),
      variants_count: variants.length,
      variants: variants.slice(0, 8),
    };
  }

  private variantView(v: VariantWithData, buyerType: BuyerType) {
    return {
      variant_id: v.id,
      options: v.values.join(' / ') || 'Única',
      sku: v.sku,
      retail_price: priceOf(v, RETAIL_PRICE_LIST),
      wholesale_price: buyerType === 'WHOLESALE' ? priceOf(v, WHOLESALE_PRICE_LIST) : undefined,
      stock: stockOf(v),
    };
  }

  async search(query: string, opts: { limit?: number; buyerType?: BuyerType; onlyInStock?: boolean; maxPrice?: number | null } = {}) {
    const limit = Math.min(opts.limit ?? 5, 10);
    const terms = tokens(query);
    const where: Prisma.ProductWhereInput = { deletedAt: null, published: true };
    if (terms.length) where.OR = terms.map((t) => ({ searchText: { contains: t } }));
    const candidates = await this.db.product.findMany({ where, include: productInclude, take: 200 });

    const scored = candidates
      .map((p) => {
        const name = searchKey(p.name);
        const score = terms.reduce((acc, t) => acc + (name.includes(t) ? 3 : 0) + (p.searchText.includes(t) ? 1 : 0), 0);
        return { p, score };
      })
      .filter(({ score }) => !terms.length || score > 0)
      .sort((a, b) => b.score - a.score);

    const results = [];
    for (const { p } of scored) {
      const s = this.summarize(p, opts.buyerType ?? 'UNKNOWN');
      if (opts.onlyInStock && !s.any_in_stock) continue;
      if (opts.maxPrice && (s.price_from === null || s.price_from > opts.maxPrice)) continue;
      results.push(s);
      if (results.length >= limit) break;
    }
    return { results, total_matches: scored.length };
  }

  async details(productId: string, buyerType: BuyerType = 'UNKNOWN') {
    const p = await this.db.product.findFirst({ where: { id: productId, deletedAt: null }, include: productInclude });
    if (!p) return null;
    return {
      ...this.summarize(p, buyerType),
      variants: p.variants.map((v) => this.variantView(v, buyerType)),
      description: truncate(p.description ?? '', 1200),
      features: p.features,
      usage: p.usage,
      recommendations: p.recommendations,
      faqs: p.faqs,
      media: (
        await this.db.mediaAsset.findMany({ where: { productId: p.id, active: true }, select: { id: true, kind: true, title: true }, take: 6 })
      ).map((m) => ({ media_id: m.id, kind: m.kind, title: m.title })),
      tags: p.tags,
      free_shipping: p.freeShipping,
      image: p.imageUrls[0] ?? null,
    };
  }

  async variant(variantId: string) {
    return this.db.productVariant.findFirst({
      where: { id: variantId, deletedAt: null, product: { deletedAt: null } },
      include: { product: true, inventory: true, prices: { where: { validTo: null }, include: { priceList: true } } },
    });
  }

  async stock(variantId: string) {
    const v = await this.variant(variantId);
    if (!v) return null;
    return { variant_id: v.id, product: v.product.name, options: v.values.join(' / '), stock: stockOf(v) };
  }

  /** Precio según tipo de comprador. Nunca inventa: si no hay precio cargado lo dice. */
  async price(variantId: string, buyerType: BuyerType) {
    const v = await this.variant(variantId);
    if (!v) return null;
    const retail = v.prices.find((p) => p.priceList.code === RETAIL_PRICE_LIST);
    const wholesale = v.prices.find((p) => p.priceList.code === WHOLESALE_PRICE_LIST);
    const base = { variant_id: v.id, product: v.product.name, options: v.values.join(' / '), currency: 'ARS' };
    if (buyerType === 'WHOLESALE') {
      return {
        ...base,
        price_list: WHOLESALE_PRICE_LIST,
        amount: wholesale ? Number(wholesale.amount) : null,
        retail_amount: retail ? Number(retail.amount) : null,
        note: wholesale ? null : 'No hay precio mayorista cargado para este producto. No lo inventes: ofrecé consultarlo con una persona.',
      };
    }
    return {
      ...base,
      price_list: RETAIL_PRICE_LIST,
      amount: retail ? Number(retail.amount) : null,
      note: retail ? null : 'El producto no tiene precio publicado. No lo inventes: ofrecé consultarlo con una persona.',
    };
  }
}

import { Prisma, type PrismaClient } from '@prisma/client';
import type { EventBus } from '../core/events.js';
import { RETAIL_PRICE_LIST, WHOLESALE_PRICE_LIST } from '../catalog/catalog.service.js';
import { stockOf } from '../catalog/catalog.service.js';

export class CartError extends Error {}

export class CartService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: EventBus,
  ) {}

  private async openCart(contactId: string, conversationId: string | null) {
    const contact = await this.db.contact.findUniqueOrThrow({ where: { id: contactId } });
    const existing = await this.db.cart.findFirst({ where: { contactId, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
    if (existing) return existing;
    return this.db.cart.create({ data: { contactId, conversationId, wholesale: contact.buyerType === 'WHOLESALE' } });
  }

  async view(contactId: string) {
    const cart = await this.db.cart.findFirst({
      where: { contactId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { variant: { include: { product: true, inventory: true } } } } },
    });
    if (!cart || !cart.items.length) return { cart_id: cart?.id ?? null, items: [], total_estimate: null, missing_prices: false };
    const items = cart.items.map((i) => ({
      variant_id: i.variantId,
      product: i.variant.product.name,
      options: i.variant.values.join(' / ') || 'Única',
      quantity: i.quantity,
      unit_price: i.unitPrice ? Number(i.unitPrice) : null,
      subtotal: i.unitPrice ? Number(i.unitPrice) * i.quantity : null,
      stock: stockOf(i.variant),
    }));
    const missing = items.some((i) => i.unit_price === null);
    const total = items.reduce((acc, i) => acc + (i.subtotal ?? 0), 0);
    return { cart_id: cart.id, wholesale: cart.wholesale, items, total_estimate: missing ? null : total, missing_prices: missing };
  }

  async add(contactId: string, conversationId: string | null, variantId: string, quantity: number) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw new CartError('Cantidad inválida');
    const variant = await this.db.productVariant.findFirst({
      where: { id: variantId, deletedAt: null, product: { deletedAt: null } },
      include: { inventory: true, prices: { where: { validTo: null }, include: { priceList: true } } },
    });
    if (!variant) throw new CartError('Variante inexistente');
    const stock = stockOf(variant);
    if (stock.status === 'OUT_OF_STOCK') throw new CartError('Sin stock');
    const cart = await this.openCart(contactId, conversationId);
    const existing = await this.db.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } });
    const newQty = (existing?.quantity ?? 0) + quantity;
    if (stock.status === 'IN_STOCK' && stock.quantity !== null && newQty > stock.quantity) {
      throw new CartError(`Solo hay ${stock.quantity} unidades disponibles`);
    }
    const listCode = cart.wholesale ? WHOLESALE_PRICE_LIST : RETAIL_PRICE_LIST;
    const price = variant.prices.find((p) => p.priceList.code === listCode);
    await this.db.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      create: { cartId: cart.id, variantId, quantity: newQty, unitPrice: price?.amount ?? null, priceListCode: price ? listCode : null },
      update: { quantity: newQty, unitPrice: price?.amount ?? null, priceListCode: price ? listCode : null },
    });
    return this.view(contactId);
  }

  async remove(contactId: string, variantId: string, quantity: number | null) {
    const cart = await this.db.cart.findFirst({ where: { contactId, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
    if (!cart) return this.view(contactId);
    const item = await this.db.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } });
    if (item) {
      if (quantity && quantity < item.quantity) {
        await this.db.cartItem.update({ where: { id: item.id }, data: { quantity: item.quantity - quantity } });
      } else {
        await this.db.cartItem.delete({ where: { id: item.id } });
      }
    }
    return this.view(contactId);
  }

  /** Cambia el carrito abierto a mayorista/minorista y recalcula los precios de referencia. */
  async setWholesale(contactId: string, wholesale: boolean) {
    const cart = await this.db.cart.findFirst({
      where: { contactId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { variant: { include: { prices: { where: { validTo: null }, include: { priceList: true } } } } } } },
    });
    if (!cart || cart.wholesale === wholesale) return;
    const listCode = wholesale ? WHOLESALE_PRICE_LIST : RETAIL_PRICE_LIST;
    await this.db.$transaction([
      this.db.cart.update({ where: { id: cart.id }, data: { wholesale } }),
      ...cart.items.map((i) => {
        const price = i.variant.prices.find((p) => p.priceList.code === listCode);
        return this.db.cartItem.update({
          where: { id: i.id },
          data: { unitPrice: price?.amount ?? null, priceListCode: price ? listCode : null },
        });
      }),
    ]);
  }

  /** Convierte el carrito en un pedido a revisar por una persona (no cobra ni confirma). */
  async submit(contactId: string, shippingNotes: string | null, notes: string | null) {
    const cart = await this.db.cart.findFirst({
      where: { contactId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { variant: { include: { product: true } } } } },
    });
    if (!cart || !cart.items.length) throw new CartError('El carrito está vacío');
    const missing = cart.items.some((i) => i.unitPrice === null);
    const total = cart.items.reduce((acc, i) => acc.add((i.unitPrice ?? new Prisma.Decimal(0)).mul(i.quantity)), new Prisma.Decimal(0));
    const order = await this.db.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          contactId,
          cartId: cart.id,
          wholesale: cart.wholesale,
          totalEstimate: missing ? null : total,
          shippingNotes,
          notes,
          items: {
            create: cart.items.map((i) => ({
              variantId: i.variantId,
              description: `${i.variant.product.name}${i.variant.values.length ? ` (${i.variant.values.join(' / ')})` : ''}`,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
            })),
          },
        },
      });
      await tx.cart.update({ where: { id: cart.id }, data: { status: 'CONVERTED' } });
      return created;
    });
    if (cart.conversationId) this.bus.publish({ type: 'conversation.updated', conversationId: cart.conversationId });
    return { order_number: order.number, status: order.status, total_estimate: missing ? null : Number(total), missing_prices: missing };
  }
}

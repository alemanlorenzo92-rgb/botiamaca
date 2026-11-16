import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { safeEqual, sha256 } from '../core/crypto.js';
import type { Logger } from '../core/logger.js';
import type { CatalogSyncService } from './catalog-sync.service.js';

const PROVIDER = 'tiendanube';

export class WebhookSignatureError extends Error {
  constructor() {
    super('Firma de webhook inválida');
  }
}

/** `x-linkedstore-hmac-sha256` = HMAC-SHA256 en hex del body crudo, con el secreto de la app. */
export function verifyTiendanubeSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, signature.trim().toLowerCase());
}

interface TnWebhookPayload {
  store_id?: number | string;
  event?: string;
  id?: number | string;
}

export type WebhookResult = { status: 'accepted'; eventId: string } | { status: 'duplicate' } | { status: 'ignored'; reason: string };

/**
 * Webhooks de Tiendanube. Pueden llegar duplicados o desordenados, por eso:
 * - se deduplican por hash del body en `webhook_events`;
 * - nunca se usa el contenido del webhook: siempre se vuelve a consultar el producto a la API;
 * - los eventos de un mismo producto se procesan de a uno.
 */
export class TiendanubeWebhookService {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly db: PrismaClient,
    private readonly sync: CatalogSyncService,
    private readonly config: { appSecret: string | undefined; storeId: string | undefined },
    private readonly logger: Logger,
  ) {}

  isConfigured(): boolean {
    return !!this.config.appSecret && this.sync.isConfigured();
  }

  /** Verifica y registra el webhook. El procesamiento real se hace con `process` (en segundo plano). */
  async receive(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
    if (!this.config.appSecret || !verifyTiendanubeSignature(rawBody, signature, this.config.appSecret)) {
      throw new WebhookSignatureError();
    }
    let payload: TnWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as TnWebhookPayload;
    } catch {
      return { status: 'ignored', reason: 'JSON inválido' };
    }
    if (this.config.storeId && payload.store_id !== undefined && String(payload.store_id) !== this.config.storeId) {
      return { status: 'ignored', reason: 'Otra tienda' };
    }
    try {
      const row = await this.db.webhookEvent.create({
        data: {
          provider: PROVIDER,
          dedupeKey: `${PROVIDER}:${sha256(rawBody.toString('utf8'))}`,
          event: payload.event ?? 'unknown',
          payload: payload as Prisma.InputJsonValue,
        },
      });
      return { status: 'accepted', eventId: row.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { status: 'duplicate' };
      throw error;
    }
  }

  process(eventId: string): Promise<void> {
    return this.db.webhookEvent.findUnique({ where: { id: eventId } }).then((row) => {
      if (!row || row.processedAt) return;
      const payload = row.payload as TnWebhookPayload;
      const key = payload.id !== undefined ? `product:${payload.id}` : `event:${row.id}`;
      const previous = this.chains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => this.apply(row.id, row.event, payload))
        .finally(() => {
          if (this.chains.get(key) === next) this.chains.delete(key);
        });
      this.chains.set(key, next);
      return next;
    });
  }

  private async apply(eventId: string, event: string, payload: TnWebhookPayload): Promise<void> {
    try {
      if (event.startsWith('product/') && payload.id !== undefined) {
        const result = await this.sync.syncProduct(String(payload.id));
        this.logger.info({ event, productId: payload.id, result }, 'webhook de producto procesado');
      }
      // Otros eventos (categorías, app, datos personales) solo quedan registrados; la sincronización
      // periódica cubre las categorías.
      await this.db.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date(), error: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, eventId, event }, 'falló el procesamiento del webhook');
      await this.db.webhookEvent.update({ where: { id: eventId }, data: { error: message } });
    }
  }

  /** Reintenta los webhooks que quedaron sin procesar (reinicio o falla de la API). */
  async processPending(maxAgeHours = 72): Promise<number> {
    const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const rows = await this.db.webhookEvent.findMany({
      where: { provider: PROVIDER, processedAt: null, receivedAt: { gte: since } },
      orderBy: { receivedAt: 'asc' },
      select: { id: true },
      take: 500,
    });
    for (const r of rows) await this.process(r.id);
    return rows.length;
  }
}

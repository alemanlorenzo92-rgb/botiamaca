import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import type { LlmClient } from '../src/ai/orchestrator.js';
import { seed } from '../src/cli.js';
import { createContainer } from '../src/container.js';
import { loadEnv } from '../src/core/env.js';
import { createLogger } from '../src/core/logger.js';
import type { MediaStorage } from '../src/media/storage.js';
import type { InboundWhatsAppMessage, OutboundMedia, WhatsAppTransport } from '../src/whatsapp/transport.js';
import { TEST_DATABASE_URL } from './db-url.js';

export const db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
export const APP_SECRET = 'test-app-secret';
export const CUSTOMER_JID = '5493510000001@s.whatsapp.net';

export async function resetDb() {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seed(db);
  await db.aiSetting.update({ where: { id: 1 }, data: { debounceSeconds: 0 } });
}

export class FakeTransport implements WhatsAppTransport {
  connected = true;
  sent: { jid: string; text: string }[] = [];
  media: { jid: string; kind: string; mimetype: string; caption: string | null; size: number }[] = [];
  /** Cantidad de envíos de medios que van a fallar antes de funcionar */
  failMedia = 0;
  isConnected() {
    return this.connected;
  }
  async sendText(jid: string, text: string) {
    if (!this.connected) throw new Error('WhatsApp no está conectado');
    this.sent.push({ jid, text });
    return { externalId: `out-${randomUUID()}` };
  }
  async sendMedia(jid: string, m: OutboundMedia) {
    if (!this.connected) throw new Error('WhatsApp no está conectado');
    if (this.failMedia > 0) {
      this.failMedia--;
      throw new Error('falla simulada de envío');
    }
    this.media.push({ jid, kind: m.kind, mimetype: m.mimetype, caption: m.caption ?? null, size: m.data.length });
    return { externalId: `out-${randomUUID()}` };
  }
}

/** Almacenamiento de archivos en memoria para tests. */
export class MemoryStorage implements MediaStorage {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const f = this.files.get(key);
    if (!f) throw new Error('no existe');
    return f;
  }
  async exists(key: string) {
    return this.files.has(key);
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}

type Handler = (params: ResponseCreateParamsNonStreaming) => Response | Promise<Response>;

/** LLM simulado: responde en orden con los handlers encolados y guarda cada request. */
export class FakeLlm implements LlmClient {
  calls: ResponseCreateParamsNonStreaming[] = [];
  private queue: Handler[] = [];
  push(...handlers: (Handler | Response)[]) {
    this.queue.push(...handlers.map((h) => (typeof h === 'function' ? h : () => h)));
    return this;
  }
  async create(params: ResponseCreateParamsNonStreaming) {
    this.calls.push(structuredClone(params));
    const next = this.queue.shift();
    if (!next) throw new Error('FakeLlm: no hay más respuestas encoladas');
    return next(params);
  }
  /** Salidas de herramientas que recibió el modelo en la llamada `index`. */
  toolOutputs(index: number): unknown[] {
    const input = this.calls[index]?.input;
    if (!Array.isArray(input)) return [];
    return input
      .filter((i) => (i as { type?: string }).type === 'function_call_output')
      .map((i) => JSON.parse((i as { output: string }).output));
  }
}

const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };

export function textReply(text: string): Response {
  return {
    id: `resp_${randomUUID()}`,
    status: 'completed',
    output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    output_text: text,
    usage,
    error: null,
  } as unknown as Response;
}

export function toolCalls(...calls: [string, Record<string, unknown>][]): Response {
  return {
    id: `resp_${randomUUID()}`,
    status: 'completed',
    output: calls.map(([name, args], i) => ({
      type: 'function_call',
      id: `fc_${i}`,
      call_id: `call_${randomUUID()}`,
      name,
      arguments: JSON.stringify(args),
      status: 'completed',
    })),
    output_text: '',
    usage,
    error: null,
  } as unknown as Response;
}

export function createTestContainer() {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    WHATSAPP_ENABLED: 'false',
    OPENAI_TIMEOUT_MS: '2000',
  });
  const logger = createLogger('silent');
  const transport = new FakeTransport();
  const llm = new FakeLlm();
  const storage = new MemoryStorage();
  const c = createContainer(env, logger, { db, transport, llm, storage });
  return { c, transport, llm, storage };
}

export type TestContainer = ReturnType<typeof createTestContainer>['c'];

let seq = 0;
export function inbound(text: string | null, extra: Partial<InboundWhatsAppMessage> = {}): InboundWhatsAppMessage {
  seq += 1;
  return {
    externalId: `in-${seq}-${randomUUID()}`,
    chatJid: CUSTOMER_JID,
    altJid: null,
    fromMe: false,
    pushName: 'Juli',
    type: 'TEXT',
    text,
    mediaMime: null,
    timestamp: new Date(),
    ...extra,
  };
}

/** Simula un mensaje del cliente y espera la respuesta del worker (sin debounce). */
export async function customerSays(c: TestContainer, text: string, extra: Partial<InboundWhatsAppMessage> = {}) {
  const result = await c.conversations.ingest(inbound(text, extra));
  if (result.kind === 'customer' && result.needsReply) await c.worker.enqueue(result.conversationId);
  return result;
}

export async function conversation() {
  return db.conversation.findFirstOrThrow({ include: { contact: true } });
}

export async function outbound() {
  return db.message.findMany({ where: { direction: 'OUTBOUND' }, orderBy: { createdAt: 'asc' } });
}

/** Carga un producto con variantes en la base, como si viniera de la sincronización. */
export async function seedProduct(p: {
  name: string;
  variants: { values: string[]; retail?: number | null; wholesale?: number | null; stock?: number | null; managed?: boolean }[];
}) {
  const retail = await db.priceList.upsert({ where: { code: 'retail' }, create: { code: 'retail', name: 'Minorista', source: 'manual' }, update: {} });
  const wholesale = await db.priceList.upsert({ where: { code: 'wholesale' }, create: { code: 'wholesale', name: 'Mayorista', source: 'manual' }, update: {} });
  const product = await db.product.create({
    data: { name: p.name, published: true, searchText: p.name.toLowerCase(), url: `https://tienda.test/${encodeURIComponent(p.name)}` },
  });
  const variants = [];
  for (const v of p.variants) {
    const variant = await db.productVariant.create({ data: { productId: product.id, values: v.values } });
    if (v.retail != null) await db.variantPrice.create({ data: { variantId: variant.id, priceListId: retail.id, amount: v.retail } });
    if (v.wholesale != null) await db.variantPrice.create({ data: { variantId: variant.id, priceListId: wholesale.id, amount: v.wholesale } });
    await db.inventory.create({ data: { variantId: variant.id, managed: v.managed ?? true, quantity: v.stock ?? 0 } });
    variants.push(variant);
  }
  return { product, variants };
}

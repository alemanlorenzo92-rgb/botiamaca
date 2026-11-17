/**
 * Prueba de punta a punta contra la API real de OpenAI, sobre una base de PRUEBA (nunca la de producción):
 * importa un chat de ejemplo, extrae conocimiento, lo aprueba, lo recupera por RAG, responde una consulta,
 * verifica que no invente un precio sin cargar, que la toma de la dueña frene a la IA y que un error de la API derive.
 * Uso: SMOKE_DATABASE_URL=postgresql://.../bot_smoke OPENAI_API_KEY=... pnpm --filter @bot/server smoke:openai
 * WhatsApp se reemplaza por un transporte que solo registra lo que se enviaría (no hay cuenta real conectada).
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { createContainer } from './container.js';
import { loadEnv } from './core/env.js';
import { createLogger } from './core/logger.js';
import type { InboundWhatsAppMessage, OutboundMedia, WhatsAppTransport } from './whatsapp/transport.js';

const url = process.env.SMOKE_DATABASE_URL;
if (!url || !process.env.OPENAI_API_KEY) throw new Error('Faltan SMOKE_DATABASE_URL y/o OPENAI_API_KEY');
if (url === process.env.DATABASE_URL) throw new Error('SMOKE_DATABASE_URL tiene que ser una base de prueba distinta de DATABASE_URL');

class RecordingTransport implements WhatsAppTransport {
  sent: string[] = [];
  media: string[] = [];
  isConnected() { return true; }
  async sendText(_jid: string, text: string) { this.sent.push(text); return { externalId: randomUUID() }; }
  async sendMedia(_jid: string, m: OutboundMedia) { this.media.push(m.mimetype); return { externalId: randomUUID() }; }
}

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = '') => { results.push({ step, ok, detail }); console.log(`${ok ? 'OK  ' : 'FALLA'} ${step}${detail ? ` — ${detail}` : ''}`); };

execFileSync('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
const db = new PrismaClient({ datasources: { db: { url } } });
const env = loadEnv({ ...process.env, DATABASE_URL: url, WHATSAPP_ENABLED: 'false' });
const transport = new RecordingTransport();
const c = createContainer(env, createLogger('warn'), { db, transport });
const inbound = (text: string): InboundWhatsAppMessage => ({ externalId: randomUUID(), chatJid: '5493580000000@s.whatsapp.net', altJid: null, fromMe: false, pushName: 'Prueba', type: 'TEXT', text, mediaMime: null, timestamp: new Date() });
const ask = async (text: string) => {
  const r = await c.conversations.ingest(inbound(text));
  if (r.kind === 'customer' && r.needsReply) await c.worker.enqueue(r.conversationId);
  return transport.sent.at(-1) ?? '';
};

try {
  await db.aiSetting.upsert({ where: { id: 1 }, create: { id: 1, debounceSeconds: 0 }, update: { debounceSeconds: 0, enabled: true } });
  const chat = [
    '10/11/2026, 09:00 - Male Style: Hola! Gracias por escribir a Male Style 💖',
    '10/11/2026, 09:01 - Juana Pérez: Hola! Cuál es el mínimo para comprar por mayor?',
    '10/11/2026, 09:02 - Male Style: El mínimo mayorista es de 10 unidades surtidas, podés combinar colores 😊',
    '10/11/2026, 09:03 - Juana Pérez: Y hacen envíos? Mi dirección es Belgrano 450',
    '10/11/2026, 09:04 - Male Style: Sí! Enviamos a todo el país por correo, el costo depende de la zona y te lo paso al armar el pedido',
  ].join('\n');
  const imp = await c.chatImport.import({ data: Buffer.from(chat), fileName: 'smoke.txt', ownerName: 'Male Style', consent: true, mediaConsent: false });
  check('1. importar conversación', imp.inserted === 5, `${imp.inserted} mensajes`);
  const stored = await db.importedMessage.findMany({ orderBy: { position: 'asc' } });
  check('   anonimización', !stored.some((m) => /Belgrano|Juana/.test(m.text ?? '')), 'sin nombre ni dirección');
  await c.jobs.runOnce();
  const docs = await db.knowledgeDocument.findMany();
  check('2-3. procesar con OpenAI y extraer conocimiento', docs.length > 0, docs.map((d) => `${d.kind}: ${d.title}`).join(' | '));
  for (const d of docs) await c.knowledge.setStatus(d.id, 'APPROVED', null);
  check('4-5. aprobar y guardar', (await db.knowledgeDocument.count({ where: { status: 'APPROVED' } })) === docs.length);
  const found = await c.knowledge.retrieve('cuántas unidades necesito para comprar al por mayor');
  check('6-7. recuperar el conocimiento correcto (pgvector + embeddings reales)', found.documents.some((d) => /10|diez/.test(d.content)), found.documents.map((d) => d.title).join(' | '));
  const answer = await ask('Hola! cuál es el mínimo para comprar mayorista?');
  check('8. respuesta contextual de OpenAI', /10|diez/i.test(answer), answer);
  await c.catalogAdmin.createProduct({ name: 'Glitter holográfico plateado' });
  const price = await ask('Cuánto sale el glitter holográfico plateado?');
  const run = await db.aiRun.findFirst({ orderBy: { createdAt: 'desc' } });
  check('9. no inventa un precio sin cargar', !/\$\s?\d/.test(price), price);
  check('   trazabilidad (ai_runs)', Boolean(run && run.status === 'OK' && run.inputTokens > 0), `${run?.inputTokens} in / ${run?.outputTokens} out, ${run?.latencyMs} ms`);
  const conv = await db.conversation.findFirstOrThrow();
  await c.handoff.takeFromPhone(conv.id);
  const before = transport.sent.length;
  await ask('Hola? sigue ahí?');
  check('11. la dueña toma el control y la IA deja de responder', transport.sent.length === before);
  await c.handoff.release(conv.id, (await c.auth.createUser({ email: `smoke-${randomUUID()}@test.local`, name: 'Smoke', password: 'clave-smoke-123', roleCode: 'admin' })).id);
  const broken = createContainer(loadEnv({ ...process.env, DATABASE_URL: url, WHATSAPP_ENABLED: 'false', OPENAI_API_KEY: 'sk-invalida' }), createLogger('silent'), { db, transport });
  const r = await broken.conversations.ingest(inbound('Hola, tienen glitter dorado?'));
  if (r.kind === 'customer') await broken.worker.enqueue(r.conversationId);
  check('12. error de la API: deriva a la dueña', (await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).status === 'HUMAN_REQUESTED');
} catch (error) {
  check('ejecución', false, error instanceof Error ? error.message : String(error));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pasos OK`);
process.exit(failed ? 1 : 0);

/**
 * Evaluación de calidad de respuestas contra la API real de OpenAI.
 * Carga datos de EJEMPLO (no son los reales de la tienda) en una base de prueba, simula ~20 consultas típicas
 * y marca respuestas con frases de robot, demasiadas preguntas o demasiado largas. Escribe eval-resultados.md.
 *
 *   SMOKE_DATABASE_URL=postgresql://…/bot_smoke OPENAI_API_KEY=sk-… pnpm --filter @bot/server eval:respuestas
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { createContainer } from './container.js';
import { loadEnv } from './core/env.js';
import { createLogger } from './core/logger.js';
import type { InboundWhatsAppMessage, OutboundMedia, WhatsAppTransport } from './whatsapp/transport.js';

const url = process.env.SMOKE_DATABASE_URL;
if (!url || !process.env.OPENAI_API_KEY) throw new Error('Faltan SMOKE_DATABASE_URL y/o OPENAI_API_KEY');
const dbName = (u: string) => new URL(u).pathname.replace(/^\//, '');
if (!/smoke|test/i.test(dbName(url)) || (process.env.DATABASE_URL && dbName(process.env.DATABASE_URL) === dbName(url))) {
  throw new Error('SMOKE_DATABASE_URL tiene que apuntar a una base de prueba (nombre con "smoke" o "test") distinta de DATABASE_URL: se borra entera');
}

class RecordingTransport implements WhatsAppTransport {
  sent: { jid: string; text: string }[] = [];
  isConnected() { return true; }
  async sendText(jid: string, text: string) { this.sent.push({ jid, text }); return { externalId: randomUUID() }; }
  async sendMedia(jid: string, m: OutboundMedia) { this.sent.push({ jid, text: `[${m.mimetype}]` }); return { externalId: randomUUID() }; }
}

const SCENARIOS: { name: string; turns: string[] }[] = [
  { name: 'Saludo', turns: ['Hola'] },
  { name: 'Saludo genérico', turns: ['Hola buenas tardes, quería consultar precios'] },
  { name: 'Precio producto', turns: ['Hola! cuánto sale el glitter holográfico?'] },
  { name: 'Color con error de tipeo', turns: ['cuanto sale el gliter rosa'] },
  { name: 'Stock de color', turns: ['Tenés glitter dorado?'] },
  { name: 'Producto que no existe', turns: ['Tenés algo para el pelo?'] },
  { name: 'Mínimo mayorista', turns: ['Vendo en mi local, cuál es el mínimo por mayor?'] },
  { name: 'Precio mayorista', turns: ['Soy revendedora, a cuánto me queda el holográfico por mayor?'] },
  { name: 'Envíos', turns: ['Hacen envíos a Córdoba capital?'] },
  { name: 'Medios de pago', turns: ['Cómo puedo pagar?'] },
  { name: 'Retiro', turns: ['Tienen local para retirar?'] },
  { name: 'Horario', turns: ['Hasta qué hora atienden?'] },
  { name: 'Shimmer Wall', turns: ['Hola, necesito precio de una shimmer wall de 3x3'] },
  { name: 'Glitter Bar en dos mensajes', turns: ['Quiero glitter bar para un cumple de 15', 'Es el 20 de diciembre en Río Cuarto'] },
  { name: 'Cómo se usa', turns: ['Cómo se aplica el glitter en la cara?'] },
  { name: 'Fotos', turns: ['Me mandás fotos del glitter holográfico?'] },
  { name: 'Compra', turns: ['Quiero 2 potes de holográfico plateado', 'Sí, confirmo'] },
  { name: 'Reclamo', turns: ['Me llegó el pedido roto'] },
  { name: '¿Sos un bot?', turns: ['Sos un bot?'] },
  { name: 'Mensaje personal', turns: ['Ya llegué, abrime'] },
];

const FLAGS: [RegExp, string][] = [
  [/sistema|cat[aá]logo|cargad[oa]|base de datos|herramienta|informaci[oó]n disponible/i, 'habla de sistemas'],
  [/—/, 'raya'],
  [/equipo|asesor/i, 'equipo/asesor'],
  [/gracias por (preguntar|tu consulta)|excelente pregunta|con gusto te ayudo|algo más en lo que pueda/i, 'frase de robot'],
];

execFileSync('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
execFileSync('npx', ['tsx', 'src/cli.ts', 'seed'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
const db = new PrismaClient({ datasources: { db: { url } } });
const env = loadEnv({ ...process.env, DATABASE_URL: url, WHATSAPP_ENABLED: 'false' });
const transport = new RecordingTransport();
const c = createContainer(env, createLogger('warn'), { db, transport });

const out: string[] = ['# Evaluación de respuestas (datos de ejemplo)', ''];
let flagged = 0;
try {
  await db.aiSetting.update({ where: { id: 1 }, data: { debounceSeconds: 0, enabled: true } });
  const biz: [Parameters<typeof c.settings.setBusiness>[0], string][] = [
    ['business_profile', 'Male Style, Río Cuarto (Córdoba). Glitter, maquillaje artístico y servicios para eventos. Atiende la dueña de lunes a sábado de 9 a 20.'],
    ['wholesale_conditions', 'Mínimo mayorista: 10 unidades surtidas, se pueden combinar colores.'],
    ['shipping_policy', 'Envíos a todo el país por Correo Argentino o Andreani, el costo depende de la zona y se calcula al armar el pedido. En Río Cuarto se puede retirar a coordinar.'],
    ['payment_methods', 'Transferencia, Mercado Pago o efectivo al retirar.'],
  ];
  for (const [k, v] of biz) await c.settings.setBusiness(k, v, null);
  await c.catalogAdmin.createProduct({
    name: 'Glitter holográfico', usage: 'Se aplica sobre gel fijador o vaselina con pincel o con el dedo.', tags: ['glitter', 'cara', 'cuerpo'],
    variants: [
      { values: ['Plateado'], retailPrice: 3500, wholesalePrice: 2800, stock: 40 },
      { values: ['Dorado'], retailPrice: 3500, wholesalePrice: 2800, stock: 0 },
      { values: ['Rosa'], retailPrice: 3500, wholesalePrice: 2800, stock: 12 },
    ],
  });
  await c.catalogAdmin.createProduct({ name: 'Gel fijador para glitter', variants: [{ values: ['50 ml'], retailPrice: 4200, wholesalePrice: 3300, stock: 20 }] });

  for (const [i, s] of SCENARIOS.entries()) {
    const jid = `54935800${String(i).padStart(5, '0')}@s.whatsapp.net`;
    out.push(`## ${i + 1}. ${s.name}`, '');
    for (const text of s.turns) {
      const before = transport.sent.length;
      const r = await c.conversations.ingest({ externalId: randomUUID(), chatJid: jid, altJid: null, fromMe: false, pushName: 'Caro', type: 'TEXT', text, mediaMime: null, timestamp: new Date() } satisfies InboundWhatsAppMessage);
      if (r.kind === 'customer' && r.needsReply) await c.worker.enqueue(r.conversationId);
      const replies = transport.sent.slice(before).filter((m) => m.jid === jid).map((m) => m.text);
      out.push(`**Clienta:** ${text}`, '');
      for (const reply of replies.length ? replies : ['(sin respuesta)']) {
        const flags = FLAGS.filter(([re]) => re.test(reply)).map(([, f]) => f);
        if ((reply.match(/\?/g) ?? []).length > 1) flags.push('más de una pregunta');
        if (reply.length > 400) flags.push(`larga (${reply.length})`);
        if (flags.length) flagged++;
        out.push(`**Bot:** ${reply}${flags.length ? `  \n⚠️ ${flags.join(', ')}` : ''}`, '');
        console.log(`${flags.length ? 'REVISAR' : 'OK     '} ${s.name}: ${reply.replace(/\n/g, ' / ')}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
      }
    }
  }
  out.splice(1, 0, `Respuestas marcadas para revisar: ${flagged}`, '');
  writeFileSync('eval-resultados.md', out.join('\n'));
  console.log(`\nRespuestas marcadas: ${flagged}. Detalle en eval-resultados.md`);
} finally {
  await db.$disconnect();
}

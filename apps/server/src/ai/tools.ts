import type { BuyerType, Contact, PrismaClient } from '@prisma/client';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { HandoffService } from '../conversations/handoff.service.js';
import type { AuditService } from '../core/audit.js';
import type { BusinessSettingKey, SettingsService } from '../core/settings.js';
import type { FollowupsService } from '../events/followups.service.js';
import type { LeadsService } from '../events/leads.service.js';
import { CartError, type CartService } from '../sales/cart.service.js';
import { toStrictJsonSchema } from './json-schema.js';

export interface ToolDeps {
  db: PrismaClient;
  catalog: CatalogService;
  cart: CartService;
  leads: LeadsService;
  followups: FollowupsService;
  handoff: HandoffService;
  settings: SettingsService;
  audit: AuditService;
}

export interface ToolContext {
  conversationId: string;
  contact: Contact;
  /** Se marca cuando la IA deriva: la conversación deja de estar en manos de la IA. */
  handedOff: boolean;
}

export class ToolInputError extends Error {}

const NO_DATA =
  'Sin dato cargado. No lo inventes ni lo supongas: decile al cliente que no tenés ese dato y ofrecé que lo atienda una persona.';

const BUSINESS_TOPICS = {
  business_profile: 'Datos generales del negocio (nombre, dirección, horarios, redes)',
  store_links: 'Links de la tienda online y redes',
  payment_methods: 'Medios de pago aceptados',
  shipping_policy: 'Envíos, zonas, costos y tiempos',
  wholesale_conditions: 'Condiciones de compra mayorista (mínimos, requisitos)',
  retail_conditions: 'Condiciones de compra minorista (cambios, devoluciones, garantía)',
  handoff_rules: 'Cuándo derivar a una persona y horarios de atención humana',
  faq: 'Preguntas frecuentes',
} as const satisfies Partial<Record<BusinessSettingKey, string>>;

const SERVICE_KEYS = {
  GLITTER_BAR: 'service_glitter_bar',
  SHIMMER_WALL: 'service_shimmer_wall',
} as const satisfies Record<string, BusinessSettingKey>;

const id = z.string().uuid();
const nullableText = (max = 500) => z.string().max(max).nullable();

function topicKeys() {
  return Object.keys(BUSINESS_TOPICS) as [keyof typeof BUSINESS_TOPICS, ...(keyof typeof BUSINESS_TOPICS)[]];
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (args: z.infer<S>, ctx: ToolContext, deps: ToolDeps) => Promise<unknown>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<z.ZodType> {
  return def as unknown as ToolDef<z.ZodType>;
}

function buyer(ctx: ToolContext): BuyerType {
  return ctx.contact.buyerType;
}

export const TOOLS: ToolDef<z.ZodType>[] = [
  tool({
    name: 'search_products',
    description:
      'Busca productos en el catálogo sincronizado de la tienda. Usalo para cualquier consulta de productos o recomendaciones. Devuelve precio y stock reales; si no aparece, no existe en el catálogo.',
    schema: z.object({
      query: z.string().min(1).max(200).describe('Qué busca el cliente, con sus palabras (tipo de prenda, color, talle, uso)'),
      only_in_stock: z.boolean().nullable().describe('true para mostrar solo productos con stock'),
      max_price: z.number().positive().nullable().describe('Precio máximo minorista en ARS, si el cliente lo indicó'),
      limit: z.number().int().min(1).max(10).nullable(),
    }),
    run: (a, ctx, d) =>
      d.catalog.search(a.query, {
        limit: a.limit ?? 5,
        buyerType: buyer(ctx),
        onlyInStock: a.only_in_stock ?? false,
        maxPrice: a.max_price,
      }),
  }),
  tool({
    name: 'get_product_details',
    description: 'Detalle completo de un producto: descripción, todas las variantes (talle/color), precio y stock de cada una.',
    schema: z.object({ product_id: id }),
    run: async (a, ctx, d) => (await d.catalog.details(a.product_id, buyer(ctx))) ?? { error: 'Producto inexistente o dado de baja' },
  }),
  tool({
    name: 'check_stock',
    description:
      'Stock actual de una variante. IN_STOCK = disponible (quantity = unidades), OUT_OF_STOCK = sin stock, NOT_TRACKED = la tienda no controla stock (consultar), UNKNOWN = sin dato.',
    schema: z.object({ variant_id: id }),
    run: async (a, _ctx, d) => (await d.catalog.stock(a.variant_id)) ?? { error: 'Variante inexistente' },
  }),
  tool({
    name: 'get_price',
    description:
      'Precio vigente de una variante según el tipo de comprador del cliente (minorista o mayorista). Si amount es null, NO hay precio cargado: no lo inventes.',
    schema: z.object({ variant_id: id }),
    run: async (a, ctx, d) => (await d.catalog.price(a.variant_id, buyer(ctx))) ?? { error: 'Variante inexistente' },
  }),
  tool({
    name: 'get_business_info',
    description: `Información del negocio cargada por el equipo. Temas: ${Object.entries(BUSINESS_TOPICS)
      .map(([k, v]) => `${k} (${v})`)
      .join('; ')}. Si no hay dato cargado, decilo y ofrecé una persona.`,
    schema: z.object({ topic: z.enum(topicKeys()) }),
    run: async (a, _ctx, d) => {
      const value = await d.settings.getBusiness(a.topic);
      return value === null ? { topic: a.topic, configured: false, note: NO_DATA } : { topic: a.topic, configured: true, info: value };
    },
  }),
  tool({
    name: 'get_service_info',
    description:
      'Información de los servicios para eventos: GLITTER_BAR (barra de glitter) y SHIMMER_WALL (paredes shimmer). Incluye qué es, qué incluye y condiciones cargadas.',
    schema: z.object({ service: z.enum(['GLITTER_BAR', 'SHIMMER_WALL']) }),
    run: async (a, _ctx, d) => {
      const value = await d.settings.getBusiness(SERVICE_KEYS[a.service]);
      return value === null ? { service: a.service, configured: false, note: NO_DATA } : { service: a.service, configured: true, info: value };
    },
  }),
  tool({
    name: 'set_buyer_type',
    description:
      'Registra el tipo de comprador cuando el cliente lo deja claro: RETAIL (compra para uso propio), WHOLESALE (revende / compra mayorista), EVENT (consulta por servicios para eventos).',
    schema: z.object({ buyer_type: z.enum(['RETAIL', 'WHOLESALE', 'EVENT']) }),
    run: async (a, ctx, d) => {
      if (ctx.contact.buyerType !== a.buyer_type) {
        ctx.contact = await d.db.contact.update({ where: { id: ctx.contact.id }, data: { buyerType: a.buyer_type } });
        if (a.buyer_type !== 'EVENT') await d.cart.setWholesale(ctx.contact.id, a.buyer_type === 'WHOLESALE');
      }
      return { buyer_type: ctx.contact.buyerType };
    },
  }),
  tool({
    name: 'update_customer_profile',
    description:
      'Guarda datos útiles del cliente para próximas conversaciones. memory_summary reemplaza el resumen completo: incluí lo anterior que siga siendo válido más lo nuevo (gustos, talles, qué compró o consultó, pendientes). Pasá null en lo que no cambia.',
    schema: z.object({
      name: nullableText(120).describe('Nombre con el que se presentó el cliente'),
      interests: z.array(z.string().max(60)).max(20).nullable().describe('Intereses / categorías que le gustan (lista completa)'),
      notes: nullableText(1000).describe('Notas para el equipo'),
      memory_summary: nullableText(1500).describe('Resumen breve y actualizado del cliente'),
    }),
    run: async (a, ctx, d) => {
      const data: Record<string, unknown> = {};
      if (a.name) data.name = a.name;
      if (a.interests) data.interests = a.interests;
      if (a.notes) data.notes = a.notes;
      if (a.memory_summary) {
        data.memorySummary = a.memory_summary;
        data.memoryUpdatedAt = new Date();
      }
      if (Object.keys(data).length) ctx.contact = await d.db.contact.update({ where: { id: ctx.contact.id }, data });
      return { saved: Object.keys(data) };
    },
  }),
  tool({
    name: 'add_to_cart',
    description: 'Agrega una variante (talle/color concreto) al carrito del cliente. Confirmá antes variante y cantidad con el cliente.',
    schema: z.object({ variant_id: id, quantity: z.number().int().min(1).max(10000) }),
    run: (a, ctx, d) => d.cart.add(ctx.contact.id, ctx.conversationId, a.variant_id, a.quantity),
  }),
  tool({
    name: 'view_cart',
    description: 'Muestra el carrito actual del cliente con precios de referencia y total estimado.',
    schema: z.object({}),
    run: (_a, ctx, d) => d.cart.view(ctx.contact.id),
  }),
  tool({
    name: 'remove_from_cart',
    description: 'Quita una variante del carrito. quantity null = quitarla entera.',
    schema: z.object({ variant_id: id, quantity: z.number().int().min(1).nullable() }),
    run: (a, ctx, d) => d.cart.remove(ctx.contact.id, a.variant_id, a.quantity),
  }),
  tool({
    name: 'submit_order',
    description:
      'Envía el carrito como pedido para que lo revise una persona del equipo (no cobra ni confirma). Usalo solo cuando el cliente confirma que quiere avanzar. Después avisale que una persona lo contacta para confirmar pago y envío.',
    schema: z.object({
      shipping_notes: nullableText().describe('Ciudad / forma de entrega que mencionó el cliente'),
      notes: nullableText().describe('Otros comentarios del cliente'),
    }),
    run: async (a, ctx, d) => {
      const result = await d.cart.submit(ctx.contact.id, a.shipping_notes, a.notes);
      await d.audit.log({
        actorType: 'AI',
        action: 'order.submitted',
        entityType: 'order',
        entityId: String(result.order_number),
        data: { conversationId: ctx.conversationId },
      });
      return result;
    },
  }),
  tool({
    name: 'save_event_lead',
    description:
      'Crea o completa la consulta de un evento (GLITTER_BAR o SHIMMER_WALL). Llamalo cada vez que el cliente dé datos nuevos; devuelve missing_fields con lo que falta preguntar. No des precios de eventos: los cotiza una persona.',
    schema: z.object({
      service: z.enum(['GLITTER_BAR', 'SHIMMER_WALL']),
      customer_name: nullableText(120),
      event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe('Fecha en formato AAAA-MM-DD si es precisa'),
      event_date_text: nullableText(120).describe('Fecha tal como la dijo el cliente'),
      location: nullableText(200),
      event_type: nullableText(120).describe('Casamiento, 15, cumpleaños, corporativo, etc.'),
      guests: z.number().int().min(1).max(100000).nullable(),
      start_time: nullableText(60),
      duration: nullableText(60),
      services_requested: nullableText(),
      measures: nullableText(200).describe('Medidas del espacio (Shimmer Walls)'),
      color_style: nullableText(200),
      rental_duration: nullableText(120),
      extra_info: nullableText(1000),
    }),
    run: async (a, ctx, d) => {
      const { service, ...fields } = a;
      if (ctx.contact.buyerType === 'UNKNOWN') {
        ctx.contact = await d.db.contact.update({ where: { id: ctx.contact.id }, data: { buyerType: 'EVENT' } });
      }
      return d.leads.upsert(ctx.contact.id, ctx.conversationId, service, fields);
    },
  }),
  tool({
    name: 'schedule_followup',
    description:
      'Agenda un recordatorio para que el equipo vuelva a contactar al cliente (no le escribe solo). Usalo si el cliente pide que lo contacten más adelante o queda algo pendiente.',
    schema: z.object({
      due_at: z.string().describe('Fecha y hora ISO 8601 con zona horaria, por ejemplo 2026-11-20T10:00:00-03:00'),
      reason: z.string().min(3).max(500),
    }),
    run: async (a, ctx, d) => {
      const dueAt = new Date(a.due_at);
      if (Number.isNaN(dueAt.getTime())) throw new ToolInputError('due_at no es una fecha válida');
      const maxAhead = Date.now() + 365 * 24 * 60 * 60 * 1000;
      if (dueAt.getTime() < Date.now() - 60_000 || dueAt.getTime() > maxAhead) {
        throw new ToolInputError('due_at debe ser una fecha futura (dentro del próximo año)');
      }
      const lead = await d.db.eventLead.findFirst({
        where: { contactId: ctx.contact.id, status: { in: ['NEW', 'QUOTING', 'QUOTED'] } },
        orderBy: { updatedAt: 'desc' },
      });
      const f = await d.followups.create({
        contactId: ctx.contact.id,
        conversationId: ctx.conversationId,
        eventLeadId: lead?.id ?? null,
        dueAt,
        reason: a.reason,
        createdBy: 'AI',
      });
      return { followup_id: f.id, due_at: f.dueAt.toISOString() };
    },
  }),
  tool({
    name: 'request_human',
    description:
      'Deriva la conversación a una persona del equipo y frena las respuestas automáticas. Usalo si el cliente lo pide, si falta un dato que no podés inventar y el cliente lo necesita, ante reclamos, o si no podés resolver. El sistema le avisa al cliente; no hace falta que respondas nada más.',
    schema: z.object({ reason: z.string().min(3).max(300).describe('Motivo breve para el equipo') }),
    run: async (a, ctx, d) => {
      ctx.handedOff = true;
      const current = await d.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } });
      // Si el equipo pausó o tomó la conversación mientras pensaba la IA, no se toca ni se avisa nada.
      if (current.status !== 'AI_ACTIVE') return { ok: true, note: 'La conversación ya está con el equipo' };
      await d.handoff.requestHuman(ctx.conversationId, { type: 'AI' }, a.reason);
      return { ok: true };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function openAiTools(): FunctionTool[] {
  return TOOLS.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: toStrictJsonSchema(t.schema),
    strict: true,
  }));
}

export type ToolOutcome = { ok: true; output: unknown } | { ok: false; error: string; internal: boolean };

/** Ejecuta una herramienta validando los argumentos. Los errores se devuelven a la IA, no se lanzan. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext, deps: ToolDeps): Promise<ToolOutcome> {
  const def = BY_NAME.get(name);
  if (!def) return { ok: false, error: `Herramienta desconocida: ${name}`, internal: false };
  let json: unknown;
  try {
    json = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: 'Argumentos con JSON inválido', internal: false };
  }
  const parsed = def.schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, internal: false };
  }
  try {
    return { ok: true, output: await def.run(parsed.data, ctx, deps) };
  } catch (error) {
    if (error instanceof CartError || error instanceof ToolInputError) return { ok: false, error: error.message, internal: false };
    return { ok: false, error: error instanceof Error ? error.message : String(error), internal: true };
  }
}

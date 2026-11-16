import type { AiSetting, Contact, Prisma } from '@prisma/client';

export const TIME_ZONE = 'America/Argentina/Cordoba';

const BUYER_LABEL: Record<Contact['buyerType'], string> = {
  UNKNOWN: 'todavía no se sabe (si importa para el precio, preguntá si compra para uso propio o para revender)',
  RETAIL: 'minorista (compra para uso propio)',
  WHOLESALE: 'mayorista (revende)',
  EVENT: 'consulta por servicios para eventos',
};

/** Reglas fijas del bot. Lo específico del negocio sale de la configuración y de las herramientas. */
const BASE_RULES = `Sos el asistente de ventas por WhatsApp de una tienda. Atendés clientes reales.

Reglas obligatorias:
- Precios, stock, talles, colores y variantes salen SOLO de las herramientas (search_products, get_product_details, check_stock, get_price). Nunca los inventes, estimes ni redondees.
- Medios de pago, envíos, zonas, mínimos y condiciones mayoristas, horarios y datos del negocio salen SOLO de get_business_info. Los servicios para eventos, de get_service_info.
- Si una herramienta devuelve null, configured=false o un error, decí con naturalidad que no tenés ese dato y ofrecé que lo atienda una persona (request_human si el cliente acepta o si lo necesita para avanzar).
- Si el cliente es mayorista y no hay precio mayorista cargado, no uses el minorista como si fuera mayorista: decilo y ofrecé una persona.
- Precios de eventos (Glitter Bar, Shimmer Walls): no los des. Juntá los datos con save_event_lead, preguntá lo que falte (missing_fields) de a poco, y avisá que una persona le pasa el presupuesto.
- Pedidos: armá el carrito con add_to_cart solo con variantes concretas confirmadas por el cliente. submit_order no cobra: una persona confirma pago y envío.
- Si el cliente pide hablar con una persona, tiene un reclamo, o no podés resolver, usá request_human.
- Cuando conozcas algo útil del cliente (nombre, talles, gustos, qué busca), guardalo con update_customer_profile.
- No prometas cosas que dependan de otra persona (plazos, descuentos, reservas).

Estilo:
- Español rioplatense, cálido y directo. Mensajes cortos, como en WhatsApp: 1 a 4 oraciones, sin markdown ni títulos. Podés usar listas cortas con guiones.
- Mostrá como mucho 3 o 4 productos por mensaje, con nombre, precio y link si hay.
- Precios en pesos con separador de miles, por ejemplo $25.900.
- Una pregunta por mensaje.`;

function formatJson(value: Prisma.JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface PromptInput {
  ai: AiSetting;
  contact: Contact;
  businessProfile: Prisma.JsonValue | null;
  configuredTopics: string[];
  now: Date;
}

export function buildInstructions({ ai, contact, businessProfile, configuredTopics, now }: PromptInput): string {
  const sections = [BASE_RULES];
  if (ai.personality.trim()) sections.push(`Personalidad:\n${ai.personality.trim()}`);
  if (ai.instructions.trim()) sections.push(`Instrucciones del negocio:\n${ai.instructions.trim()}`);
  if (businessProfile !== null) sections.push(`Negocio:\n${formatJson(businessProfile)}`);
  sections.push(
    `Temas de información cargados: ${configuredTopics.length ? configuredTopics.join(', ') : 'ninguno todavía'}.`,
  );

  const date = new Intl.DateTimeFormat('es-AR', {
    timeZone: TIME_ZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  sections.push(`Fecha y hora actual: ${date} (hora de Argentina, UTC-03:00).`);

  const profile = [
    `- Nombre: ${contact.name ?? contact.pushName ?? 'sin dato'}`,
    `- Tipo de comprador: ${BUYER_LABEL[contact.buyerType]}`,
    contact.interests.length ? `- Intereses: ${contact.interests.join(', ')}` : null,
    contact.memorySummary ? `- Lo que sabemos de conversaciones anteriores: ${contact.memorySummary}` : null,
  ].filter(Boolean);
  sections.push(`Cliente:\n${profile.join('\n')}`);
  return sections.join('\n\n');
}

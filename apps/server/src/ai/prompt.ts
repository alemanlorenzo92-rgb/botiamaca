import { DEFAULT_TIME_ZONE, isWithinBusinessHours } from '../core/hours.js';
import type { AiSetting, Contact, Prisma } from '@prisma/client';
import type { RetrievedKnowledge } from '../knowledge/knowledge.service.js';

export const TIME_ZONE = DEFAULT_TIME_ZONE;

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
- Para cómo se usa un producto, para qué sirve o diferencias, usá search_product_information y search_tutorials.
- Medios de pago, envíos, zonas, mínimos y condiciones mayoristas, horarios y datos del negocio salen SOLO de get_business_info. Los servicios para eventos (Glitter Bar, Shimmer Walls), de search_service_information.
- Fotos y videos: solo los de la biblioteca (search_media y después send_image o send_video). Nunca describas ni prometas fotos que no encontraste. Mandá pocas (máximo 3) y solo si el cliente las pide o le ayudan a decidir.
- El "Conocimiento aprendido" de abajo viene de conversaciones reales revisadas por la dueña: usalo para el tono y para cómo responder, pero los precios y el stock salen siempre de las herramientas.
- Si te preguntan si sos una persona o un bot, respondé con honestidad que sos el asistente virtual de la tienda y que la dueña puede atender cuando haga falta.
- Si una herramienta devuelve null, configured=false o un error, decí con naturalidad que no tenés ese dato y ofrecé que lo atienda la dueña (request_human si el cliente acepta o si lo necesita para avanzar).
- Si el cliente es mayorista y no hay precio mayorista cargado, no uses el minorista como si fuera mayorista: decilo y ofrecé que lo atienda la dueña.
- Precios de eventos (Glitter Bar, Shimmer Walls): no los des. Juntá los datos con save_event_lead, preguntá lo que falte (missing_fields) de a poco, y avisá que la dueña le pasa el presupuesto.
- Pedidos: armá el carrito con add_to_cart solo con variantes concretas confirmadas por el cliente. submit_order no cobra: la dueña confirma pago y envío.
- Si el cliente pide hablar con una persona, tiene un reclamo, o no podés resolver, usá request_human.
- Cuando conozcas algo útil del cliente (nombre, talles, gustos, qué busca), guardalo con update_customer_profile.
- No prometas cosas que dependan de la dueña (plazos, descuentos, reservas).
- La tienda la atiende solo la dueña: nunca hables de "el equipo", "alguien del equipo" ni "un asesor"; cuando derives, decí que le pasás la consulta a la dueña.

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
  knowledge?: RetrievedKnowledge | null;
}

export function buildInstructions({ ai, contact, businessProfile, configuredTopics, now, knowledge }: PromptInput): string {
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

  if (ai.greeting?.trim()) {
    sections.push(`Saludo: si es el primer mensaje del cliente en esta conversación, saludá con este texto (podés adaptarlo apenas):\n${ai.greeting.trim()}`);
  }
  if (isWithinBusinessHours(ai.businessHours, now) === false) {
    sections.push(
      ai.outsideHoursMessage?.trim()
        ? `Ahora la dueña está fuera del horario de atención. Si el cliente pide hablar con ella o hay que derivar, avisale: ${ai.outsideHoursMessage.trim()}`
        : 'Ahora la dueña está fuera del horario de atención. Si derivás, aclarale que le responden en el próximo horario de atención.',
    );
  }

  const profile = [
    `- Nombre: ${contact.name ?? contact.pushName ?? 'sin dato'}`,
    `- Tipo de comprador: ${BUYER_LABEL[contact.buyerType]}`,
    contact.interests.length ? `- Intereses: ${contact.interests.join(', ')}` : null,
    contact.memorySummary ? `- Lo que sabemos de conversaciones anteriores: ${contact.memorySummary}` : null,
  ].filter(Boolean);
  sections.push(`Cliente:\n${profile.join('\n')}`);

  if (knowledge?.documents.length) {
    const docs = knowledge.documents.map(
      (d) => `- [${d.kind}] ${d.title}: ${d.content}${d.temporal ? ' (dato que puede haber cambiado: confirmalo con las herramientas antes de afirmarlo)' : ''}`,
    );
    sections.push(`Conocimiento aprendido (aprobado por la dueña, solo lo relevante a esta consulta):\n${docs.join('\n')}`);
  }
  if (knowledge?.examples.length) {
    sections.push(
      `Ejemplos reales de cómo responde la dueña (imitá el tono, NO copies precios ni datos de estos ejemplos):\n${knowledge.examples.map((e) => e.text).join('\n---\n')}`,
    );
  }
  return sections.join('\n\n');
}

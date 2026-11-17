import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isWithinBusinessHours } from '../src/core/hours.js';
import { shouldHandleUpsert } from '../src/whatsapp/gateway.js';
import {
  CUSTOMER_JID,
  conversation,
  createTestContainer,
  customerSays,
  db,
  inbound,
  outbound,
  resetDb,
  seedProduct,
  textReply,
  toolCalls,
} from './helpers.js';

beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe('catálogo: precio, stock y recomendaciones', () => {
  it('precio: la IA recibe el precio cargado y lo informa', async () => {
    const { variants } = await seedProduct({ name: 'Remera oversize', variants: [{ values: ['Negro', 'M'], retail: 15990, stock: 4 }] });
    const { c, llm, transport } = createTestContainer();
    llm.push(toolCalls(['get_price', { variant_id: variants[0]!.id }]), textReply('La remera negra M sale $15.990.'));

    await customerSays(c, '¿Cuánto sale la remera negra en M?');

    expect(llm.toolOutputs(1)[0]).toMatchObject({ amount: 15990, price_list: 'retail', note: null });
    expect(transport.sent.map((s) => s.text)).toEqual(['La remera negra M sale $15.990.']);
    const runs = await db.aiRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'OK', inputTokens: 200, outputTokens: 40 });
  });

  it('stock: devuelve la cantidad sincronizada y "sin stock" cuando es 0', async () => {
    const { variants } = await seedProduct({
      name: 'Buzo canguro',
      variants: [
        { values: ['L'], retail: 30000, stock: 2 },
        { values: ['XL'], retail: 30000, stock: 0 },
      ],
    });
    const { c, llm } = createTestContainer();
    llm.push(
      toolCalls(['check_stock', { variant_id: variants[0]!.id }], ['check_stock', { variant_id: variants[1]!.id }]),
      textReply('En L quedan 2, en XL no hay.'),
    );
    await customerSays(c, '¿Tenés el buzo en L y XL?');
    const [l, xl] = llm.toolOutputs(1) as { stock: { status: string; quantity: number | null } }[];
    expect(l!.stock).toMatchObject({ status: 'IN_STOCK', quantity: 2 });
    expect(xl!.stock.status).toBe('OUT_OF_STOCK');
  });

  it('mayorista sin precio cargado: amount null y aviso de no inventar', async () => {
    const { variants } = await seedProduct({ name: 'Jean recto', variants: [{ values: ['42'], retail: 45000, stock: 10 }] });
    const { c, llm } = createTestContainer();
    llm.push(
      toolCalls(['set_buyer_type', { buyer_type: 'WHOLESALE' }]),
      toolCalls(['get_price', { variant_id: variants[0]!.id }]),
      textReply('No tengo cargado el precio mayorista, ¿querés que te pase con alguien del equipo?'),
    );
    await customerSays(c, 'Soy revendedora, ¿precio mayorista del jean?');
    const price = llm.toolOutputs(2)[1] as { amount: number | null; note: string; price_list: string };
    expect(price.price_list).toBe('wholesale');
    expect(price.amount).toBeNull();
    expect(price.note).toMatch(/No lo inventes/);
    expect((await conversation()).contact.buyerType).toBe('WHOLESALE');
  });

  it('recomendaciones: search_products solo con stock y con precio real', async () => {
    await seedProduct({ name: 'Camisa lino blanca', variants: [{ values: ['M'], retail: 28000, stock: 3 }] });
    await seedProduct({ name: 'Camisa jean', variants: [{ values: ['M'], retail: 32000, stock: 0 }] });
    const { c, llm } = createTestContainer();
    llm.push(toolCalls(['search_products', { query: 'camisa', only_in_stock: true, max_price: null, limit: null }]), textReply('Te recomiendo la camisa de lino.'));
    await customerSays(c, 'Busco una camisa para un casamiento');
    const result = llm.toolOutputs(1)[0] as { results?: { name: string; price_from: number }[] } | { name: string }[];
    const products = Array.isArray(result) ? result : (result.results ?? []);
    expect(products.map((p) => p.name)).toEqual(['Camisa lino blanca']);
  });
});

describe('datos del negocio y eventos', () => {
  it('envíos sin dato: configured=false y la IA no recibe nada inventado', async () => {
    const { c, llm } = createTestContainer();
    llm.push(toolCalls(['get_business_info', { topic: 'shipping_policy' }]), textReply('No tengo ese dato cargado.'));
    await customerSays(c, '¿Hacen envíos a Córdoba? ¿Cuánto sale?');
    expect(llm.toolOutputs(1)[0]).toMatchObject({ topic: 'shipping_policy', configured: false });
    expect(String(llm.calls[0]!.instructions)).toMatch(/Nunca los inventes/);
  });

  it('Glitter Bar: guarda el lead, marca EVENT y pide lo que falta sin dar precio', async () => {
    const { c, llm } = createTestContainer();
    llm.push(
      toolCalls([
        'save_event_lead',
        {
          service: 'GLITTER_BAR', customer_name: 'Juli', event_date: '2027-03-20', event_date_text: '20 de marzo',
          location: 'Córdoba', event_type: 'Casamiento', guests: 150, start_time: null, duration: null,
          services_requested: null, measures: null, color_style: null, rental_duration: null, extra_info: null,
        },
      ]),
      textReply('¡Genial! ¿A qué hora empieza y cuánto dura?'),
    );
    await customerSays(c, 'Quiero la glitter bar para mi casamiento el 20 de marzo, 150 invitados en Córdoba');
    const lead = await db.eventLead.findFirstOrThrow();
    expect(lead).toMatchObject({ service: 'GLITTER_BAR', guests: 150, location: 'Córdoba', status: 'NEW', quoteAmount: null });
    expect(llm.toolOutputs(1)[0]).toMatchObject({ missing_fields: ['horario', 'duración del servicio'] });
    expect((await conversation()).contact.buyerType).toBe('EVENT');
  });

  it('Shimmer Walls: sin info cargada lo informa y registra el lead', async () => {
    const { c, llm } = createTestContainer();
    llm.push(
      toolCalls(['search_service_information', { service: 'SHIMMER_WALL' }]),
      toolCalls([
        'save_event_lead',
        {
          service: 'SHIMMER_WALL', customer_name: null, event_date: null, event_date_text: 'en abril', location: null,
          event_type: '15 años', guests: null, start_time: null, duration: null, services_requested: null,
          measures: '3x2 m', color_style: 'dorado', rental_duration: null, extra_info: null,
        },
      ]),
      textReply('Anoté tu consulta; el precio te lo pasa el equipo.'),
    );
    await customerSays(c, '¿Alquilan paredes shimmer doradas de 3x2 para unos 15 en abril?');
    expect(llm.toolOutputs(1)[0]).toMatchObject({ service: 'SHIMMER_WALL', configured: false });
    expect(await db.eventLead.findFirstOrThrow()).toMatchObject({ service: 'SHIMMER_WALL', measures: '3x2 m', colorStyle: 'dorado' });
  });
});

describe('atención humana', () => {
  it('pedido explícito de persona: pasa a HUMAN_REQUESTED sin llamar a la IA', async () => {
    const { c, llm, transport } = createTestContainer();
    await customerSays(c, 'Quiero hablar con una persona');
    expect((await conversation()).status).toBe('HUMAN_REQUESTED');
    expect(llm.calls).toHaveLength(0);
    expect(transport.sent.every((s) => !/IA/.test(s.text))).toBe(true);
  });

  it('request_human desde la IA: deriva y no manda texto de la IA', async () => {
    const { c, llm } = createTestContainer();
    llm.push(toolCalls(['request_human', { reason: 'Quiere cambiar un pedido ya pagado' }]));
    await customerSays(c, 'Necesito cambiar el pedido que ya pagué');
    expect((await conversation()).status).toBe('HUMAN_REQUESTED');
    expect((await outbound()).filter((m) => m.author === 'AI')).toHaveLength(0);
  });

  it('una persona responde desde el teléfono: la IA deja de contestar', async () => {
    const { c, llm } = createTestContainer();
    await c.conversations.ingest(inbound('Hola, soy Marta del local 😉', { fromMe: true }));
    expect((await conversation()).status).toBe('HUMAN_ACTIVE');
    await customerSays(c, 'Gracias Marta, ¿me guardás el buzo?');
    expect(llm.calls).toHaveLength(0);
    expect((await db.message.findMany({ where: { author: 'AI' } })).length).toBe(0);
  });

  it('contacto marcado para que el bot no responda (familia, amigos): la IA no contesta', async () => {
    const { c, llm, transport } = createTestContainer();
    await c.conversations.ingest(inbound('Ya pasamos'));
    await db.contact.updateMany({ data: { botMuted: true } });
    await customerSays(c, 'Me voy');
    expect(llm.calls).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  it('la dueña toma la conversación mientras la IA arma la respuesta: el texto de la IA no sale', async () => {
    const { c, transport } = createTestContainer();
    const r = await c.conversations.ingest(inbound('Hola, precio del glitter?'));
    const id = (await conversation()).id;
    await c.handoff.takeFromPhone(id);
    const msg = await c.sender.sendText({ conversationId: id, text: 'Respuesta tardía de la IA', author: 'AI' });
    expect(r.kind).toBe('customer');
    expect(msg.status).toBe('DISCARDED');
    expect(transport.sent).toHaveLength(0);
  });

  it('interruptor general apagado: el backend bloquea la respuesta', async () => {
    const { c, llm } = createTestContainer();
    await db.aiSetting.update({ where: { id: 1 }, data: { enabled: false } });
    await customerSays(c, 'Hola');
    expect(llm.calls).toHaveLength(0);
    expect(await outbound()).toHaveLength(0);
  });
});

describe('robustez', () => {
  it('reconexión: ignora historial viejo y retoma mensajes sin responder', async () => {
    const now = Date.now();
    expect(shouldHandleUpsert('notify', new Date(now - 60 * 60_000), now)).toBe(true);
    expect(shouldHandleUpsert('append', new Date(now - 60 * 60_000), now)).toBe(false);
    expect(shouldHandleUpsert('append', new Date(now - 60_000), now)).toBe(true);

    const first = createTestContainer();
    await first.c.conversations.ingest(inbound('¿Siguen abiertos?'));
    first.c.worker.stop(); // "se cae" antes de responder

    const second = createTestContainer();
    second.llm.push(textReply('¡Sí! ¿En qué te ayudo?'));
    expect(await second.c.worker.recoverPending()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    await second.c.worker.drain();
    expect(second.transport.sent.map((s) => s.text)).toEqual(['¡Sí! ¿En qué te ayudo?']);
    second.c.worker.stop();
  });

  it('mensajes duplicados: el mismo id de WhatsApp se guarda y responde una sola vez', async () => {
    const { c, llm, transport } = createTestContainer();
    llm.push(textReply('Hola!'));
    const msg = inbound('Hola');
    const r1 = await c.conversations.ingest(msg);
    const r2 = await c.conversations.ingest({ ...msg });
    expect(r2.kind).toBe('duplicate');
    if (r1.kind === 'customer') await c.worker.enqueue(r1.conversationId);
    await c.worker.enqueue((await conversation()).id);
    expect(await db.message.count({ where: { direction: 'INBOUND' } })).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('falla de OpenAI: avisa al cliente, deriva a una persona y registra el error', async () => {
    const { c, llm, transport } = createTestContainer();
    llm.push(() => {
      throw new Error('500 Internal Server Error');
    });
    await customerSays(c, 'Hola, ¿precio del jean?');
    const ai = await db.aiSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(transport.sent.map((s) => s.text)).toEqual([ai.errorMessage]);
    expect((await conversation()).status).toBe('HUMAN_REQUESTED');
    expect(await db.aiRun.findFirstOrThrow()).toMatchObject({ status: 'ERROR' });
  });

  it('cliente que vuelve: usa la memoria y el historial, y reabre la conversación', async () => {
    const contact = await db.contact.create({
      data: { waJid: CUSTOMER_JID, name: 'Juli', buyerType: 'WHOLESALE', memorySummary: 'Revende en Villa María; le interesan jeans talle 40-44.' },
    });
    const conv = await db.conversation.create({ data: { contactId: contact.id, status: 'RESOLVED' } });
    await db.message.create({ data: { conversationId: conv.id, direction: 'INBOUND', author: 'CUSTOMER', text: 'Gracias, después te escribo', status: 'RECEIVED', aiHandledAt: new Date(), createdAt: new Date(Date.now() - 86_400_000) } });

    const { c, llm } = createTestContainer();
    llm.push(textReply('¡Hola de nuevo Juli!'));
    await customerSays(c, 'Hola! Volví por los jeans');

    expect((await conversation()).status).toBe('AI_ACTIVE');
    const instructions = String(llm.calls[0]!.instructions);
    expect(instructions).toContain('Villa María');
    expect(instructions).toMatch(/WHOLESALE|mayorista/i);
    expect(JSON.stringify(llm.calls[0]!.input)).toContain('después te escribo');
  });
});

describe('casos de borde', () => {
  it('sin WhatsApp conectado no se pierden mensajes: se responden al reconectar', async () => {
    const { c, llm, transport } = createTestContainer();
    transport.connected = false;
    await customerSays(c, '¿Tenés talle L?');
    expect(llm.calls).toHaveLength(0);
    expect(await db.message.count({ where: { direction: 'INBOUND', aiHandledAt: null } })).toBe(1);

    transport.connected = true;
    llm.push(textReply('Sí, tengo L.'));
    await c.worker.recoverPending();
    await new Promise((r) => setTimeout(r, 50));
    await c.worker.drain();
    expect(transport.sent.map((s) => s.text)).toEqual(['Sí, tengo L.']);
    c.worker.stop();
  });

  it('tras request_human no se ejecutan otras herramientas del mismo lote', async () => {
    const { c, llm } = createTestContainer();
    llm.push(toolCalls(['request_human', { reason: 'Reclamo por un pedido' }], ['view_cart', {}]));
    await customerSays(c, 'Tengo un reclamo');
    const run = await db.aiRun.findFirstOrThrow();
    expect((run.toolCalls as { name: string }[]).map((t) => t.name)).toEqual(['request_human']);
  });

  it('request_human no pisa una conversación que el equipo ya pausó', async () => {
    const { c, llm, transport } = createTestContainer();
    llm.push(async () => {
      const conv = await conversation();
      await db.conversation.update({ where: { id: conv.id }, data: { status: 'AI_PAUSED' } });
      return toolCalls(['request_human', { reason: 'No sé' }]);
    });
    await customerSays(c, 'Hola');
    expect((await conversation()).status).toBe('AI_PAUSED');
    expect(transport.sent).toHaveLength(0);
  });

  it('horario de atención', () => {
    const hours = { days: { mon: [['09:00', '18:00']] } };
    expect(isWithinBusinessHours(hours, new Date('2026-11-16T15:00:00-03:00'))).toBe(true);
    expect(isWithinBusinessHours(hours, new Date('2026-11-16T20:00:00-03:00'))).toBe(false);
    expect(isWithinBusinessHours(hours, new Date('2026-11-15T12:00:00-03:00'))).toBe(false);
    expect(isWithinBusinessHours(null, new Date())).toBeNull();
    expect(isWithinBusinessHours({ days: { mon: [['9:00', '18:00']] } }, new Date('2026-11-16T10:00:00-03:00'))).toBe(true);
    expect(isWithinBusinessHours({ timezone: 'Nope/Nada', days: hours.days }, new Date())).toBeNull();
  });
});

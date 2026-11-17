import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext, type ToolDeps } from '../src/ai/tools.js';
import { seed } from '../src/cli.js';
import { searchKey } from '../src/core/text.js';
import { MediaError, MediaService } from '../src/media/media.service.js';
import { createTestContainer, customerSays, db, inbound, MemoryStorage, resetDb, textReply, toolCalls, type TestContainer } from './helpers.js';

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = (n = 0) => Buffer.concat([PNG, Buffer.from(`extra-${n}`)]);
const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex'), Buffer.alloc(64)]);

describe('claves de búsqueda', () => {
  it('normaliza medidas y letras repetidas', () => {
    expect(searchKey('3 mts x 3 mts')).toBe('3x3');
    expect(searchKey('2 por 3 metros')).toBe('2x3');
    expect(searchKey('Shimmer')).toBe('shimer');
    expect(searchKey('3x3 por favor')).toBe('3x3 por favor');
    expect(searchKey('3 m x 3 m mate')).toBe('3x3 mate');
  });

  it('actualiza los índices viejos de productos al correr el seed', async () => {
    const product = await db.product.create({ data: { name: 'Shimmer 3x3', searchText: 'shimmer 3x3' } });

    await seed(db);
    await seed(db);

    await expect(db.product.findUniqueOrThrow({ where: { id: product.id } })).resolves.toMatchObject({ searchText: 'shimer 3x3' });
  });
});

function depsOf(c: TestContainer): ToolDeps {
  return {
    db: c.db, catalog: c.catalog, cart: c.cart, leads: c.leads, followups: c.followups, handoff: c.handoff,
    settings: c.settings, audit: c.audit, media: c.media, sender: c.sender, services: c.services,
  };
}

async function newConversation(c: TestContainer): Promise<ToolContext> {
  const r = await c.conversations.ingest(inbound('hola'));
  if (r.kind !== 'customer') throw new Error('esperaba cliente');
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: r.conversationId }, include: { contact: true } });
  return { conversationId: conv.id, contact: conv.contact, handedOff: false, mediaSent: 0 };
}

describe('biblioteca multimedia', () => {
  it('valida formato por contenido, tamaño y no duplica archivos', async () => {
    const { c, storage } = createTestContainer();
    const first = await c.media.upload({ data: png(), originalName: 'a.png', fields: { title: 'Glitter dorado', tags: ['Dorado', 'dorado', ' fiesta '] } });
    expect(first.duplicate).toBe(false);
    expect(first.asset).toMatchObject({ kind: 'IMAGE', mime: 'image/png', tags: ['dorado', 'fiesta'] });
    const again = await c.media.upload({ data: png(), originalName: 'otra-copia.png' });
    expect(again).toMatchObject({ duplicate: true, asset: { id: first.asset.id } });
    expect(await db.mediaAsset.count()).toBe(1);
    expect(storage.files.size).toBe(1);

    const video = await c.media.upload({ data: MP4, originalName: 'v.mp4' });
    expect(video.asset).toMatchObject({ kind: 'VIDEO', mime: 'video/mp4' });

    await expect(c.media.upload({ data: Buffer.from('no soy una imagen'), originalName: 'x.jpg' })).rejects.toMatchObject({ code: 'INVALID_FORMAT' });
    const small = new MediaService(db, new MemoryStorage(), { maxImageBytes: 10, maxVideoBytes: 10 });
    await expect(small.upload({ data: png(1) })).rejects.toBeInstanceOf(MediaError);
    await expect(small.upload({ data: png(1) })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('busca solo contenido activo y por producto o servicio', async () => {
    const { c } = createTestContainer();
    const product = await c.catalogAdmin.createProduct({ name: 'Glitter holográfico', variants: [] });
    const a = await c.media.upload({ data: png(1), fields: { title: 'Glitter holográfico en rostro', productId: product.id } });
    await c.media.upload({ data: png(2), fields: { title: 'Pared shimmer plateada', service: 'SHIMMER_WALL' } });
    const off = await c.media.upload({ data: png(3), fields: { title: 'Glitter viejo', active: false } });
    expect((await c.media.search('glitter')).map((m) => m.media_id)).toEqual([a.asset.id]);
    expect(await c.media.search('foto', { service: 'SHIMMER_WALL' })).toHaveLength(1);
    expect((await c.media.search('x', { productId: product.id }))[0]?.product).toBe('Glitter holográfico');
    expect((await c.media.search('viejo')).find((m) => m.media_id === off.asset.id)).toBeUndefined();
  });

  it('la IA busca y envía una foto real por WhatsApp', async () => {
    const { c, llm, transport } = createTestContainer();
    const { asset } = await c.media.upload({ data: png(), fields: { title: 'Glitter Bar en casamiento', service: 'GLITTER_BAR' } });
    llm.push(
      toolCalls(['search_media', { query: 'glitter bar', kind: 'IMAGE', product_id: null, service: 'GLITTER_BAR' }]),
      toolCalls(['send_image', { media_id: asset.id, caption: 'Así queda la Glitter Bar' }]),
      textReply('¡Te mandé una foto de cómo queda!'),
    );
    await customerSays(c, '¿Tenés fotos de la glitter bar?');
    expect(llm.toolOutputs(1)[0]).toMatchObject({ results: [{ media_id: asset.id }] });
    expect(transport.media).toEqual([expect.objectContaining({ kind: 'IMAGE', caption: 'Así queda la Glitter Bar' })]);
    expect(transport.sent.map((s) => s.text)).toEqual(['¡Te mandé una foto de cómo queda!']);
    const msg = await db.message.findFirstOrThrow({ where: { type: 'IMAGE' } });
    expect(msg).toMatchObject({ status: 'SENT', author: 'AI', mediaId: asset.id });
  });

  it('envío: reintenta una vez, falla con archivo faltante, tipo incorrecto o desactivado', async () => {
    const { c, transport, storage } = createTestContainer();
    const deps = depsOf(c);
    const ctx = await newConversation(c);
    const img = (await c.media.upload({ data: png(1) })).asset;
    const vid = (await c.media.upload({ data: MP4 })).asset;

    transport.failMedia = 1;
    expect(await runTool('send_image', JSON.stringify({ media_id: img.id, caption: null }), ctx, deps)).toMatchObject({ ok: true, output: { sent: true } });
    transport.failMedia = 2;
    expect(await runTool('send_image', JSON.stringify({ media_id: img.id, caption: null }), ctx, deps)).toMatchObject({ ok: false, internal: false });
    expect(await runTool('send_image', JSON.stringify({ media_id: vid.id, caption: null }), ctx, deps)).toMatchObject({ ok: false, error: expect.stringContaining('send_video') });

    storage.files.clear();
    const missing = await runTool('send_video', JSON.stringify({ media_id: vid.id, caption: null }), ctx, deps);
    expect(missing).toMatchObject({ ok: false });
    await c.media.update(img.id, { active: false });
    expect(await runTool('send_image', JSON.stringify({ media_id: img.id, caption: null }), ctx, deps)).toMatchObject({ ok: false, error: expect.stringContaining('desactivado') });

    const failed = await db.message.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'asc' } });
    expect(failed.map((m) => m.error)).toEqual(['falla simulada de envío', 'El archivo no está en el almacenamiento']);
    expect(transport.media).toHaveLength(1);
  });

  it('no envía nada si la dueña tomó la conversación o WhatsApp está caído, y limita a 3 por respuesta', async () => {
    const { c, transport } = createTestContainer();
    const deps = depsOf(c);
    const ctx = await newConversation(c);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await c.media.upload({ data: png(i) })).asset.id);

    transport.connected = false;
    expect(await runTool('send_image', JSON.stringify({ media_id: ids[0], caption: null }), ctx, deps)).toMatchObject({ ok: false, error: expect.stringContaining('WhatsApp') });
    transport.connected = true;
    for (const id of ids.slice(0, 3)) await runTool('send_image', JSON.stringify({ media_id: id, caption: null }), ctx, deps);
    expect(await runTool('send_image', JSON.stringify({ media_id: ids[3], caption: null }), ctx, deps)).toMatchObject({ ok: false, error: expect.stringContaining('3 archivos') });
    expect(transport.media).toHaveLength(3);

    await db.conversation.update({ where: { id: ctx.conversationId }, data: { status: 'HUMAN_ACTIVE' } });
    const ctx2 = { ...ctx, mediaSent: 0 };
    expect(await runTool('send_image', JSON.stringify({ media_id: ids[3], caption: null }), ctx2, deps)).toMatchObject({ ok: true, output: { sent: false } });
    expect(ctx2.handedOff).toBe(true);
    expect(transport.media).toHaveLength(3);
  });
});

describe('catálogo propio y servicios', () => {
  it('busca productos con errores de tipeo y medidas escritas de distintas formas', async () => {
    const { c } = createTestContainer();
    await c.catalogAdmin.createProduct({ name: 'Shimmer 3x3' });
    await c.catalogAdmin.createProduct({ name: 'Glitter holográfico plateado' });

    for (const query of ['shimer wall de 3 mts x 3 mts', 'shimmer 3 x 3', 'pared shimmer 3m x 3m', 'SHIMMER 3X3']) {
      expect((await c.catalog.search(query)).results.map((p) => p.name)).toContain('Shimmer 3x3');
    }
    expect((await c.catalog.search('gliter holografico')).results.map((p) => p.name)).toContain('Glitter holográfico plateado');
  });

  it('precio y stock opcionales: sin dato la IA recibe null y nunca un valor inventado', async () => {
    const { c } = createTestContainer();
    const cat = await c.catalogAdmin.saveCategory({ name: 'Glitter' });
    const p = await c.catalogAdmin.createProduct({
      name: 'Glitter corporal',
      features: 'Brillo biodegradable apto piel',
      usage: 'Se aplica con gel fijador',
      faqs: [{ q: '¿Es lavable?', a: 'Sí, sale con agua y jabón' }],
      categoryIds: [cat.id],
      variants: [
        { values: ['Dorado'], retailPrice: 3500, wholesalePrice: null, stock: 10 },
        { values: ['Plateado'], retailPrice: null, stock: null },
      ],
    });
    const found = await c.catalog.search('biodegradable');
    expect(found.results.map((r) => r.name)).toEqual(['Glitter corporal']);
    const details = await c.catalog.details(p.id, 'WHOLESALE');
    expect(details).toMatchObject({ features: 'Brillo biodegradable apto piel', categories: ['Glitter'] });
    const plateado = details!.variants.find((v) => v.options === 'Plateado')!;
    expect(plateado).toMatchObject({ retail_price: null, stock: { status: 'UNKNOWN', quantity: null } });
    const dorado = details!.variants.find((v) => v.options === 'Dorado')!;
    expect(await c.catalog.price(dorado.variant_id, 'WHOLESALE')).toMatchObject({ amount: null, retail_amount: 3500 });

    await c.catalogAdmin.updateProduct(p.id, { variants: [{ id: dorado.variant_id, values: ['Dorado'], retailPrice: 3900 }] });
    expect(await c.catalog.price(dorado.variant_id, 'RETAIL')).toMatchObject({ amount: 3900 });
    expect(await db.variantPrice.count({ where: { variantId: dorado.variant_id } })).toBe(2);
    expect((await c.catalog.details(p.id))!.variants).toHaveLength(1);

    await c.catalogAdmin.deleteProduct(p.id);
    expect((await c.catalog.search('glitter')).results).toHaveLength(0);
  });

  it('servicios: sin descripción cargada se informa como no configurado', async () => {
    const { c } = createTestContainer();
    expect(await c.services.forAi('GLITTER_BAR')).toMatchObject({ configured: false });
    await c.services.update('GLITTER_BAR', { description: 'Barra de maquillaje con glitter para eventos', faqs: [{ q: '¿Viajan?', a: 'Sí, a todo Córdoba' }] });
    expect(await c.services.forAi('GLITTER_BAR')).toMatchObject({ configured: true, conditions: null, faqs: [{ q: '¿Viajan?' }] });
  });
});

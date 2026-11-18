import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import type { ExtractedItem } from '../src/knowledge/knowledge.service.js';
import { createTestContainer, customerSays, db, resetDb, textReply, type TestContainer } from './helpers.js';

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const CHAT_A = [
  '10/11/2026, 10:00 - Juana Pérez: Hola! Vendés por mayor? mi cel es 351 555 1234',
  '10/11/2026, 10:05 - Male Style: Hola Juana! 💖 Sí, el mínimo de compra mayorista es de diez unidades',
  '10/11/2026, 10:06 - Male Style: IMG-20261110-WA0001.jpg (archivo adjunto)',
  '10/11/2026, 10:07 - Juana Pérez: Genial, gracias',
].join('\n');
const CHAT_A_MORE = `${CHAT_A}\n11/11/2026, 09:00 - Juana Pérez: Ya te transferí\n11/11/2026, 09:10 - Male Style: Recibido! Lo despacho hoy por correo 📦`;

const item = (over: Partial<ExtractedItem> = {}): ExtractedItem => ({
  kind: 'POLICY',
  title: 'Mínimo mayorista',
  content: 'El mínimo de compra mayorista es de diez unidades',
  temporal: false,
  confidence: 0.6,
  excerpt: 'el mínimo de compra mayorista es de diez unidades',
  ...over,
});
const extraction = (...items: ExtractedItem[]) => textReply(JSON.stringify({ items }));

async function importText(c: TestContainer, text: string, ownerName = 'Male Style', fileName = 'chat.txt') {
  return c.chatImport.import({ data: Buffer.from(text), fileName, ownerName, consent: true, mediaConsent: true });
}

describe('importación de chats', () => {
  it('pide elegir la dueña, anonimiza, no duplica y es incremental entre exports solapados', async () => {
    const { c } = createTestContainer();
    expect(c.chatImport.preview(Buffer.from(CHAT_A), 'chat.txt')).toMatchObject({
      participants: ['Juana Pérez', 'Male Style'],
      messagesByParticipant: { 'Juana Pérez': 2, 'Male Style': 2 },
    });
    await expect(importText(c, CHAT_A, 'Otra')).rejects.toMatchObject({ participants: ['Juana Pérez', 'Male Style'] });
    await expect(c.chatImport.import({ data: Buffer.from(CHAT_A), fileName: 'c.txt', ownerName: 'Male Style', consent: false, mediaConsent: false })).rejects.toThrow('Confirmá');

    const first = await importText(c, CHAT_A);
    expect(first).toMatchObject({ duplicate: false, inserted: 4 });
    const msgs = await db.importedMessage.findMany({ orderBy: { position: 'asc' } });
    expect(msgs.map((m) => [m.author, m.fromOwner])).toEqual([['Cliente 1', false], ['Dueña', true], ['Dueña', true], ['Cliente 1', false]]);
    expect(msgs[0]!.text).toBe('Hola! Vendés por mayor? mi cel es [teléfono]');
    expect(msgs[1]!.text).toContain('Hola Cliente 1!');
    expect(JSON.stringify(msgs)).not.toContain('Juana');

    expect(await importText(c, CHAT_A)).toMatchObject({ duplicate: true, inserted: 0 });
    expect(await importText(c, CHAT_A_MORE)).toMatchObject({ duplicate: false, inserted: 2, skipped: 4 });
    expect(await db.importedMessage.count()).toBe(6);
    // Un participante nuevo en un export posterior no cambia las claves de lo ya importado.
    const third = `${CHAT_A_MORE}\n12/11/2026, 08:00 - Correo Andreani: Su envío está en camino`;
    expect(await importText(c, third)).toMatchObject({ duplicate: false, inserted: 1, skipped: 6 });
    expect(await db.importedMessage.count()).toBe(7);
    expect(await db.job.count({ where: { type: 'knowledge.extract' } })).toBe(3);
  });

  it('mismo texto a la misma hora en chats distintos no se pierde; el nombre del export no se guarda', async () => {
    const { c } = createTestContainer();
    const other = CHAT_A.replaceAll('Juana Pérez', 'Pedro Gómez').replace('mi cel es 351 555 1234', 'hola');
    await importText(c, CHAT_A, 'Male Style', 'Chat de WhatsApp con Juana Pérez.txt');
    const r = await importText(c, other);
    expect(r).toMatchObject({ duplicate: false, inserted: 4 });
    const chats = await db.importedChat.findMany();
    expect(JSON.stringify(chats)).not.toContain('Juana');
  });

  it('borra un conocimiento consolidado cuando se elimina cualquiera de sus chats fuente', async () => {
    const { c } = createTestContainer();
    const first = await importText(c, CHAT_A);
    const second = await importText(c, CHAT_A.replaceAll('Juana Pérez', 'Ana'));
    const merged = await db.knowledgeDocument.create({
      data: {
        kind: 'POLICY',
        title: 'Conocimiento combinado',
        content: 'Mezcla información de ambos chats',
        consolidated: true,
        sources: {
          create: [
            { chatId: first.chat.id, excerpt: 'Fuente del chat A' },
            { chatId: second.chat.id, excerpt: 'Fuente del chat B' },
          ],
        },
      },
    });
    const shared = await db.knowledgeDocument.create({
      data: {
        kind: 'POLICY',
        title: 'Conocimiento todavía compartido',
        content: 'Conserva fuentes de chats distintos',
        sources: {
          create: [
            { chatId: first.chat.id, excerpt: 'Fuente original A' },
            { chatId: second.chat.id, excerpt: 'Fuente original B' },
          ],
        },
      },
    });

    expect(await c.chatImport.remove(first.chat.id)).toMatchObject({ deletedDocuments: 1 });
    expect(await db.knowledgeDocument.findUnique({ where: { id: merged.id } })).toBeNull();
    expect(await db.importedChat.findUnique({ where: { id: second.chat.id } })).not.toBeNull();
    expect(await db.knowledgeDocument.findUnique({ where: { id: shared.id }, include: { sources: true } })).toMatchObject({
      id: shared.id,
      sources: [{ chatId: second.chat.id }],
    });
  });

  it('exports solapados con más historia previa no duplican; chats que arrancan igual no se pisan', async () => {
    const { c } = createTestContainer();
    const opening = '10/11/2026, 09:00 - Male Style: Hola! Gracias por escribir 💖';
    await importText(c, `${opening}\n10/11/2026, 09:01 - Juana Pérez: Hola, precio del glitter?`);
    expect(await importText(c, `${opening}\n10/11/2026, 09:01 - Pedro Gómez: Hola, hacen eventos?`)).toMatchObject({ inserted: 2 });
    const longer = `09/11/2026, 20:00 - Juana Pérez: Te escribo mañana\n${opening}\n10/11/2026, 09:01 - Juana Pérez: Hola, precio del glitter?`;
    expect(await importText(c, longer)).toMatchObject({ inserted: 1, skipped: 2 });
    const twice = `${longer}\n10/11/2026, 09:02 - Male Style: Dale!\n10/11/2026, 09:02 - Juana Pérez: Y el de 50g?\n10/11/2026, 09:02 - Male Style: Dale!`;
    expect(await importText(c, twice)).toMatchObject({ inserted: 3, skipped: 3 });
  });

  it('una importación que falla no queda a medias y se puede reintentar', async () => {
    const { c } = createTestContainer();
    const zip = new AdmZip();
    zip.addFile('chat.txt', Buffer.from(CHAT_A));
    zip.addFile('IMG-20261110-WA0001.jpg', PNG);
    const upload = c.media.upload.bind(c.media);
    c.media.upload = () => Promise.reject(new Error('disco lleno'));
    const params = { data: zip.toBuffer(), fileName: 'chat.zip', ownerName: 'Male Style', consent: true, mediaConsent: true };
    await expect(c.chatImport.import(params)).rejects.toThrow('disco lleno');
    expect(await db.importedChat.count()).toBe(0);
    c.media.upload = upload;
    expect(await c.chatImport.import(params)).toMatchObject({ duplicate: false, inserted: 4, mediaImported: 1 });
  });

  it('ZIP con adjuntos: los medios entran desactivados; los inválidos se registran', async () => {
    const { c } = createTestContainer();
    const zip = new AdmZip();
    zip.addFile('WhatsApp Chat con Juana.txt', Buffer.from(`${CHAT_A}\n10/11/2026, 10:08 - Juana Pérez: doc.pdf (archivo adjunto)`));
    zip.addFile('IMG-20261110-WA0001.jpg', PNG);
    zip.addFile('doc.pdf', Buffer.from('%PDF-1.4 no permitido'));
    zip.addFile('../../etc/passwd', Buffer.from('x'));
    const r = await c.chatImport.import({ data: zip.toBuffer(), fileName: 'chat.zip', ownerName: 'male style', consent: true, mediaConsent: true });
    expect(r).toMatchObject({ inserted: 5, mediaImported: 1 });
    expect(r.mediaErrors).toHaveLength(1);
    expect(await db.mediaAsset.findFirstOrThrow()).toMatchObject({ source: 'IMPORT', active: false, importedChatId: r.chat.id });
    await expect(c.chatImport.import({ data: Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('roto')]), fileName: 'x.zip', ownerName: 'a', consent: true, mediaConsent: false })).rejects.toThrow('ZIP');
  });
});

describe('conocimiento', () => {
  it('agrupa pendientes por tipo, conserva fuentes y confianza, y excluye conflictos y otros tipos', async () => {
    const { c, llm } = createTestContainer();
    const createDocument = (input: {
      kind: 'POLICY' | 'FAQ';
      title: string;
      content: string;
      confidence?: number;
      status?: 'PENDING' | 'CONFLICT';
      conflictWithId?: string | null;
    }) =>
      db.knowledgeDocument.create({
        data: {
          kind: input.kind,
          title: input.title,
          content: input.content,
          confidence: input.confidence ?? 0.5,
          status: input.status ?? 'PENDING',
          conflictWithId: input.conflictWithId ?? null,
          sources: { create: { excerpt: `Fuente de ${input.title}` } },
          chunks: { create: { kind: 'DOCUMENT', text: `${input.title}\n${input.content}`, active: false } },
        },
      });
    const first = await createDocument({ kind: 'POLICY', title: 'Envíos', content: 'x'.repeat(700), confidence: 0.4 });
    const second = await createDocument({ kind: 'POLICY', title: 'Envíos nacionales', content: 'Entrega a todo el país', confidence: 0.9 });
    const third = await createDocument({ kind: 'POLICY', title: 'Plazos de envío', content: 'Los pedidos se despachan según disponibilidad', confidence: 0.6 });
    const fourth = await createDocument({ kind: 'POLICY', title: 'Resto personal', content: 'Charla aislada', confidence: 0.3 });
    const protectedDocument = await createDocument({
      kind: 'POLICY',
      title: 'Pendiente con conflicto',
      content: 'No debe agruparse con el conflicto',
    });
    const conflict = await createDocument({
      kind: 'POLICY',
      title: 'Envíos en conflicto',
      content: 'Otro plazo',
      status: 'CONFLICT',
      conflictWithId: protectedDocument.id,
    });
    const faq = await createDocument({ kind: 'FAQ', title: 'Pregunta frecuente', content: 'Una respuesta' });
    llm.push(
      textReply(
        JSON.stringify({
          topics: [
            { title: 'Envíos agrupados', content: 'Indicá que se realizan envíos a todo el país.', temporal: true, ids: ['1', '2'] },
            { title: 'Plazos de envío', content: third.content, temporal: false, ids: ['3', '2', '99'] },
          ],
          discard: ['1', '4', '99'],
        }),
      ),
    );

    expect(await c.knowledge.consolidate('POLICY')).toBe(2);
    const request = llm.calls[0]!;
    const requestInput = String(request.input);
    expect(request.instructions).toContain('de tipo "políticas"');
    expect(request.max_output_tokens).toBe(12_000);
    expect(requestInput).toContain('[1] Envíos\n');
    expect(requestInput.split('\n\n')[0]).toHaveLength('[1] Envíos\n'.length + 700);
    expect(requestInput).not.toContain(conflict.title);
    expect(requestInput).not.toContain(protectedDocument.title);
    expect(requestInput).not.toContain(faq.title);

    expect(await db.knowledgeDocument.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await db.knowledgeDocument.findUnique({ where: { id: second.id } })).toBeNull();
    const merged = await db.knowledgeDocument.findFirstOrThrow({ where: { kind: 'POLICY', title: 'Envíos agrupados' }, include: { sources: true } });
    expect(merged).toMatchObject({ status: 'PENDING', confidence: 0.9, temporal: true, consolidated: true });
    expect(merged.sources.map((source) => source.excerpt).sort()).toEqual(['Fuente de Envíos', 'Fuente de Envíos nacionales'].sort());
    const mergedChunk = await db.$queryRaw<{ embedding: string | null }[]>`
      SELECT embedding::text AS embedding FROM knowledge_chunks WHERE document_id = ${merged.id}::uuid AND kind = 'DOCUMENT'`;
    expect(mergedChunk).toHaveLength(1);
    expect(mergedChunk[0]?.embedding).not.toBeNull();

    expect(await db.knowledgeDocument.findUnique({ where: { id: third.id } })).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await db.knowledgeDocument.findUnique({ where: { id: fourth.id } })).toMatchObject({ status: 'REJECTED' });
    expect(await db.knowledgeReview.findFirst({ where: { documentId: fourth.id, action: 'rejected' } })).toMatchObject({ note: 'Descartado al agrupar' });
    expect(await db.knowledgeDocument.findUnique({ where: { id: protectedDocument.id } })).toMatchObject({ status: 'PENDING' });
    expect(await db.knowledgeDocument.findUnique({ where: { id: conflict.id } })).toMatchObject({ status: 'CONFLICT', conflictWithId: protectedDocument.id });
    expect(await db.knowledgeDocument.findUnique({ where: { id: faq.id } })).toMatchObject({ status: 'PENDING' });
  });

  it('preserva el indicador temporal al editar en solitario y al fusionar', async () => {
    const { c, llm } = createTestContainer();
    const single = await db.knowledgeDocument.create({
      data: { kind: 'POLICY', title: 'A', content: 'Contenido A', temporal: true },
    });
    await db.knowledgeDocument.create({
      data: { kind: 'POLICY', title: 'B', content: 'Contenido B', temporal: true },
    });
    await db.knowledgeDocument.create({
      data: { kind: 'POLICY', title: 'C', content: 'Contenido C', temporal: false },
    });
    llm.push(
      textReply(
        JSON.stringify({
          topics: [
            { title: 'A actualizado', content: 'Contenido A actualizado', temporal: false, ids: ['1'] },
            { title: 'Fusionado', content: 'Contenido combinado', temporal: false, ids: ['2', '3'] },
          ],
          discard: [],
        }),
      ),
    );

    expect(await c.knowledge.consolidate('POLICY')).toBe(1);
    expect(await db.knowledgeDocument.findUnique({ where: { id: single.id } })).toMatchObject({
      title: 'A actualizado',
      content: 'Contenido A actualizado',
      temporal: true,
      version: 2,
    });
    expect(await db.knowledgeDocument.findFirstOrThrow({ where: { kind: 'POLICY', title: 'Fusionado' } })).toMatchObject({
      temporal: true,
      consolidated: true,
    });
  });

  it('no modifica documentos que cambiaron mientras se generaba la respuesta de agrupación', async () => {
    const { c, llm } = createTestContainer();
    const [first, second, third, fourth] = await Promise.all(
      ['A', 'B', 'C', 'D'].map((title) =>
        db.knowledgeDocument.create({ data: { kind: 'POLICY', title, content: `Contenido original ${title}` } }),
      ),
    );
    llm.push(async () => {
      await c.knowledge.edit(first!.id, { content: 'Edición concurrente de A' }, null);
      await c.knowledge.edit(third!.id, { content: 'Edición concurrente de C' }, null);
      await c.knowledge.edit(fourth!.id, { content: 'Edición concurrente de D' }, null);
      return textReply(
        JSON.stringify({
          topics: [
            { title: 'Agrupado', content: 'Contenido combinado', temporal: false, ids: ['1', '2'] },
            { title: 'Reescrito por el modelo', content: 'No debe reemplazar la edición', temporal: false, ids: ['3'] },
          ],
          discard: ['4'],
        }),
      );
    });

    expect(await c.knowledge.consolidate('POLICY')).toBe(0);
    expect(await db.knowledgeDocument.findUnique({ where: { id: first!.id } })).toMatchObject({
      content: 'Edición concurrente de A',
      status: 'PENDING',
      version: 2,
    });
    expect(await db.knowledgeDocument.findUnique({ where: { id: second!.id } })).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await db.knowledgeDocument.findUnique({ where: { id: third!.id } })).toMatchObject({
      content: 'Edición concurrente de C',
      status: 'PENDING',
      version: 2,
    });
    expect(await db.knowledgeDocument.findUnique({ where: { id: fourth!.id } })).toMatchObject({
      content: 'Edición concurrente de D',
      status: 'PENDING',
      version: 2,
    });
    expect(await db.knowledgeDocument.count({ where: { kind: 'POLICY' } })).toBe(4);
  });

  it('encola la agrupación y permite aprobar en lote con conteo de fallos', async () => {
    const { c } = createTestContainer();
    await c.auth.createUser({ email: 'admin@knowledge.test', name: 'Admin', password: 'clave-admin-123', roleCode: 'admin' });
    const app: FastifyInstance = await buildServer(c, { panelDir: '/no-existe' });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@knowledge.test', password: 'clave-admin-123' } });
      const cookie = login.cookies.find((entry) => entry.name === 'bot_session');
      const headers = { cookie: cookie ? `bot_session=${cookie.value}` : '' };
      const queued = await app.inject({ method: 'POST', url: '/api/knowledge/consolidate', headers, payload: {} });
      expect(queued.json()).toEqual({ queued: true });
      expect(await db.job.count({ where: { type: 'knowledge.consolidate', status: 'PENDING' } })).toBe(1);

      const documents = await Promise.all(
        ['Envíos', 'Pagos'].map((title) =>
          db.knowledgeDocument.create({ data: { kind: 'POLICY', title, content: `Contenido de ${title}` } }),
        ),
      );
      expect((await app.inject({ url: '/api/knowledge?take=1', headers })).json().documents).toHaveLength(1);
      expect((await app.inject({ url: '/api/knowledge?take=501', headers })).statusCode).toBe(400);
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/bulk-status',
        headers,
        payload: { ids: [...documents.map((document) => document.id), '00000000-0000-4000-8000-000000000000'], status: 'APPROVED' },
      });
      expect(response.json()).toEqual({ updated: 2, failed: 1 });
      expect(await db.knowledgeDocument.count({ where: { id: { in: documents.map((document) => document.id) }, status: 'APPROVED' } })).toBe(2);
      expect(await db.auditLog.findFirst({ where: { action: 'knowledge.bulk_approved' } })).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('un conocimiento casi idéntico pero con otro valor se revisa como contradicción, no como duplicado', async () => {
    const same = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    const { c, llm } = createTestContainer({ embedder: { embed: async (texts: string[]) => texts.map(() => same) } });
    expect(await c.knowledge.addItem(item(), null)).toBe('created');
    expect(await c.knowledge.addItem(item({ excerpt: 'otra vez' }), null)).toBe('duplicate');
    llm.push(textReply(JSON.stringify({ contradicts: true, note: 'diez vs veinte' })));
    expect(await c.knowledge.addItem(item({ content: 'El mínimo de compra mayorista es de veinte unidades' }), null)).toBe('conflict');
    llm.push(textReply(JSON.stringify({ contradicts: false, note: '' })));
    expect(await c.knowledge.addItem(item({ content: 'El mínimo de compra mayorista es de diez unidades, surtidas' }), null)).toBe('duplicate');
  });

  it('extrae, une duplicados, marca contradicciones y solo usa lo aprobado en las respuestas', async () => {
    const { c, llm, transport } = createTestContainer();
    const a = await importText(c, CHAT_A);
    llm.push(extraction(item(), item({ excerpt: 'otra vez' }), item({ kind: 'STYLE', title: 'Saludo', content: 'Saluda con calidez y usa el emoji 💖', excerpt: 'Hola! 💖' })));
    expect(await c.jobs.runOnce()).toBe(1);
    expect(await db.importedChat.findUniqueOrThrow({ where: { id: a.chat.id } })).toMatchObject({ status: 'DONE' });
    const docs = await db.knowledgeDocument.findMany({ include: { sources: true }, orderBy: { title: 'asc' } });
    expect(docs.map((d) => [d.title, d.status, d.sources.length])).toEqual([['Mínimo mayorista', 'PENDING', 2], ['Saludo', 'PENDING', 1]]);
    expect(docs[0]!.confidence).toBeCloseTo(0.7);
    expect(await db.knowledgeChunk.count({ where: { kind: 'EXAMPLE' } })).toBe(1);

    // Pendiente: todavía no se usa.
    expect((await c.knowledge.retrieve('cual es el minimo para comprar mayorista')).documents).toHaveLength(0);
    const minimo = docs[0]!;
    await c.knowledge.setStatus(minimo.id, 'APPROVED', null);
    const found = await c.knowledge.retrieve('cual es el minimo para comprar mayorista');
    expect(found.documents.map((d) => d.id)).toEqual([minimo.id]);

    // Otro chat dice algo distinto: queda en conflicto con la fuente anterior.
    const b = await importText(c, CHAT_A.replace(/Juana Pérez/g, 'Ana').replace('diez', 'veinte'), 'Male Style', 'b.txt');
    llm.push(extraction(item({ content: 'El mínimo de compra mayorista es de veinte unidades' })), textReply(JSON.stringify({ contradicts: true, note: 'diez vs veinte' })));
    await c.jobs.runOnce();
    const conflict = await db.knowledgeDocument.findFirstOrThrow({ where: { status: 'CONFLICT' } });
    expect(conflict).toMatchObject({ conflictWithId: minimo.id, conflictNote: 'diez vs veinte' });

    // La IA recibe solo lo aprobado y relevante, y queda registrado qué usó.
    llm.push(textReply('El mínimo mayorista es de diez unidades 💖'));
    await customerSays(c, 'Hola, cuál es el mínimo de compra mayorista?');
    const instructions = (llm.calls[llm.calls.length - 1] as { instructions: string }).instructions;
    const [knowledgeSection, examplesSection] = instructions.split('Ejemplos reales de cómo responde la dueña');
    expect(knowledgeSection).toContain('Conocimiento aprendido');
    expect(knowledgeSection).toContain('diez unidades');
    expect(knowledgeSection).not.toContain('veinte unidades');
    // Los ejemplos de chats solo enseñan el tono; el prompt aclara que no se copian datos.
    expect(examplesSection).toContain('Dueña:');
    expect(transport.sent.at(-1)?.text).toContain('diez');
    const run = await db.aiRun.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(run.toolCalls).toEqual([expect.objectContaining({ name: 'rag', args: expect.objectContaining({ documents: [minimo.id] }) })]);

    // Aprobar la versión nueva desactiva la anterior.
    await c.knowledge.setStatus(conflict.id, 'APPROVED', null);
    expect(await db.knowledgeDocument.findUniqueOrThrow({ where: { id: minimo.id } })).toMatchObject({ status: 'DISABLED' });
    expect((await c.knowledge.retrieve('minimo mayorista')).documents.map((d) => d.id)).toEqual([conflict.id]);

    // Editar versiona y guarda el antes; borrar el chat B borra lo que solo salía de él.
    await c.knowledge.edit(conflict.id, { content: 'El mínimo mayorista es de veinte unidades surtidas' }, null);
    expect(await db.knowledgeDocument.findUniqueOrThrow({ where: { id: conflict.id } })).toMatchObject({ version: 2 });
    expect(await db.knowledgeReview.count({ where: { documentId: conflict.id } })).toBe(2);
    expect(await c.chatImport.remove(b.chat.id)).toMatchObject({ deletedDocuments: 1 });
    expect(await db.knowledgeDocument.count({ where: { id: minimo.id } })).toBe(1);
  });

  it('un error de OpenAI deja el chat en FAILED y el trabajo se reintenta', async () => {
    const { c, llm } = createTestContainer();
    const a = await importText(c, CHAT_A);
    llm.push(textReply('esto no es JSON'));
    await c.jobs.runOnce();
    expect(await db.importedChat.findUniqueOrThrow({ where: { id: a.chat.id } })).toMatchObject({ status: 'FAILED' });
    expect(await db.job.findFirstOrThrow()).toMatchObject({ status: 'PENDING', attempts: 1 });
  });

  it('lo rechazado no vuelve a proponerse', async () => {
    const { c } = createTestContainer();
    expect(await c.knowledge.addItem(item(), null)).toBe('created');
    const doc = await db.knowledgeDocument.findFirstOrThrow();
    await c.knowledge.setStatus(doc.id, 'REJECTED', null);
    expect(await c.knowledge.addItem(item(), null)).toBe('rejected');
    expect(await db.knowledgeDocument.count()).toBe(1);
  });
});

describe('historial de WhatsApp al vincular', () => {
  const msg = (jid: string, fromMe: boolean, text: string, minute: number) => ({
    externalId: `${jid}-${minute}`, chatJid: jid, altJid: null, fromMe, pushName: fromMe ? null : 'Juana Pérez',
    type: 'TEXT' as const, text, mediaMime: null, timestamp: new Date(Date.UTC(2026, 10, 10, 10, minute)),
  });

  it('aprende de los chats con respuestas de la dueña, anonimiza, no responde y no duplica', async () => {
    const { c, transport } = createTestContainer();
    const venta = '5493511111111@s.whatsapp.net';
    const sinDuena = '5493512222222@s.whatsapp.net';
    const history = [
      msg(venta, false, 'Hola! soy Juana, vendés por mayor?', 0),
      msg(venta, true, 'Hola Juana! Sí, el mínimo mayorista es de diez unidades', 1),
      msg(venta, false, 'Genial, mi cel es 351 555 1234', 2),
      msg(venta, true, 'Te espero 💖', 3),
      ...[0, 1, 2, 3].map((i) => msg(sinDuena, false, `Promo ${i}`, i)),
    ];
    expect(await c.chatImport.importHistory(history, 'Male Style')).toEqual({ imported: 1 });
    const stored = await db.importedMessage.findMany({ orderBy: { position: 'asc' } });
    expect(stored).toHaveLength(4);
    expect(stored.map((m) => m.author)).toEqual(['Cliente 1', 'Dueña', 'Cliente 1', 'Dueña']);
    expect(stored.some((m) => /Juana|351 555/.test(m.text ?? ''))).toBe(false);
    expect(await db.job.count({ where: { type: 'knowledge.extract' } })).toBe(1);
    expect(transport.sent).toHaveLength(0);
    expect(await c.chatImport.importHistory(history, 'Male Style')).toEqual({ imported: 0 });
    // El mismo chat informado como LID con el número como alternativo no se duplica.
    const asLid = history.filter((m) => m.chatJid === venta).map((m) => ({ ...m, chatJid: '123456@lid', altJid: venta }));
    expect(await c.chatImport.importHistory(asLid, 'Male Style')).toEqual({ imported: 0 });
  });

  it('no aprende de contactos silenciados aunque lleguen con otro id', async () => {
    const { c } = createTestContainer();
    const venta = '5493511111111@s.whatsapp.net';
    await db.contact.create({ data: { waJid: '999@lid', waAltJid: venta, botMuted: true } });
    const chat = [0, 1, 2, 3].map((i) => msg(venta, i % 2 === 1, `Mensaje ${i}`, i));
    expect(await c.chatImport.importHistory(chat)).toEqual({ imported: 0 });
    const viejo = [0, 1, 2, 3].map((i) => ({ ...msg('5493514444444@s.whatsapp.net', i % 2 === 1, `Viejo ${i}`, i), timestamp: new Date(Date.UTC(2024, 0, 1, 10, i)) }));
    expect(await c.chatImport.importHistory(viejo)).toEqual({ imported: 0 });
  });
});

import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ImportError } from '../../knowledge/import.service.js';
import { HttpError, requirePermission, requireUser } from '../auth.js';
import { parse } from '../validate.js';

const id = z.string().uuid();
const kind = z.enum(['STYLE', 'FAQ', 'PRODUCT', 'SERVICE', 'POLICY', 'OBJECTION', 'SALES_PROCESS', 'OTHER']);

async function readUpload(request: Parameters<typeof requireUser>[0]) {
  const file = await request.file();
  if (!file) throw new HttpError(400, 'Falta el archivo');
  const data = await file.toBuffer().catch(() => {
    throw new HttpError(413, 'El archivo es demasiado grande');
  });
  const fields = Object.fromEntries(
    Object.entries(file.fields).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : undefined]),
  ) as Record<string, string | undefined>;
  return { data, fileName: file.filename, fields };
}

function importHttpError(error: unknown): never {
  if (error instanceof ImportError) throw new HttpError(400, error.message, error.participants ? { participants: error.participants } : undefined);
  throw error;
}

/** Centro de conocimiento: importación de chats, revisión y aprobación de lo aprendido. */
export function registerKnowledgeRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requirePermission('knowledge'));
    await app.register(multipart, { limits: { fileSize: c.env.IMPORT_MAX_MB * 1024 * 1024, files: 1, fields: 10 } });

    app.post('/imports/preview', async (request) => {
      const { data, fileName } = await readUpload(request);
      try {
        return c.chatImport.preview(data, fileName);
      } catch (error) {
        importHttpError(error);
      }
    });

    app.post('/imports', async (request) => {
      const { data, fileName, fields } = await readUpload(request);
      const user = requireUser(request);
      const result = await c.chatImport
        .import({
          data,
          fileName,
          ownerName: fields.ownerName ?? '',
          consent: fields.consent === 'true',
          mediaConsent: fields.mediaConsent === 'true',
          userId: user.id,
        })
        .catch(importHttpError);
      if (!result.duplicate) {
        await c.audit.log({ actorType: 'USER', actorId: user.id, action: 'import.created', entityType: 'imported_chat', entityId: result.chat.id, data: { messages: result.inserted } });
      }
      return result;
    });

    app.get('/imports', async () => ({
      imports: await c.db.importedChat.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { sources: true, chunks: true } } },
      }),
    }));

    app.get('/imports/:id/messages', async (request) => {
      const { id: chatId } = parse(z.object({ id }), request.params);
      const q = parse(z.object({ offset: z.coerce.number().int().min(0).default(0) }), request.query);
      return {
        messages: await c.db.importedMessage.findMany({ where: { chatId }, orderBy: [{ sentAt: 'asc' }, { position: 'asc' }], skip: q.offset, take: 200 }),
      };
    });

    app.post('/imports/:id/reprocess', async (request) => {
      const { id: chatId } = parse(z.object({ id }), request.params);
      await c.db.importedChat.update({ where: { id: chatId }, data: { status: 'PENDING', error: null } });
      await c.jobs.enqueue('knowledge.extract', { chatId });
      return { ok: true };
    });

    app.patch('/imports/:id', async (request) => {
      const { id: chatId } = parse(z.object({ id }), request.params);
      const body = parse(z.object({ examplesActive: z.boolean() }), request.body);
      return { updated: await c.knowledge.setChatExamples(chatId, body.examplesActive) };
    });

    app.delete('/imports/:id', async (request) => {
      const { id: chatId } = parse(z.object({ id }), request.params);
      const result = await c.chatImport.remove(chatId);
      await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: 'import.deleted', entityType: 'imported_chat', entityId: chatId, data: result });
      return result;
    });

    app.get('/knowledge', async (request) => {
      const q = parse(
        z.object({
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'DISABLED', 'CONFLICT']).optional(),
          kind: kind.optional(),
          q: z.string().max(100).optional(),
        }),
        request.query,
      );
      const where = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' as const } }, { content: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
      };
      const [documents, counts] = await Promise.all([
        c.db.knowledgeDocument.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          take: 200,
          include: {
            sources: { take: 5, orderBy: { createdAt: 'desc' }, include: { chat: { select: { id: true, fileName: true } } } },
            conflictWith: { select: { id: true, title: true, content: true, status: true } },
            _count: { select: { sources: true } },
          },
        }),
        c.db.knowledgeDocument.groupBy({ by: ['status'], _count: true }),
      ]);
      return { documents, counts: Object.fromEntries(counts.map((r) => [r.status, r._count])) };
    });

    app.post('/knowledge', async (request) => {
      const body = parse(z.object({ kind, title: z.string().min(1).max(200), content: z.string().min(1).max(3000), temporal: z.boolean().optional() }), request.body);
      return { document: await c.knowledge.createManual(body, requireUser(request).id) };
    });

    app.patch('/knowledge/:id', async (request) => {
      const { id: docId } = parse(z.object({ id }), request.params);
      const body = parse(
        z.object({ kind: kind.optional(), title: z.string().min(1).max(200).optional(), content: z.string().min(1).max(3000).optional(), temporal: z.boolean().optional() }),
        request.body,
      );
      return { document: await c.knowledge.edit(docId, body, requireUser(request).id) };
    });

    app.post('/knowledge/:id/status', async (request) => {
      const { id: docId } = parse(z.object({ id }), request.params);
      const body = parse(z.object({ status: z.enum(['APPROVED', 'REJECTED', 'DISABLED']), note: z.string().max(500).nullable().optional() }), request.body);
      const user = requireUser(request);
      const document = await c.knowledge.setStatus(docId, body.status, user.id, body.note);
      await c.audit.log({ actorType: 'USER', actorId: user.id, action: `knowledge.${body.status.toLowerCase()}`, entityType: 'knowledge', entityId: docId });
      return { document };
    });

    app.get('/knowledge/:id/reviews', async (request) => {
      const { id: docId } = parse(z.object({ id }), request.params);
      return { reviews: await c.db.knowledgeReview.findMany({ where: { documentId: docId }, orderBy: { createdAt: 'desc' } }) };
    });

    app.post('/knowledge/search', async (request) => {
      const body = parse(z.object({ query: z.string().min(1).max(500) }), request.body);
      return c.knowledge.retrieve(body.query);
    });

    app.get('/jobs', async () => ({ jobs: await c.db.job.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) }));
  };
}

import type { ConversationStatus, Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { normalize } from '../../core/text.js';
import { HttpError, requirePermission, requireUser } from '../auth.js';
import { parse } from '../validate.js';

const STATUSES = ['AI_ACTIVE', 'HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'AI_PAUSED', 'RESOLVED'] as const;
const idParams = z.object({ id: z.string().uuid() });

export function registerConversationRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.register(async (inbox) => {
      inbox.addHook('preHandler', requirePermission('inbox'));

      inbox.get('/conversations', async (request) => {
        const q = parse(
          z.object({
            status: z.enum(STATUSES).optional(),
            q: z.string().max(100).optional(),
            mine: z.enum(['true', 'false']).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          request.query,
        );
        const user = requireUser(request);
        const where: Prisma.ConversationWhereInput = {};
        if (q.status) where.status = q.status as ConversationStatus;
        if (q.mine === 'true') where.assignedUserId = user.id;
        if (q.q) {
          where.contact = {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { pushName: { contains: q.q, mode: 'insensitive' } },
              { phone: { contains: q.q } },
            ],
          };
        }
        const rows = await c.db.conversation.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: q.limit,
          include: {
            contact: true,
            assignedUser: { select: { id: true, name: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        });
        return {
          conversations: rows.map(({ messages, ...r }) => ({ ...r, lastMessage: messages[0] ?? null })),
        };
      });

      inbox.get('/conversations/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const q = parse(
          z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
          request.query,
        );
        const conversation = await c.db.conversation.findUnique({
          where: { id },
          include: { contact: true, assignedUser: { select: { id: true, name: true } } },
        });
        if (!conversation) throw new HttpError(404, 'Conversación inexistente');
        const messages = await c.db.message.findMany({
          where: { conversationId: id, ...(q.before ? { createdAt: { lt: q.before } } : {}) },
          orderBy: { createdAt: 'desc' },
          take: q.limit,
          include: { sentByUser: { select: { id: true, name: true } } },
        });
        const assignments = await c.db.humanAssignment.findMany({
          where: { conversationId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { user: { select: { id: true, name: true } } },
        });
        return { conversation, messages: messages.reverse(), assignments };
      });

      inbox.post('/conversations/:id/read', async (request) => {
        const { id } = parse(idParams, request.params);
        await c.db.conversation.update({ where: { id }, data: { unreadCount: 0 } });
        c.bus.publish({ type: 'conversation.updated', conversationId: id });
        return { ok: true };
      });

      inbox.post('/conversations/:id/take', async (request) => {
        const { id } = parse(idParams, request.params);
        return { conversation: await c.handoff.take(id, requireUser(request).id) };
      });
      inbox.post('/conversations/:id/release', async (request) => {
        const { id } = parse(idParams, request.params);
        const conversation = await c.handoff.release(id, requireUser(request).id);
        await c.worker.schedule(id);
        return { conversation };
      });
      inbox.post('/conversations/:id/pause', async (request) => {
        const { id } = parse(idParams, request.params);
        return { conversation: await c.handoff.pause(id, requireUser(request).id) };
      });
      inbox.post('/conversations/:id/resolve', async (request) => {
        const { id } = parse(idParams, request.params);
        return { conversation: await c.handoff.resolve(id, { type: 'USER', userId: requireUser(request).id }) };
      });
      inbox.post('/conversations/:id/assign', async (request) => {
        const { id } = parse(idParams, request.params);
        const body = parse(z.object({ userId: z.string().uuid().nullable() }), request.body);
        await c.handoff.assign(id, body.userId, { type: 'USER', userId: requireUser(request).id });
        return { ok: true };
      });

      /** Respuesta de una persona desde el panel: la conversación queda en atención humana. */
      inbox.post('/conversations/:id/messages', async (request) => {
        const { id } = parse(idParams, request.params);
        const body = parse(z.object({ text: z.string().trim().min(1).max(4000) }), request.body);
        const user = requireUser(request);
        const conversation = await c.db.conversation.findUnique({ where: { id } });
        if (!conversation) throw new HttpError(404, 'Conversación inexistente');
        if (conversation.status !== 'HUMAN_ACTIVE' && conversation.status !== 'AI_PAUSED') {
          await c.handoff.take(id, user.id, 'Respuesta desde el panel');
        }
        const message = await c.sender.sendText({ conversationId: id, text: body.text, author: 'HUMAN', userId: user.id });
        if (message.status === 'FAILED') throw new HttpError(502, `No se pudo enviar: ${message.error ?? 'error'}`);
        await c.db.conversation.update({ where: { id }, data: { unreadCount: 0 } });
        return { message };
      });
    });

    app.register(async (contacts) => {
      contacts.addHook('preHandler', requirePermission('contacts'));

      contacts.get('/contacts', async (request) => {
        const q = parse(
          z.object({
            q: z.string().max(100).optional(),
            buyerType: z.enum(['UNKNOWN', 'RETAIL', 'WHOLESALE', 'EVENT']).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
            offset: z.coerce.number().int().min(0).default(0),
          }),
          request.query,
        );
        const where: Prisma.ContactWhereInput = {};
        if (q.buyerType) where.buyerType = q.buyerType;
        if (q.q) {
          where.OR = [
            { name: { contains: q.q, mode: 'insensitive' } },
            { pushName: { contains: q.q, mode: 'insensitive' } },
            { phone: { contains: normalize(q.q).replace(/\s/g, '') } },
          ];
        }
        const [contacts_, total] = await Promise.all([
          c.db.contact.findMany({
            where,
            orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
            take: q.limit,
            skip: q.offset,
            include: { conversation: { select: { id: true, status: true } } },
          }),
          c.db.contact.count({ where }),
        ]);
        return { contacts: contacts_, total };
      });

      contacts.get('/contacts/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const contact = await c.db.contact.findUnique({
          where: { id },
          include: {
            conversation: { select: { id: true, status: true } },
            orders: { orderBy: { createdAt: 'desc' }, take: 20 },
            eventLeads: { orderBy: { createdAt: 'desc' }, take: 20 },
            followups: { orderBy: { dueAt: 'desc' }, take: 20 },
          },
        });
        if (!contact) throw new HttpError(404, 'Contacto inexistente');
        const cart = await c.cart.view(id);
        return { contact, cart };
      });

      contacts.patch('/contacts/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const body = parse(
          z.object({
            name: z.string().max(120).nullable().optional(),
            buyerType: z.enum(['UNKNOWN', 'RETAIL', 'WHOLESALE', 'EVENT']).optional(),
            interests: z.array(z.string().max(60)).max(30).optional(),
            notes: z.string().max(2000).nullable().optional(),
            memorySummary: z.string().max(2000).nullable().optional(),
            marketingConsent: z.boolean().optional(),
            botMuted: z.boolean().optional(),
          }),
          request.body,
        );
        const user = requireUser(request);
        const contact = await c.db.contact.update({
          where: { id },
          data: {
            ...body,
            ...(body.memorySummary !== undefined ? { memoryUpdatedAt: new Date() } : {}),
            ...(body.marketingConsent !== undefined ? { consentAt: body.marketingConsent ? new Date() : null } : {}),
          },
        });
        if (body.buyerType && body.buyerType !== 'EVENT' && body.buyerType !== 'UNKNOWN') {
          await c.cart.setWholesale(id, body.buyerType === 'WHOLESALE');
        }
        await c.audit.log({ actorType: 'USER', actorId: user.id, action: 'contact.updated', entityType: 'contact', entityId: id, data: body });
        return { contact };
      });
    });
  };
}

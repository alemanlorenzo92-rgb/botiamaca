import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError, requirePermission, requireUser } from '../auth.js';
import { parse } from '../validate.js';

const idParams = z.object({ id: z.string().uuid() });
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const contactSelect = { select: { id: true, name: true, pushName: true, phone: true, buyerType: true } } as const;

export function registerSalesRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.register(async (orders) => {
      orders.addHook('preHandler', requirePermission('orders'));

      orders.get('/orders', async (request) => {
        const q = parse(
          z.object({ status: z.enum(['PENDING_REVIEW', 'CONFIRMED', 'CANCELLED', 'FULFILLED']).optional(), ...page }),
          request.query,
        );
        const where = q.status ? { status: q.status } : {};
        const [rows, total] = await Promise.all([
          c.db.order.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: q.limit,
            skip: q.offset,
            include: { contact: contactSelect, items: true },
          }),
          c.db.order.count({ where }),
        ]);
        return { orders: rows, total };
      });

      orders.get('/orders/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const order = await c.db.order.findUnique({
          where: { id },
          include: { contact: { include: { conversation: { select: { id: true } } } }, items: true, followups: true },
        });
        if (!order) throw new HttpError(404, 'Pedido inexistente');
        return { order };
      });

      orders.patch('/orders/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const body = parse(
          z.object({
            status: z.enum(['PENDING_REVIEW', 'CONFIRMED', 'CANCELLED', 'FULFILLED']).optional(),
            notes: z.string().max(2000).nullable().optional(),
          }),
          request.body,
        );
        const order = await c.db.order.update({ where: { id }, data: body });
        await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: 'order.updated', entityType: 'order', entityId: id, data: body });
        return { order };
      });
    });

    app.register(async (leads) => {
      leads.addHook('preHandler', requirePermission('leads'));

      leads.get('/leads', async (request) => {
        const q = parse(
          z.object({
            service: z.enum(['GLITTER_BAR', 'SHIMMER_WALL']).optional(),
            status: z.enum(['NEW', 'QUOTING', 'QUOTED', 'WON', 'LOST']).optional(),
            ...page,
          }),
          request.query,
        );
        const where = { ...(q.service ? { service: q.service } : {}), ...(q.status ? { status: q.status } : {}) };
        const [rows, total] = await Promise.all([
          c.db.eventLead.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: q.limit,
            skip: q.offset,
            include: { contact: contactSelect },
          }),
          c.db.eventLead.count({ where }),
        ]);
        return { leads: rows.map((l) => ({ ...l, missingFields: c.leads.missingFields(l) })), total };
      });

      leads.patch('/leads/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const body = parse(
          z.object({
            status: z.enum(['NEW', 'QUOTING', 'QUOTED', 'WON', 'LOST']).optional(),
            quoteAmount: z.number().nonnegative().nullable().optional(),
            quoteNotes: z.string().max(2000).nullable().optional(),
          }),
          request.body,
        );
        const lead = await c.db.eventLead.update({ where: { id }, data: body });
        await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: 'lead.updated', entityType: 'event_lead', entityId: id, data: body });
        return { lead };
      });
    });

    app.register(async (followups) => {
      followups.addHook('preHandler', requirePermission('followups'));

      followups.get('/followups', async (request) => {
        const q = parse(z.object({ status: z.enum(['PENDING', 'DONE', 'CANCELLED']).default('PENDING'), ...page }), request.query);
        const [rows, total] = await Promise.all([
          c.db.followup.findMany({
            where: { status: q.status },
            orderBy: { dueAt: 'asc' },
            take: q.limit,
            skip: q.offset,
            include: { contact: contactSelect, assignedUser: { select: { id: true, name: true } } },
          }),
          c.db.followup.count({ where: { status: q.status } }),
        ]);
        return { followups: rows, total };
      });

      followups.post('/followups', async (request) => {
        const body = parse(
          z.object({
            contactId: z.string().uuid(),
            dueAt: z.coerce.date(),
            reason: z.string().trim().min(1).max(500),
            assignedUserId: z.string().uuid().nullable().optional(),
          }),
          request.body,
        );
        const contact = await c.db.contact.findUnique({ where: { id: body.contactId }, include: { conversation: true } });
        if (!contact) throw new HttpError(404, 'Contacto inexistente');
        const user = requireUser(request);
        const followup = await c.followups.create({
          contactId: contact.id,
          conversationId: contact.conversation?.id ?? null,
          dueAt: body.dueAt,
          reason: body.reason,
          createdBy: 'USER',
          assignedUserId: body.assignedUserId ?? user.id,
        });
        return { followup };
      });

      followups.patch('/followups/:id', async (request) => {
        const { id } = parse(idParams, request.params);
        const body = parse(
          z.object({
            status: z.enum(['PENDING', 'DONE', 'CANCELLED']).optional(),
            dueAt: z.coerce.date().optional(),
            assignedUserId: z.string().uuid().nullable().optional(),
          }),
          request.body,
        );
        const followup = await c.db.followup.update({
          where: { id },
          data: {
            ...body,
            ...(body.status ? { completedAt: body.status === 'PENDING' ? null : new Date() } : {}),
            ...(body.dueAt ? { notifiedAt: null } : {}),
          },
        });
        return { followup };
      });
    });
  };
}

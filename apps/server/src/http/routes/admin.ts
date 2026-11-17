import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { isValidTimeZone, toMinutes } from '../../core/hours.js';
import { BUSINESS_SETTING_KEYS } from '../../core/settings.js';
import { HttpError, requirePermission, requireUser } from '../auth.js';
import { parse } from '../validate.js';

const jsonNested: z.ZodType<Prisma.InputJsonValue | null> = z.lazy(() =>
  z.union([z.null(), z.string(), z.number(), z.boolean(), z.array(jsonNested), z.record(z.string(), jsonNested)]),
);
const jsonValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(jsonNested),
  z.record(z.string(), jsonNested),
]) as z.ZodType<Prisma.InputJsonValue>;

const hhmm = z.string().refine((v) => toMinutes(v) !== null, 'Hora inválida (HH:MM)');

const businessHours = z
  .object({
    timezone: z.string().refine(isValidTimeZone, 'Zona horaria inválida').optional(),
    days: z.partialRecord(
      z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
      z.array(z.tuple([hhmm, hhmm])),
    ),
  })
  .nullable();

export function registerAdminRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.register(async (settings) => {
      settings.addHook('preHandler', requirePermission('settings'));

      settings.get('/settings/business', async () => {
        const values = await c.settings.getAllBusiness();
        return { keys: BUSINESS_SETTING_KEYS, values };
      });

      /** value=null borra la clave: el dato pasa a "no configurado" y la IA deriva a una persona. */
      settings.put('/settings/business/:key', async (request) => {
        const { key } = parse(z.object({ key: z.enum(BUSINESS_SETTING_KEYS) }), request.params);
        const body = parse(z.object({ value: jsonValue.nullable() }), request.body);
        const user = requireUser(request);
        if (body.value === null || body.value === '') {
          await c.db.businessSetting.deleteMany({ where: { key } });
        } else {
          await c.settings.setBusiness(key, body.value, user.id);
        }
        await c.audit.log({ actorType: 'USER', actorId: user.id, action: 'settings.business_updated', entityType: 'business_setting', entityId: key });
        return { ok: true };
      });

      settings.get('/settings/ai', async () => ({ ai: await c.settings.getAi() }));

      settings.put('/settings/ai', async (request) => {
        const body = parse(
          z.object({
            model: z.string().max(60).nullable().optional(),
            temperature: z.number().min(0).max(2).nullable().optional(),
            maxOutputTokens: z.number().int().min(100).max(4000).nullable().optional(),
            personality: z.string().min(1).max(4000).optional(),
            instructions: z.string().max(8000).optional(),
            greeting: z.string().max(1000).nullable().optional(),
            handoffMessage: z.string().min(1).max(1000).optional(),
            errorMessage: z.string().min(1).max(1000).optional(),
            businessHours: businessHours.optional(),
            outsideHoursMessage: z.string().max(1000).nullable().optional(),
            maxRepliesPerHour: z.number().int().min(1).max(500).optional(),
            dailyTokenBudget: z.number().int().positive().nullable().optional(),
            debounceSeconds: z.number().int().min(0).max(60).optional(),
            historyMessages: z.number().int().min(2).max(100).optional(),
          }),
          request.body,
        );
        const { businessHours: hours, ...rest } = body;
        const data: Prisma.AiSettingUpdateInput = { ...rest };
        if (hours !== undefined) data.businessHours = hours === null ? Prisma.DbNull : hours;
        const ai = await c.db.aiSetting.update({ where: { id: 1 }, data });
        await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: 'settings.ai_updated', data: body as Prisma.InputJsonValue });
        return { ai };
      });

      /** Interruptor general de la IA (también accesible desde la bandeja). */
      settings.post('/settings/ai/toggle', async (request) => {
        const body = parse(z.object({ enabled: z.boolean() }), request.body);
        const ai = await c.db.aiSetting.update({ where: { id: 1 }, data: { enabled: body.enabled } });
        await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: body.enabled ? 'ai.enabled' : 'ai.disabled' });
        return { ai };
      });
    });

    app.register(async (wa) => {
      wa.addHook('preHandler', requirePermission('whatsapp'));

      wa.get('/whatsapp/status', async () => {
        const state = await c.db.waState.findUnique({ where: { id: 1 } });
        const live = c.gateway?.getStatus() ?? { status: 'DISABLED', qr: null, me: null };
        return { ...live, lastConnected: state?.lastConnected ?? null, lastError: state?.lastError ?? null };
      });

      wa.post('/whatsapp/logout', async (request) => {
        if (!c.gateway) throw new HttpError(409, 'WhatsApp está deshabilitado');
        await c.gateway.logout();
        await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: 'whatsapp.logout' });
        return { ok: true };
      });
    });

    app.register(async (audit) => {
      audit.addHook('preHandler', requirePermission('audit'));
      audit.get('/audit', async (request) => {
        const q = parse(
          z.object({
            action: z.string().max(60).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(100),
            offset: z.coerce.number().int().min(0).default(0),
          }),
          request.query,
        );
        const where = q.action ? { action: { startsWith: q.action } } : {};
        const [rows, total] = await Promise.all([
          c.db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset }),
          c.db.auditLog.count({ where }),
        ]);
        return { entries: rows, total };
      });

      audit.get('/ai-runs', async (request) => {
        const q = parse(
          z.object({ conversationId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
          request.query,
        );
        const runs = await c.db.aiRun.findMany({
          where: q.conversationId ? { conversationId: q.conversationId } : {},
          orderBy: { createdAt: 'desc' },
          take: q.limit,
        });
        return { runs };
      });
    });

    app.register(async (users) => {
      users.get('/users', { preHandler: requirePermission('users') }, async () => {
        const rows = await c.db.user.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, email: true, name: true, active: true, lastLoginAt: true, role: { select: { code: true, name: true } } },
        });
        return { users: rows };
      });

      users.post('/users', { preHandler: requirePermission('users') }, async (request) => {
        const body = parse(
          z.object({
            // Email o un nombre de usuario simple (p. ej. "malestyle").
            email: z.union([z.string().email().max(200), z.string().regex(/^[a-z0-9._-]{3,40}$/i, 'Usuario: letras, números, punto, guion o guion bajo (3 a 40)')]),
            name: z.string().trim().min(1).max(120),
            password: z.string().min(10).max(200),
            roleCode: z.string().min(1),
          }),
          request.body,
        );
        const user = await c.auth.createUser(body);
        await c.audit.log({ actorType: 'USER', actorId: requireUser(request).id, action: 'user.created', entityType: 'user', entityId: user.id });
        return { user: { id: user.id, email: user.email, name: user.name } };
      });

      users.patch('/users/:id', { preHandler: requirePermission('users') }, async (request) => {
        const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
        const body = parse(
          z.object({
            active: z.boolean().optional(),
            roleCode: z.string().optional(),
            password: z.string().min(10).max(200).optional(),
          }),
          request.body,
        );
        const actor = requireUser(request);
        const data: Prisma.UserUpdateInput = {};
        if (body.active !== undefined) {
          if (id === actor.id && !body.active) throw new HttpError(400, 'No podés desactivar tu propio usuario');
          data.active = body.active;
        }
        if (body.roleCode) data.role = { connect: { code: body.roleCode } };
        if (body.password) data.passwordHash = await c.auth.hashPassword(body.password);
        await c.db.user.update({ where: { id }, data });
        if (body.active === false || body.password) await c.db.session.deleteMany({ where: { userId: id } });
        await c.audit.log({ actorType: 'USER', actorId: actor.id, action: 'user.updated', entityType: 'user', entityId: id, data: { ...body, password: body.password ? '[cambiada]' : undefined } });
        return { ok: true };
      });
    });
  };
}

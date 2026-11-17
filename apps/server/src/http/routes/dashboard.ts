import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { can, requireUser } from '../auth.js';

/** Resumen para la pantalla de inicio de la dueña. */
export function registerDashboardRoutes(c: Container) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard', async (request) => {
      const user = requireUser(request);
      const knowledgeOk = can(user, 'knowledge');
      const auditOk = can(user, 'audit');
      const since = new Date(Date.now() - 24 * 3600_000);
      const [conversations, orders, leads, followupsDue, knowledge, products, media, imports, aiRuns] = await Promise.all([
        c.db.conversation.groupBy({ by: ['status'], _count: true }),
        c.db.order.groupBy({ by: ['status'], _count: true }),
        c.db.eventLead.groupBy({ by: ['status'], _count: true }),
        c.db.followup.count({ where: { status: 'PENDING', dueAt: { lte: new Date() } } }),
        c.db.knowledgeDocument.groupBy({ by: ['status'], _count: true }),
        c.db.product.count({ where: { deletedAt: null } }),
        c.db.mediaAsset.groupBy({ by: ['active'], _count: true }),
        c.db.importedChat.groupBy({ by: ['status'], _count: true }),
        c.db.aiRun.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
      ]);
      const map = <K extends string>(rows: ({ _count: number } & Record<string, unknown>)[], key: K) =>
        Object.fromEntries(rows.map((r) => [String(r[key]), r._count]));
      return {
        conversations: map(conversations, 'status'),
        orders: map(orders, 'status'),
        leads: map(leads, 'status'),
        followupsDue,
        knowledge: knowledgeOk ? map(knowledge, 'status') : {},
        products,
        media: map(media, 'active'),
        imports: knowledgeOk ? map(imports, 'status') : {},
        aiRuns24h: auditOk ? map(aiRuns, 'status') : {},
        whatsapp: c.gateway?.getStatus().status ?? 'DISABLED',
        openai: Boolean(c.env.OPENAI_API_KEY),
      };
    });
  };
}

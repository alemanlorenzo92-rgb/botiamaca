import type { ActorType, PrismaClient } from '@prisma/client';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';

export class FollowupsService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  async create(params: {
    contactId: string;
    conversationId?: string | null;
    eventLeadId?: string | null;
    orderId?: string | null;
    dueAt: Date;
    reason: string;
    createdBy: ActorType;
    assignedUserId?: string | null;
  }) {
    return this.db.followup.create({
      data: {
        contactId: params.contactId,
        conversationId: params.conversationId ?? null,
        eventLeadId: params.eventLeadId ?? null,
        orderId: params.orderId ?? null,
        dueAt: params.dueAt,
        reason: params.reason,
        createdBy: params.createdBy,
        assignedUserId: params.assignedUserId ?? null,
      },
    });
  }

  /** Los seguimientos vencidos se avisan al equipo en el panel; no se escribe solo al cliente. */
  async notifyDue(): Promise<number> {
    const due = await this.db.followup.findMany({
      where: { status: 'PENDING', dueAt: { lte: new Date() }, notifiedAt: null },
      take: 100,
    });
    for (const f of due) {
      await this.db.followup.update({ where: { id: f.id }, data: { notifiedAt: new Date() } });
      this.bus.publish({ type: 'followup.due', followupId: f.id });
    }
    return due.length;
  }

  startScheduler(intervalMs = 60_000) {
    this.timer = setInterval(() => {
      void this.notifyDue().catch((error: unknown) => this.logger.error({ err: error }, 'error en seguimientos'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

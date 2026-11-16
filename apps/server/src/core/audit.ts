import type { ActorType, Prisma, PrismaClient } from '@prisma/client';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
  ip?: string | null;
}

export class AuditService {
  constructor(private readonly db: PrismaClient) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.db.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        data: entry.data ?? {},
        ip: entry.ip ?? null,
      },
    });
  }
}

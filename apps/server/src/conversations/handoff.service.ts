import { isWithinBusinessHours } from '../core/hours.js';
import type { ActorType, AssignmentAction, ConversationStatus, PrismaClient } from '@prisma/client';
import type { AuditService } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import type { SettingsService } from '../core/settings.js';
import type { MessageSender } from './sender.js';

export interface Actor {
  type: ActorType;
  userId?: string | null;
}

/** Transiciones permitidas del estado de atención. */
const TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  AI_ACTIVE: ['HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'AI_PAUSED', 'RESOLVED'],
  HUMAN_REQUESTED: ['HUMAN_ACTIVE', 'AI_ACTIVE', 'AI_PAUSED', 'RESOLVED'],
  HUMAN_ACTIVE: ['AI_ACTIVE', 'AI_PAUSED', 'RESOLVED', 'HUMAN_REQUESTED'],
  AI_PAUSED: ['AI_ACTIVE', 'HUMAN_ACTIVE', 'RESOLVED', 'HUMAN_REQUESTED'],
  RESOLVED: ['AI_ACTIVE', 'HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'AI_PAUSED'],
};

export class InvalidTransitionError extends Error {
  constructor(from: ConversationStatus, to: ConversationStatus) {
    super(`No se puede pasar de ${from} a ${to}`);
  }
}

export class HandoffService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly sender: MessageSender,
  ) {}

  private async transition(
    conversationId: string,
    to: ConversationStatus,
    action: AssignmentAction,
    actor: Actor,
    reason: string | null,
    extra: { assignedUserId?: string | null; humanRequestedAt?: Date | null } = {},
  ) {
    const updated = await this.db.$transaction(async (tx) => {
      // Misma fila que bloquea MessageSender: la toma espera a que termine un envío de la IA ya decidido.
      await tx.$queryRaw`SELECT 1 FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
      const current = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      if (current.status !== to && !TRANSITIONS[current.status].includes(to)) {
        throw new InvalidTransitionError(current.status, to);
      }
      const conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status: to,
          ...(extra.assignedUserId !== undefined ? { assignedUserId: extra.assignedUserId } : {}),
          ...(extra.humanRequestedAt !== undefined
            ? { humanRequestedAt: extra.humanRequestedAt, humanRequestReason: reason }
            : {}),
        },
      });
      await tx.humanAssignment.create({
        data: {
          conversationId,
          action,
          actorType: actor.type,
          userId: actor.userId ?? null,
          reason,
        },
      });
      return { previous: current.status, conversation };
    });
    await this.audit.log({
      actorType: actor.type,
      actorId: actor.userId ?? null,
      action: `conversation.${action.toLowerCase()}`,
      entityType: 'conversation',
      entityId: conversationId,
      data: { from: updated.previous, to, reason },
    });
    this.bus.publish({ type: 'conversation.updated', conversationId });
    return updated;
  }

  /** El cliente (o la IA, o el sistema) pide una persona: se frenan las respuestas automáticas. */
  /** `message` reemplaza el aviso de derivación por defecto (por ejemplo, el de error de la IA). */
  async requestHuman(conversationId: string, actor: Actor, reason: string | null, message?: string) {
    const current = await this.db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (current.status === 'HUMAN_REQUESTED' || current.status === 'HUMAN_ACTIVE') {
      return current;
    }
    const { conversation } = await this.transition(
      conversationId,
      'HUMAN_REQUESTED',
      'REQUESTED',
      actor,
      reason,
      { humanRequestedAt: new Date() },
    );
    this.bus.publish({ type: 'human.requested', conversationId, reason });
    const ai = await this.settings.getAi();
    const outside = isWithinBusinessHours(ai.businessHours, new Date()) === false && ai.outsideHoursMessage?.trim();
    await this.sender.sendText({ conversationId, text: message ?? (outside ? ai.outsideHoursMessage! : ai.handoffMessage), author: 'SYSTEM' });
    return conversation;
  }

  async take(conversationId: string, userId: string, reason: string | null = null) {
    return (
      await this.transition(conversationId, 'HUMAN_ACTIVE', 'TAKEN', { type: 'USER', userId }, reason, {
        assignedUserId: userId,
      })
    ).conversation;
  }

  /** Cuando alguien responde desde el teléfono vinculado, la conversación pasa a atención humana. */
  async takeFromPhone(conversationId: string) {
    const current = await this.db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (current.status === 'HUMAN_ACTIVE' || current.status === 'AI_PAUSED') return current;
    return (
      await this.transition(
        conversationId,
        'HUMAN_ACTIVE',
        'TAKEN',
        { type: 'SYSTEM' },
        'Respuesta enviada desde el teléfono',
      )
    ).conversation;
  }

  async assign(conversationId: string, assignedUserId: string | null, actor: Actor) {
    await this.db.conversation.update({ where: { id: conversationId }, data: { assignedUserId } });
    await this.db.humanAssignment.create({
      data: {
        conversationId,
        action: 'ASSIGNED',
        actorType: actor.type,
        userId: actor.userId ?? null,
        reason: assignedUserId ? `Asignada a ${assignedUserId}` : 'Sin asignar',
      },
    });
    await this.audit.log({
      actorType: actor.type,
      actorId: actor.userId ?? null,
      action: 'conversation.assigned',
      entityType: 'conversation',
      entityId: conversationId,
      data: { assignedUserId },
    });
    this.bus.publish({ type: 'conversation.updated', conversationId });
  }

  /** Reactiva la IA. La IA retoma con el historial completo, incluido lo que escribió la persona. */
  async release(conversationId: string, userId: string) {
    return (
      await this.transition(conversationId, 'AI_ACTIVE', 'RELEASED', { type: 'USER', userId }, null, {
        humanRequestedAt: null,
      })
    ).conversation;
  }

  async pause(conversationId: string, userId: string) {
    return (await this.transition(conversationId, 'AI_PAUSED', 'PAUSED', { type: 'USER', userId }, null))
      .conversation;
  }

  async resolve(conversationId: string, actor: Actor) {
    return (
      await this.transition(conversationId, 'RESOLVED', 'RESOLVED', actor, null, {
        humanRequestedAt: null,
      })
    ).conversation;
  }

  /** Un cliente vuelve a escribir en una conversación cerrada: vuelve a la IA. */
  async reopen(conversationId: string) {
    return (
      await this.transition(conversationId, 'AI_ACTIVE', 'RELEASED', { type: 'CUSTOMER' }, 'Nuevo mensaje del cliente')
    ).conversation;
  }
}

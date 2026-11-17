import type { PrismaClient } from '@prisma/client';
import type { SettingsService } from '../core/settings.js';

export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

/** Control de respuestas automáticas en backend: la IA no decide si puede hablar. */
export class ReplyGuard {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  async check(conversationId: string): Promise<GuardDecision> {
    const ai = await this.settings.getAi();
    if (!ai.enabled) return { allowed: false, reason: 'IA apagada (interruptor general)' };

    const conversation = await this.db.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { contact: { select: { botMuted: true } } } });
    if (conversation.status !== 'AI_ACTIVE') {
      return { allowed: false, reason: `Conversación en estado ${conversation.status}` };
    }
    if (conversation.contact.botMuted) return { allowed: false, reason: 'Contacto marcado para que el bot no le responda' };

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentReplies = await this.db.message.count({
      where: { conversationId, author: 'AI', status: 'SENT', createdAt: { gte: hourAgo } },
    });
    if (recentReplies >= ai.maxRepliesPerHour) {
      return { allowed: false, reason: 'Límite de respuestas por hora alcanzado' };
    }

    if (ai.dailyTokenBudget) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const usage = await this.db.aiRun.aggregate({
        where: { createdAt: { gte: dayStart } },
        _sum: { inputTokens: true, outputTokens: true },
      });
      const used = (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0);
      if (used >= ai.dailyTokenBudget) return { allowed: false, reason: 'Presupuesto diario de tokens agotado' };
    }

    return { allowed: true };
  }
}

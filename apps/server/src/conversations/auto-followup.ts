import type { PrismaClient } from '@prisma/client';
import { isWithinBusinessHours } from '../core/hours.js';
import type { Logger } from '../core/logger.js';
import type { SettingsService } from '../core/settings.js';
import type { MessageSender } from './sender.js';

/** No se reabren chats que llevan más de una semana quietos. */
const MAX_SILENCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Seguimiento automático, como lo hace la dueña: si la clienta no contesta la última respuesta de la IA,
 * después de `followupAfterHours` se le escribe UNA vez (sin precios). Si sigue sin contestar, no se insiste.
 */
export class AutoFollowupService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
    private readonly sender: MessageSender,
    private readonly logger: Logger,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    if (!this.sender.isReady()) return 0;
    const ai = await this.settings.getAi();
    if (!ai.enabled || !ai.followupAfterHours || !ai.followupMessage.trim()) return 0;
    if (isWithinBusinessHours(ai.businessHours, now) === false) return 0;
    const cutoff = new Date(now.getTime() - ai.followupAfterHours * 60 * 60 * 1000);
    const candidates = await this.db.conversation.findMany({
      where: {
        status: 'AI_ACTIVE',
        contact: { botMuted: false },
        lastInboundAt: { not: null },
        lastOutboundAt: { lte: cutoff, gte: new Date(now.getTime() - MAX_SILENCE_MS) },
      },
      select: { id: true, lastInboundAt: true, autoFollowupAt: true },
      take: 50,
    });
    let sent = 0;
    for (const conv of candidates) {
      const lastInbound = conv.lastInboundAt!;
      if (conv.autoFollowupAt && conv.autoFollowupAt >= lastInbound) continue;
      const last = await this.db.message.findFirst({
        where: { conversationId: conv.id, status: { in: ['RECEIVED', 'SENT'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!last || last.direction !== 'OUTBOUND' || last.author !== 'AI' || last.createdAt > cutoff) continue;
      // Se marca antes de enviar: dos corridas a la vez no mandan dos seguimientos.
      const claimed = await this.db.conversation.updateMany({
        where: { id: conv.id, OR: [{ autoFollowupAt: null }, { autoFollowupAt: { lt: lastInbound } }] },
        data: { autoFollowupAt: now },
      });
      if (!claimed.count) continue;
      const msg = await this.sender.sendText({ conversationId: conv.id, text: ai.followupMessage.trim(), author: 'AI' });
      if (msg.status === 'SENT') sent++;
    }
    if (sent) this.logger.info({ sent }, 'seguimientos automáticos enviados');
    return sent;
  }

  startScheduler(intervalMs = 10 * 60_000) {
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.logger.error({ err: error }, 'error en seguimientos automáticos'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

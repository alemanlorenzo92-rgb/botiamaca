import type { PrismaClient } from '@prisma/client';
import { DEFAULT_TIME_ZONE } from '../core/hours.js';
import type { Logger } from '../core/logger.js';
import type { SettingsService } from '../core/settings.js';
import type { MessageSender } from './sender.js';

/** Margen después del plazo para esperar el próximo día hábil a las 10 (fin de semana y feriado largo). */
const WINDOW_SLACK_MS = 4 * 24 * 60 * 60 * 1000;

/** Como la dueña: los seguimientos salen a las 10 de la mañana de un día hábil (lunes a viernes, hora de Argentina). */
export function isFollowupWindow(now: Date, timeZone = DEFAULT_TIME_ZONE): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return weekday !== 'Sat' && weekday !== 'Sun' && hour === 10;
}

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
    if (!isFollowupWindow(now)) return 0;
    const cutoff = new Date(now.getTime() - ai.followupAfterHours * 60 * 60 * 1000);
    // Ya en SQL se descartan los chats con seguimiento enviado desde el último mensaje de la clienta.
    const candidates = await this.db.$queryRaw<{ id: string; lastInboundAt: Date; autoFollowupAt: Date | null }[]>`
      SELECT c.id, c.last_inbound_at AS "lastInboundAt", c.auto_followup_at AS "autoFollowupAt"
      FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.status = 'AI_ACTIVE' AND NOT ct.bot_muted AND c.last_inbound_at IS NOT NULL
        AND c.last_outbound_at <= ${cutoff} AND c.last_outbound_at >= ${new Date(cutoff.getTime() - WINDOW_SLACK_MS)}
        AND (c.auto_followup_at IS NULL OR c.auto_followup_at < c.last_inbound_at)
      ORDER BY c.last_outbound_at
      LIMIT 50`;
    let sent = 0;
    for (const conv of candidates) {
      const lastInbound = conv.lastInboundAt;
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

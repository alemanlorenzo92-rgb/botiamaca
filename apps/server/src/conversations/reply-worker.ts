import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../core/logger.js';
import type { SettingsService } from '../core/settings.js';
import type { HandoffService } from './handoff.service.js';
import type { ReplyGuard } from './reply-guard.js';
import type { MessageSender } from './sender.js';

export interface AiResponder {
  /** Genera la respuesta usando el historial guardado. `null` = no responder. */
  respond(conversationId: string): Promise<{ text: string | null }>;
}

/**
 * Procesa los mensajes entrantes pendientes (ai_handled_at nulo).
 * - Agrupa ráfagas de mensajes (debounce) y procesa una conversación a la vez.
 * - Vuelve a validar el estado justo antes de enviar: si una persona tomó la
 *   conversación mientras la IA pensaba, la respuesta se descarta.
 * - Al arrancar recupera lo que quedó pendiente (reinicios/caídas).
 */
export class ReplyWorker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly guard: ReplyGuard,
    private readonly responder: AiResponder,
    private readonly sender: MessageSender,
    private readonly handoff: HandoffService,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  async schedule(conversationId: string): Promise<void> {
    if (this.stopped) return;
    const ai = await this.settings.getAi();
    const existing = this.timers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      void this.enqueue(conversationId);
    }, ai.debounceSeconds * 1000);
    this.timers.set(conversationId, timer);
  }

  enqueue(conversationId: string): Promise<void> {
    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    const next = previous
      .then(() => this.process(conversationId))
      .catch((error: unknown) => this.logger.error({ err: error, conversationId }, 'reply worker error'))
      .finally(() => {
        if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
      });
    this.chains.set(conversationId, next);
    return next;
  }

  private async pendingIds(conversationId: string): Promise<string[]> {
    const rows = await this.db.message.findMany({
      where: { conversationId, direction: 'INBOUND', aiHandledAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async markHandled(ids: string[]) {
    if (ids.length) {
      await this.db.message.updateMany({ where: { id: { in: ids } }, data: { aiHandledAt: new Date() } });
    }
  }

  async process(conversationId: string): Promise<void> {
    const pending = await this.pendingIds(conversationId);
    if (!pending.length) return;

    const before = await this.guard.check(conversationId);
    if (!before.allowed) {
      await this.markHandled(pending);
      this.logger.info({ conversationId, reason: before.reason }, 'respuesta automática omitida');
      return;
    }

    let text: string | null;
    try {
      text = (await this.responder.respond(conversationId)).text;
    } catch (error) {
      this.logger.error({ err: error, conversationId }, 'falló la IA; se deriva a una persona');
      await this.markHandled(pending);
      const ai = await this.settings.getAi();
      const after = await this.guard.check(conversationId);
      if (after.allowed) {
        await this.handoff.requestHuman(conversationId, { type: 'SYSTEM' }, 'La IA no pudo responder', ai.errorMessage);
      }
      return;
    }

    await this.markHandled(pending);
    if (!text?.trim()) return;

    const after = await this.guard.check(conversationId);
    if (!after.allowed) {
      await this.sender.recordDiscarded(conversationId, text, after.reason);
      return;
    }

    await this.sender.sendText({ conversationId, text: text.trim(), author: 'AI' });

    if ((await this.pendingIds(conversationId)).length) await this.schedule(conversationId);
  }

  async recoverPending(maxAgeHours = 24): Promise<number> {
    const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const rows = await this.db.message.findMany({
      where: { direction: 'INBOUND', aiHandledAt: null, createdAt: { gte: since } },
      select: { conversationId: true },
      distinct: ['conversationId'],
    });
    for (const row of rows) await this.schedule(row.conversationId);
    return rows.length;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

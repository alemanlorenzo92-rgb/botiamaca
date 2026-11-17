import type { MessageAuthor, PrismaClient } from '@prisma/client';
import type { EventBus } from '../core/events.js';
import type { WhatsAppTransport } from '../whatsapp/transport.js';

export class MessageSender {
  constructor(
    private readonly db: PrismaClient,
    private readonly transport: WhatsAppTransport,
    private readonly bus: EventBus,
  ) {}

  /** Envía un texto y lo registra. Devuelve el mensaje guardado (SENT o FAILED). */
  async sendText(params: {
    conversationId: string;
    text: string;
    author: Exclude<MessageAuthor, 'CUSTOMER'>;
    userId?: string | null;
  }) {
    const conversation = await this.db.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      include: { contact: true },
    });
    const message = await this.db.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        author: params.author,
        type: 'TEXT',
        text: params.text,
        status: 'PENDING',
        sentByUserId: params.userId ?? null,
      },
    });
    try {
      const { externalId } = await this.transport.sendText(conversation.contact.waJid, params.text);
      const saved = await this.db.message.update({
        where: { id: message.id },
        data: { status: 'SENT', externalId },
      });
      await this.db.conversation.update({
        where: { id: conversation.id },
        data: { lastOutboundAt: new Date() },
      });
      this.bus.publish({ type: 'message.created', conversationId: conversation.id, messageId: saved.id });
      return saved;
    } catch (error) {
      const saved = await this.db.message.update({
        where: { id: message.id },
        data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) },
      });
      this.bus.publish({ type: 'message.created', conversationId: conversation.id, messageId: saved.id });
      return saved;
    }
  }

  isReady(): boolean {
    return this.transport.isConnected();
  }

  /** Registra una respuesta automática que el backend bloqueó (no se envía). */
  async recordDiscarded(conversationId: string, text: string, reason: string) {
    return this.db.message.create({
      data: {
        conversationId,
        direction: 'OUTBOUND',
        author: 'AI',
        type: 'TEXT',
        text,
        status: 'DISCARDED',
        error: reason,
      },
    });
  }
}

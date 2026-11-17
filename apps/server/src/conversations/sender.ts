import type { Message, MessageAuthor, Prisma, PrismaClient } from '@prisma/client';
import type { EventBus } from '../core/events.js';
import type { MediaService } from '../media/media.service.js';
import { WhatsAppNotConnectedError, type WhatsAppTransport } from '../whatsapp/transport.js';

export class MessageSender {
  constructor(
    private readonly db: PrismaClient,
    private readonly transport: WhatsAppTransport,
    private readonly bus: EventBus,
    private readonly media: MediaService,
  ) {}

  /**
   * Crea el mensaje saliente. Si es de la IA, bloquea la fila de la conversación y verifica que siga en AI_ACTIVE:
   * la toma de la dueña actualiza esa misma fila, así que una vez tomada ningún mensaje nuevo de la IA puede salir.
   */
  private async createOutbound(data: Prisma.MessageUncheckedCreateInput): Promise<Message> {
    return this.db.$transaction(async (tx) => {
      if (data.author === 'AI') {
        const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM conversations WHERE id = ${data.conversationId}::uuid FOR UPDATE`;
        if (row?.status !== 'AI_ACTIVE') {
          return tx.message.create({ data: { ...data, status: 'DISCARDED', error: `Conversación en estado ${row?.status ?? 'inexistente'}` } });
        }
      }
      return tx.message.create({ data });
    });
  }

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
    const message = await this.createOutbound({
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      author: params.author,
      type: 'TEXT',
      text: params.text,
      status: 'PENDING',
      sentByUserId: params.userId ?? null,
    });
    if (message.status === 'DISCARDED') return message;
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

  /**
   * Envía una foto o video de la biblioteca y lo registra.
   * Reintenta una vez ante fallas transitorias; si el archivo falta o WhatsApp está caído, queda FAILED.
   */
  async sendMedia(params: {
    conversationId: string;
    mediaId: string;
    caption?: string | null;
    author: Exclude<MessageAuthor, 'CUSTOMER'>;
    userId?: string | null;
    requireActive?: boolean;
  }) {
    const conversation = await this.db.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      include: { contact: true },
    });
    let loaded: Awaited<ReturnType<MediaService['load']>> | null = null;
    let loadError: string | null = null;
    try {
      loaded = await this.media.load(params.mediaId, { requireActive: params.requireActive });
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    const message = await this.createOutbound({
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      author: params.author,
      type: loaded?.asset.kind ?? 'IMAGE',
      text: params.caption ?? null,
      mediaMime: loaded?.asset.mime ?? null,
      mediaId: loaded ? params.mediaId : null,
      status: 'PENDING',
      sentByUserId: params.userId ?? null,
    });
    if (message.status === 'DISCARDED') return message;
    const fail = async (error: string) => {
      const saved = await this.db.message.update({ where: { id: message.id }, data: { status: 'FAILED', error } });
      this.bus.publish({ type: 'message.created', conversationId: conversation.id, messageId: saved.id });
      return saved;
    };
    if (!loaded) return fail(loadError ?? 'Archivo no disponible');
    const payload = { kind: loaded.asset.kind, data: loaded.data, mimetype: loaded.asset.mime, caption: params.caption ?? null };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { externalId } = await this.transport.sendMedia(conversation.contact.waJid, payload);
        const saved = await this.db.message.update({ where: { id: message.id }, data: { status: 'SENT', externalId } });
        await this.db.conversation.update({ where: { id: conversation.id }, data: { lastOutboundAt: new Date() } });
        this.bus.publish({ type: 'message.created', conversationId: conversation.id, messageId: saved.id });
        return saved;
      } catch (error) {
        lastError = error;
        if (error instanceof WhatsAppNotConnectedError || !this.transport.isConnected()) break;
      }
    }
    return fail(lastError instanceof Error ? lastError.message : String(lastError));
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

import { Prisma, type PrismaClient } from '@prisma/client';
import type { EventBus } from '../core/events.js';
import { normalize } from '../core/text.js';
import { channelOf } from '../meta/channel.js';
import type { InboundWhatsAppMessage } from '../whatsapp/transport.js';
import type { HandoffService } from './handoff.service.js';

const HUMAN_REQUEST_PATTERNS = [
  /\b(hablar|comunicarme|contactarme|atender(me)?)\b.*\b(persona|humano|humana|alguien|asesor|asesora|vendedor|vendedora|encargad[oa]|dueñ[oa])\b/,
  /\b(persona real|un humano|una humana|atencion humana|asesor humano|no quiero hablar con (un|una) (bot|robot|maquina))\b/,
  /\b(pasame|pasa me|comunicame) con\b/,
];

export function isExplicitHumanRequest(text: string | null): boolean {
  if (!text) return false;
  const n = normalize(text);
  return HUMAN_REQUEST_PATTERNS.some((p) => p.test(n));
}

export function phoneFromJid(jid: string | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

export type IngestResult =
  | { kind: 'duplicate' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'customer'; conversationId: string; messageId: string; needsReply: boolean }
  | { kind: 'phone_reply'; conversationId: string; messageId: string };

export class ConversationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: EventBus,
    private readonly handoff: HandoffService,
  ) {}

  private async findOrCreateContact(msg: InboundWhatsAppMessage) {
    const candidates = [msg.chatJid, msg.altJid].filter((j): j is string => !!j);
    const existing = await this.db.contact.findFirst({
      where: { OR: [{ waJid: { in: candidates } }, { waAltJid: { in: candidates } }] },
    });
    const phone = phoneFromJid(msg.chatJid) ?? phoneFromJid(msg.altJid);
    if (existing) {
      const data: Prisma.ContactUpdateInput = {};
      if (!msg.fromMe && msg.pushName && msg.pushName !== existing.pushName) data.pushName = msg.pushName;
      if (!existing.phone && phone) data.phone = phone;
      if (!existing.waAltJid && msg.altJid && msg.altJid !== existing.waJid) data.waAltJid = msg.altJid;
      return Object.keys(data).length
        ? this.db.contact.update({ where: { id: existing.id }, data })
        : existing;
    }
    try {
      return await this.db.contact.create({
        data: {
          waJid: msg.chatJid,
          channel: channelOf(msg.chatJid),
          waAltJid: msg.altJid,
          phone,
          pushName: msg.fromMe ? null : msg.pushName,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.db.contact.findUniqueOrThrow({ where: { waJid: msg.chatJid } });
      }
      throw error;
    }
  }

  async ingest(msg: InboundWhatsAppMessage): Promise<IngestResult> {
    const channel = channelOf(msg.chatJid);
    if (channel === 'WHATSAPP' && !msg.chatJid.endsWith('@s.whatsapp.net') && !msg.chatJid.endsWith('@lid')) {
      return { kind: 'ignored', reason: 'chat no individual' };
    }
    const already = await this.db.message.findUnique({ where: { externalId: msg.externalId } });
    if (already) return { kind: 'duplicate' };

    const contact = await this.findOrCreateContact(msg);
    const conversation = await this.db.conversation.upsert({
      where: { contactId: contact.id },
      create: { contactId: contact.id },
      update: {},
    });

    let message;
    try {
      message = await this.db.message.create({
        data: {
          conversationId: conversation.id,
          direction: msg.fromMe ? 'OUTBOUND' : 'INBOUND',
          author: msg.fromMe ? 'HUMAN' : 'CUSTOMER',
          externalId: msg.externalId,
          type: msg.type,
          text: msg.text,
          mediaMime: msg.mediaMime,
          status: msg.fromMe ? 'SENT' : 'RECEIVED',
          createdAt: msg.timestamp,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { kind: 'duplicate' };
      }
      throw error;
    }
    this.bus.publish({ type: 'message.created', conversationId: conversation.id, messageId: message.id });

    if (msg.fromMe) {
      await this.db.conversation.update({
        where: { id: conversation.id },
        data: { lastOutboundAt: msg.timestamp },
      });
      await this.handoff.takeFromPhone(conversation.id);
      return { kind: 'phone_reply', conversationId: conversation.id, messageId: message.id };
    }

    await this.db.$transaction([
      this.db.conversation.update({
        where: { id: conversation.id },
        data: { lastInboundAt: msg.timestamp, unreadCount: { increment: 1 } },
      }),
      this.db.contact.update({ where: { id: contact.id }, data: { lastMessageAt: msg.timestamp } }),
    ]);

    if (conversation.status === 'RESOLVED') await this.handoff.reopen(conversation.id);

    if (isExplicitHumanRequest(msg.text)) {
      await this.db.message.update({ where: { id: message.id }, data: { aiHandledAt: new Date() } });
      await this.handoff.requestHuman(conversation.id, { type: 'CUSTOMER' }, 'El cliente pidió hablar con una persona');
      return { kind: 'customer', conversationId: conversation.id, messageId: message.id, needsReply: false };
    }

    this.bus.publish({ type: 'conversation.updated', conversationId: conversation.id });
    return { kind: 'customer', conversationId: conversation.id, messageId: message.id, needsReply: true };
  }
}

import { getContentType, normalizeMessageContent, type WAMessage } from 'baileys';
import type { InboundWhatsAppMessage } from './transport.js';

const IGNORED_TYPES = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'messageContextInfo',
]);

function toDate(ts: WAMessage['messageTimestamp']): Date {
  if (!ts) return new Date();
  const seconds = typeof ts === 'number' ? ts : Number(ts.toString());
  return new Date(seconds * 1000);
}

export function mapWAMessage(msg: WAMessage): InboundWhatsAppMessage | null {
  const jid = msg.key.remoteJid;
  if (!jid || !msg.key.id || !msg.message) return null;
  if (jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) {
    return null;
  }
  const content = normalizeMessageContent(msg.message);
  const contentType = getContentType(content);
  if (!content || !contentType || IGNORED_TYPES.has(contentType)) return null;

  let type: InboundWhatsAppMessage['type'] = 'OTHER';
  let text: string | null = null;
  let mediaMime: string | null = null;
  switch (contentType) {
    case 'conversation':
      type = 'TEXT';
      text = content.conversation ?? null;
      break;
    case 'extendedTextMessage':
      type = 'TEXT';
      text = content.extendedTextMessage?.text ?? null;
      break;
    case 'imageMessage':
      type = 'IMAGE';
      text = content.imageMessage?.caption ?? null;
      mediaMime = content.imageMessage?.mimetype ?? null;
      break;
    case 'videoMessage':
      type = 'VIDEO';
      text = content.videoMessage?.caption ?? null;
      mediaMime = content.videoMessage?.mimetype ?? null;
      break;
    case 'audioMessage':
      type = 'AUDIO';
      mediaMime = content.audioMessage?.mimetype ?? null;
      break;
    case 'documentMessage':
      type = 'DOCUMENT';
      text = content.documentMessage?.caption ?? content.documentMessage?.fileName ?? null;
      mediaMime = content.documentMessage?.mimetype ?? null;
      break;
    case 'stickerMessage':
      type = 'STICKER';
      break;
    case 'locationMessage':
      type = 'LOCATION';
      text = content.locationMessage?.name ?? content.locationMessage?.address ?? null;
      break;
    default:
      type = 'OTHER';
  }

  const altJid = (msg.key as { remoteJidAlt?: string }).remoteJidAlt ?? null;
  return {
    externalId: msg.key.id,
    chatJid: jid,
    altJid: altJid && altJid !== jid ? altJid : null,
    fromMe: !!msg.key.fromMe,
    pushName: msg.pushName ?? null,
    type,
    text,
    mediaMime,
    timestamp: toDate(msg.messageTimestamp),
  };
}

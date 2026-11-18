export interface InboundWhatsAppMessage {
  externalId: string;
  chatJid: string;
  altJid: string | null;
  fromMe: boolean;
  pushName: string | null;
  type: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER' | 'LOCATION' | 'OTHER';
  text: string | null;
  mediaMime: string | null;
  timestamp: Date;
}

export interface WhatsAppTransport {
  isConnected(jid?: string): boolean;
  sendText(jid: string, text: string): Promise<{ externalId: string }>;
  sendMedia(jid: string, media: OutboundMedia): Promise<{ externalId: string }>;
}

export interface OutboundMedia {
  kind: 'IMAGE' | 'VIDEO';
  data: Buffer;
  mimetype: string;
  caption?: string | null;
}

export class WhatsAppNotConnectedError extends Error {
  constructor() {
    super('WhatsApp no está conectado');
  }
}

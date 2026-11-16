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
  isConnected(): boolean;
  sendText(jid: string, text: string): Promise<{ externalId: string }>;
}

export class WhatsAppNotConnectedError extends Error {
  constructor() {
    super('WhatsApp no está conectado');
  }
}

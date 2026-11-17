import { channelOf } from './channel.js';
import type { OutboundMedia, WhatsAppTransport } from '../whatsapp/transport.js';

export class ChannelRouter implements WhatsAppTransport {
  constructor(
    private readonly whatsapp: WhatsAppTransport,
    private readonly meta: WhatsAppTransport,
  ) {}

  private transport(jid?: string) {
    return jid && channelOf(jid) !== 'WHATSAPP' ? this.meta : this.whatsapp;
  }

  isConnected(jid?: string): boolean {
    return this.transport(jid).isConnected(jid);
  }

  sendText(jid: string, text: string): Promise<{ externalId: string }> {
    return this.transport(jid).sendText(jid, text);
  }

  sendMedia(jid: string, media: OutboundMedia): Promise<{ externalId: string }> {
    return this.transport(jid).sendMedia(jid, media);
  }
}

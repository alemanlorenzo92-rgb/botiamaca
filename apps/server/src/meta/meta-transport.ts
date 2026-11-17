import type { Channel } from '@prisma/client';
import type { OutboundMedia, WhatsAppTransport } from '../whatsapp/transport.js';

const GRAPH_URL = 'https://graph.facebook.com/v21.0';

export class MetaTransport implements WhatsAppTransport {
  constructor(private readonly accessToken: string | null) {}

  isConnected(_jid?: string): boolean {
    return !!this.accessToken;
  }

  async sendText(jid: string, text: string): Promise<{ externalId: string }> {
    if (!this.accessToken) throw new Error('Meta no está configurado');
    const recipientId = jid.slice(3);
    const url = new URL(`${GRAPH_URL}/me/messages`);
    url.searchParams.set('access_token', this.accessToken);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' }),
    });
    const result = (await response.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
    if (!response.ok || !result.message_id) {
      throw new Error(result.error?.message ? `Meta: ${result.error.message}` : `Meta no pudo enviar el mensaje (HTTP ${response.status})`);
    }
    return { externalId: result.message_id };
  }

  async sendMedia(_jid: string, _media: OutboundMedia): Promise<{ externalId: string }> {
    throw new Error('Meta no permite enviar fotos ni videos por este canal');
  }

  async lookupName(channel: Channel, id: string): Promise<string | null> {
    if (!this.accessToken) return null;
    const url = new URL(`${GRAPH_URL}/${encodeURIComponent(id)}`);
    url.searchParams.set('fields', channel === 'INSTAGRAM' ? 'name' : 'first_name,last_name');
    url.searchParams.set('access_token', this.accessToken);
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const result = (await response.json()) as { name?: string; first_name?: string; last_name?: string };
    return channel === 'INSTAGRAM' ? result.name?.trim() || null : [result.first_name, result.last_name].filter(Boolean).join(' ') || null;
  }
}

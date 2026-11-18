import type { Channel } from '@prisma/client';
import { channelOf } from './channel.js';
import type { OutboundMedia, WhatsAppTransport } from '../whatsapp/transport.js';

const GRAPH_URL = 'https://graph.facebook.com/v21.0';

function splitText(text: string, channel: Channel): string[] {
  const limit = channel === 'INSTAGRAM' ? 1000 : 2000;
  const prefixEnd = (value: string) => {
    let end = 0;
    let length = 0;
    for (const character of value) {
      const size = channel === 'INSTAGRAM' ? Buffer.byteLength(character, 'utf8') : 1;
      if (length + size > limit) break;
      length += size;
      end += character.length;
    }
    return end;
  };
  const parts: string[] = [];
  let remaining = text;

  while (remaining) {
    const end = prefixEnd(remaining);
    if (end === remaining.length) {
      parts.push(remaining);
      break;
    }

    const prefix = remaining.slice(0, end);
    const lineBreak = prefix.lastIndexOf('\n');
    let cut = lineBreak > 0 ? lineBreak - (prefix[lineBreak - 1] === '\r' ? 1 : 0) : -1;
    let next = lineBreak + 1;
    if (cut <= 0) {
      const sentence = prefix.lastIndexOf('. ');
      if (sentence > 0) {
        cut = sentence + 1;
        next = sentence + 2;
      } else {
        const space = prefix.lastIndexOf(' ');
        if (space > 0) {
          cut = space;
          next = space + 1;
        }
      }
    }
    if (cut <= 0) {
      cut = end;
      next = end;
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(next);
  }

  return parts.length ? parts : [''];
}

export class MetaTransport implements WhatsAppTransport {
  constructor(private readonly accessToken: string | null) {}

  isConnected(_jid?: string): boolean {
    return !!this.accessToken;
  }

  async sendText(jid: string, text: string): Promise<{ externalId: string }> {
    if (!this.accessToken) throw new Error('Meta no está configurado');
    const recipientId = jid.slice(3);
    const channel = channelOf(jid);
    const url = new URL(`${GRAPH_URL}/me/messages`);
    url.searchParams.set('access_token', this.accessToken);
    let externalId = '';
    for (const part of splitText(text, channel)) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part }, messaging_type: 'RESPONSE' }),
      });
      const result = (await response.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
      if (!response.ok || !result.message_id) {
        throw new Error(result.error?.message ? `Meta: ${result.error.message}` : `Meta no pudo enviar el mensaje (HTTP ${response.status})`);
      }
      externalId = result.message_id;
    }
    return { externalId };
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

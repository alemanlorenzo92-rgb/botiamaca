import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Channel } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import type { InboundWhatsAppMessage } from '../../whatsapp/transport.js';

interface MetaMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    is_echo?: boolean;
    app_id?: number | string;
    text?: string;
    attachments?: { type?: string; payload?: { mime_type?: string } }[];
  };
}

interface MetaPayload {
  object?: string;
  entry?: { messaging?: MetaMessagingEvent[] }[];
}

function verifySignature(body: Buffer, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const provided = signature.slice('sha256='.length);
  if (!/^[\da-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(provided, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function inboundType(type: string | undefined): InboundWhatsAppMessage['type'] {
  switch (type) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'audio':
      return 'AUDIO';
    case 'file':
      return 'DOCUMENT';
    case 'sticker':
      return 'STICKER';
    default:
      return 'OTHER';
  }
}

export function registerMetaWebhook(c: Container) {
  return async (app: FastifyInstance) => {
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    app.get('/webhooks/meta', async (request, reply) => {
      const url = new URL(request.url, 'http://localhost');
      if (
        url.searchParams.get('hub.mode') !== 'subscribe' ||
        !c.env.META_APP_SECRET ||
        !c.env.META_VERIFY_TOKEN ||
        !c.env.META_PAGE_ACCESS_TOKEN ||
        url.searchParams.get('hub.verify_token') !== c.env.META_VERIFY_TOKEN
      ) {
        return reply.code(403).send();
      }
      return reply.type('text/plain').send(url.searchParams.get('hub.challenge') ?? '');
    });

    app.post('/webhooks/meta', async (request, reply) => {
      const body = request.body;
      const signature = request.headers['x-hub-signature-256'];
      if (
        !c.env.META_APP_SECRET ||
        !c.env.META_VERIFY_TOKEN ||
        !c.env.META_PAGE_ACCESS_TOKEN ||
        !Buffer.isBuffer(body) ||
        !verifySignature(body, Array.isArray(signature) ? signature[0] : signature, c.env.META_APP_SECRET)
      ) {
        return reply.code(401).send();
      }
      reply.code(200).send('EVENT_RECEIVED');
      void processPayload(c, body)
        .catch((error: unknown) => request.log.error({ err: error }, 'falló el procesamiento del webhook de Meta'));
    });
  };
}

async function processPayload(c: Container, body: Buffer) {
  const payload = JSON.parse(body.toString('utf8')) as MetaPayload;
  const channel: Channel | null = payload.object === 'instagram' ? 'INSTAGRAM' : payload.object === 'page' ? 'MESSENGER' : null;
  if (!channel) return;
  const prefix = channel === 'INSTAGRAM' ? 'ig:' : 'fb:';

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      if (!message?.mid) continue;
      const fromMe = message.is_echo === true;
      if (fromMe && String(message.app_id) === c.env.META_APP_ID) continue;
      const id = (fromMe ? event.recipient?.id : event.sender?.id)?.trim();
      if (!id) continue;
      const chatJid = `${prefix}${id}`;
      let pushName: string | null = null;
      if (!fromMe && !(await c.db.contact.findUnique({ where: { waJid: chatJid }, select: { id: true } }))) {
        try {
          pushName = await c.metaTransport.lookupName(channel, id);
        } catch {
          pushName = null;
        }
      }
      const attachment = message.attachments?.[0];
      await c.handleInbound({
        externalId: message.mid,
        chatJid,
        altJid: null,
        fromMe,
        pushName,
        type: attachment ? inboundType(attachment.type) : message.text ? 'TEXT' : 'OTHER',
        text: typeof message.text === 'string' ? message.text : null,
        mediaMime: attachment?.payload?.mime_type ?? null,
        timestamp: typeof event.timestamp === 'number' ? new Date(event.timestamp) : new Date(),
      });
    }
  }
}

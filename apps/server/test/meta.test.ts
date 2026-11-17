import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInstructions } from '../src/ai/prompt.js';
import { buildServer } from '../src/http/server.js';
import { MetaTransport } from '../src/meta/meta-transport.js';
import { createTestContainer, db, resetDb, textReply, type FakeLlm, type FakeTransport, type TestContainer } from './helpers.js';

const APP_SECRET = 'meta-test-secret';
const VERIFY_TOKEN = 'meta-verify-token';
const PAGE_TOKEN = 'meta-page-token';
const WHATSAPP_LINK = 'https://wa.me/5493584000000';

let app: FastifyInstance;
let c: TestContainer;
let llm: FakeLlm;
let whatsapp: FakeTransport;
let fetchCalls: { url: string; init?: RequestInit }[];

beforeEach(async () => {
  await resetDb();
  const testContainer = createTestContainer({}, {
    META_APP_SECRET: APP_SECRET,
    META_VERIFY_TOKEN: VERIFY_TOKEN,
    META_PAGE_ACCESS_TOKEN: PAGE_TOKEN,
    META_APP_ID: '12345',
    WHATSAPP_CONTACT_LINK: WHATSAPP_LINK,
  });
  c = testContainer.c;
  llm = testContainer.llm;
  whatsapp = testContainer.transport;
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ message_id: 'meta-bot-mid' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ name: 'Cliente de Instagram' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  app = await buildServer(c, { panelDir: '/no-existe' });
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

afterAll(() => db.$disconnect());

function sign(body: string) {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

async function postMeta(payload: unknown) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    payload: body,
  });
}

function instagramMessage(message: Record<string, unknown>, id = 'IG_CUSTOMER_1') {
  return {
    object: 'instagram',
    entry: [{
      messaging: [{
        sender: { id },
        recipient: { id: 'IG_PAGE_1' },
        timestamp: Date.now(),
        message,
      }],
    }],
  };
}

describe('webhook de Meta', () => {
  it('verifica el token de suscripción y rechaza uno incorrecto', async () => {
    const ok = await app.inject({ url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('abc123');

    const wrong = await app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=incorrecto&hub.challenge=abc123' });
    expect(wrong.statusCode).toBe(403);
  });

  it('rechaza firmas inválidas sin crear datos', async () => {
    const body = JSON.stringify(instagramMessage({ mid: 'bad-signature', text: 'Hola' }));
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00'.repeat(32) },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(await db.contact.count()).toBe(0);
    expect(await db.message.count()).toBe(0);
  });

  it('deshabilita los webhooks de Meta si falta META_APP_ID', async () => {
    const { c: noAppId } = createTestContainer({}, {
      META_APP_SECRET: APP_SECRET,
      META_VERIFY_TOKEN: VERIFY_TOKEN,
      META_PAGE_ACCESS_TOKEN: PAGE_TOKEN,
    });
    const server = await buildServer(noAppId, { panelDir: '/no-existe' });
    const body = JSON.stringify(instagramMessage({ mid: 'missing-meta-app-id', text: 'Hola' }));

    try {
      const verify = await server.inject({
        url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`,
      });
      const post = await server.inject({
        method: 'POST',
        url: '/webhooks/meta',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        payload: body,
      });

      expect(verify.statusCode).toBe(403);
      expect(post.statusCode).toBe(401);
      expect(noAppId.metaTransport.isConnected()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('devuelve 500 si falla un evento, pero procesa los siguientes', async () => {
    vi.spyOn(c, 'handleInbound').mockRejectedValueOnce(new Error('Falló el primer evento'));
    const response = await postMeta({
      object: 'instagram',
      entry: [{
        messaging: [
          {
            sender: { id: 'IG_FIRST' },
            recipient: { id: 'IG_PAGE_1' },
            timestamp: Date.now(),
            message: { mid: 'ig-failed-event', text: 'Hola' },
          },
          {
            sender: { id: 'IG_SECOND' },
            recipient: { id: 'IG_PAGE_1' },
            timestamp: Date.now(),
            message: { mid: 'ig-ingested-after-failure', text: 'Quiero hablar con la dueña' },
          },
        ],
      }],
    });

    expect(response.statusCode).toBe(500);
    expect(await db.message.findUnique({ where: { externalId: 'ig-ingested-after-failure' } })).toMatchObject({
      direction: 'INBOUND',
      author: 'CUSTOMER',
    });
    expect(await db.message.findUnique({ where: { externalId: 'ig-failed-event' } })).toBeNull();
  });

  it('ingresa mensajes de Instagram, responde por Meta aunque WhatsApp esté desconectado y toma ecos de la dueña', async () => {
    whatsapp.connected = false;
    llm.push(textReply('¡Hola! Seguimos por WhatsApp.'));
    expect((await postMeta(instagramMessage({ mid: 'ig-inbound-mid', text: 'Hola, me interesa un producto' }))).statusCode).toBe(200);

    await vi.waitFor(async () => {
      expect(await db.message.findFirst({ where: { externalId: 'meta-bot-mid' } })).toMatchObject({
        direction: 'OUTBOUND',
        author: 'AI',
        status: 'SENT',
      });
    });

    const contact = await db.contact.findUniqueOrThrow({ where: { waJid: 'ig:IG_CUSTOMER_1' } });
    expect(contact).toMatchObject({ channel: 'INSTAGRAM', pushName: 'Cliente de Instagram' });
    expect(contact.phone).toBeNull();
    expect(await db.message.findFirst({ where: { externalId: 'ig-inbound-mid' } })).toMatchObject({
      direction: 'INBOUND',
      author: 'CUSTOMER',
      status: 'RECEIVED',
    });
    expect(fetchCalls.some((call) => call.init?.method === 'POST')).toBe(true);
    const sent = fetchCalls.find((call) => call.init?.method === 'POST');
    expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
      recipient: { id: 'IG_CUSTOMER_1' },
      message: { text: '¡Hola! Seguimos por WhatsApp.' },
      messaging_type: 'RESPONSE',
    });
    expect(String(llm.calls[0]?.instructions)).toContain(WHATSAPP_LINK);
    expect(await c.sender.isReady((await db.conversation.findFirstOrThrow()).id)).toBe(true);

    const duplicate = await c.conversations.ingest({
      externalId: 'meta-bot-mid',
      chatJid: 'ig:IG_CUSTOMER_1',
      altJid: null,
      fromMe: true,
      pushName: null,
      type: 'TEXT',
      text: '¡Hola! Seguimos por WhatsApp.',
      mediaMime: null,
      timestamp: new Date(),
    });
    expect(duplicate.kind).toBe('duplicate');

    const appEcho = {
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: 'IG_PAGE_1' },
          recipient: { id: 'IG_CUSTOMER_1' },
          timestamp: Date.now(),
          message: { mid: 'ig-app-echo-mid', is_echo: true, app_id: 12345, text: 'Respuesta de la app' },
        }],
      }],
    };
    expect((await postMeta(appEcho)).statusCode).toBe(200);
    expect(await db.conversation.findFirst()).toMatchObject({ status: 'AI_ACTIVE' });
    expect(await db.message.count()).toBe(2);

    const ownerEcho = {
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: 'IG_PAGE_1' },
          recipient: { id: 'IG_CUSTOMER_1' },
          timestamp: Date.now(),
          message: { mid: 'ig-owner-mid', is_echo: true, app_id: 263902037430900, text: 'Te respondo yo' },
        }],
      }],
    };
    expect((await postMeta(ownerEcho)).statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect(await db.conversation.findFirst()).toMatchObject({ status: 'HUMAN_ACTIVE' });
      expect(await db.message.findFirst({ where: { externalId: 'ig-owner-mid' } })).toMatchObject({ direction: 'OUTBOUND', author: 'HUMAN' });
    });
    expect(await db.message.count()).toBe(3);
  });

  it('incluye el número escrito solo en las instrucciones de Instagram', async () => {
    const contact = await db.contact.create({ data: { waJid: 'ig:PROMPT_CUSTOMER', channel: 'INSTAGRAM' } });
    const common = {
      ai: await c.settings.getAi(),
      contact,
      whatsappLink: 'https://wa.me/5493584123456',
      businessProfile: null,
      configuredTopics: [],
      now: new Date(),
    };
    const instagram = buildInstructions({ ...common, channel: 'INSTAGRAM' });
    const messenger = buildInstructions({ ...common, channel: 'MESSENGER' });

    expect(instagram).toContain('+54 9 3584123456');
    expect(instagram).toContain('https://wa.me/5493584123456');
    expect(messenger).toContain('https://wa.me/5493584123456');
    expect(messenger).not.toContain('+54 9 3584123456');
  });

  it('divide textos largos de Instagram en partes de hasta 1000 bytes', async () => {
    fetchCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return new Response(JSON.stringify({ message_id: `segment-${fetchCalls.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const text = 'ñ'.repeat(1250);
    const result = await new MetaTransport(PAGE_TOKEN).sendText('ig:IG_CUSTOMER_1', text);
    const parts = fetchCalls.map(({ init }) => JSON.parse(String(init?.body)).message.text as string);

    expect(fetchCalls).toHaveLength(3);
    expect(parts.every((part) => Buffer.byteLength(part, 'utf8') <= 1000)).toBe(true);
    expect(parts.join('')).toBe(text);
    expect(result.externalId).toBe('segment-3');
  });

  it('no envía seguimientos automáticos a una conversación de Instagram elegible', async () => {
    const contact = await db.contact.create({ data: { waJid: 'ig:FOLLOWUP', channel: 'INSTAGRAM' } });
    const lastInboundAt = new Date(Date.now() - 2 * 60_000);
    const lastOutboundAt = new Date(Date.now() - 60_000);
    const conversation = await db.conversation.create({
      data: { contactId: contact.id, lastInboundAt, lastOutboundAt, status: 'AI_ACTIVE' },
    });
    await db.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        author: 'AI',
        type: 'TEXT',
        text: 'Hola',
        status: 'SENT',
        createdAt: lastOutboundAt,
      },
    });
    const now = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    while (now.getUTCDay() === 0 || now.getUTCDay() === 6) now.setUTCDate(now.getUTCDate() + 1);
    now.setUTCHours(13, 0, 0, 0);

    expect(await c.autoFollowups.runOnce(now)).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

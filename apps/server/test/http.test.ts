import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createTestContainer, db, resetDb } from './helpers.js';

let app: FastifyInstance;
const { c } = createTestContainer();

beforeAll(async () => {
  app = await buildServer(c, { panelDir: '/no-existe' });
});
beforeEach(async () => {
  await resetDb();
  await c.auth.createUser({ email: 'admin@test.local', name: 'Admin', password: 'clave-admin-123', roleCode: 'admin' });
  await c.auth.createUser({ email: 'vende@test.local', name: 'Vende', password: 'clave-vende-123', roleCode: 'agent' });
});
afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

async function login(email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookie = res.cookies.find((ck) => ck.name === 'bot_session');
  return { res, cookie: cookie ? `bot_session=${cookie.value}` : '' };
}

describe('API del panel', () => {
  it('login con argon2 y sesión en cookie httpOnly', async () => {
    expect((await login('admin@test.local', 'mala')).res.statusCode).toBe(401);
    const { res, cookie } = await login('admin@test.local', 'clave-admin-123');
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]?.httpOnly).toBe(true);
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(me.json().user.email).toBe('admin@test.local');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('roles: el vendedor no puede tocar la configuración', async () => {
    const { cookie } = await login('vende@test.local', 'clave-vende-123');
    expect((await app.inject({ url: '/api/conversations', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/settings/ai', headers: { cookie } })).statusCode).toBe(403);
  });

  it('interruptor de IA y datos del negocio', async () => {
    const { cookie } = await login('admin@test.local', 'clave-admin-123');
    const off = await app.inject({ method: 'POST', url: '/api/settings/ai/toggle', headers: { cookie }, payload: { enabled: false } });
    expect(off.json().ai.enabled).toBe(false);
    await app.inject({ method: 'PUT', url: '/api/settings/business/shipping_policy', headers: { cookie }, payload: { value: 'Envíos por Andreani' } });
    expect(await c.settings.getBusiness('shipping_policy')).toBe('Envíos por Andreani');
    await app.inject({ method: 'PUT', url: '/api/settings/business/shipping_policy', headers: { cookie }, payload: { value: null } });
    expect(await c.settings.getBusiness('shipping_policy')).toBeNull();
    const nested = await app.inject({ method: 'PUT', url: '/api/settings/business/faq', headers: { cookie }, payload: { value: { cambios: null, items: ['a', null] } } });
    expect(nested.statusCode).toBe(200);
    const hours = await app.inject({ method: 'PUT', url: '/api/settings/ai', headers: { cookie }, payload: { businessHours: { days: { mon: [['9:00', '18:00']], sat: [['10:00', '13:00']] } } } });
    expect(hours.statusCode).toBe(200);
    const badTz = await app.inject({ method: 'PUT', url: '/api/settings/ai', headers: { cookie }, payload: { businessHours: { timezone: 'Nope/Nada', days: {} } } });
    expect(badTz.statusCode).toBe(400);
  });

  it('responder desde el panel toma la conversación', async () => {
    const { cookie } = await login('admin@test.local', 'clave-admin-123');
    const contact = await db.contact.create({ data: { waJid: '5493510000009@s.whatsapp.net' } });
    const conv = await db.conversation.create({ data: { contactId: contact.id } });
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie }, payload: { text: 'Hola, te atiendo yo' } });
    expect(res.statusCode).toBe(200);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).status).toBe('HUMAN_ACTIVE');
  });

  it('webhook de Tiendanube rechaza firmas inválidas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/tiendanube',
      headers: { 'content-type': 'application/json', 'x-linkedstore-hmac-sha256': 'abc' },
      payload: JSON.stringify({ store_id: 999, event: 'product/updated', id: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });
});

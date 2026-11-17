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
    expect((await app.inject({ url: '/api/users', headers: { cookie } })).statusCode).toBe(403);
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

  it('biblioteca: alta de producto, subida de foto (dedupe, formato inválido) y vista previa', async () => {
    const { cookie } = await login('admin@test.local', 'clave-admin-123');
    const created = await app.inject({
      method: 'POST', url: '/api/catalog/products', headers: { cookie },
      payload: { name: 'Glitter corporal', usage: 'Con gel', variants: [{ values: ['Dorado'], retailPrice: 3500, stock: null }] },
    });
    expect(created.statusCode).toBe(200);
    const productId = created.json().product.id;
    const list = await app.inject({ url: '/api/catalog/products', headers: { cookie } });
    expect(list.json().products[0].variants[0].inventory).toBeNull();

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const form = (file: Buffer, name: string) => {
      const b = '----test';
      const payload = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nFoto dorado\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="productId"\r\n\r\n${productId}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        file,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]);
      return { method: 'POST' as const, url: '/api/media', headers: { cookie, 'content-type': `multipart/form-data; boundary=${b}` }, payload };
    };
    const up = await app.inject(form(png, 'a.png'));
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ duplicate: false, asset: { kind: 'IMAGE', title: 'Foto dorado', productId } });
    expect((await app.inject(form(png, 'b.png'))).json().duplicate).toBe(true);
    const bad = await app.inject(form(Buffer.from('hola'), 'x.png'));
    expect(bad.statusCode).toBe(400);
    const file = await app.inject({ url: `/api/media/${up.json().asset.id}/file`, headers: { cookie } });
    expect(file.headers['content-type']).toBe('image/png');
    expect((await app.inject({ url: `/api/media/${up.json().asset.id}/file` })).statusCode).toBe(401);
  });
});

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError, publicUser, requireUser, SESSION_COOKIE, SESSION_TTL_MS } from '../auth.js';
import { parse } from '../validate.js';

export function registerAuthRoutes(c: Container) {
  const secure = c.env.PUBLIC_URL.startsWith('https://');
  return async (app: FastifyInstance) => {
    app.post(
      '/auth/login',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), request.body);
        const result = await c.auth.login(body.email, body.password, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        if (!result) throw new HttpError(401, 'Email o contraseña incorrectos');
        reply.setCookie(SESSION_COOKIE, result.token, {
          httpOnly: true,
          sameSite: 'lax',
          secure,
          path: '/',
          maxAge: Math.floor(SESSION_TTL_MS / 1000),
        });
        return { user: publicUser(result.user) };
      },
    );

    app.post('/auth/logout', async (request, reply) => {
      await c.auth.logout(request.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/auth/me', async (request) => ({ user: publicUser(requireUser(request)) }));
  };
}

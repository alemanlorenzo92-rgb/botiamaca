import { hash, verify } from '@node-rs/argon2';
import type { PrismaClient, Role, User } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuditService } from '../core/audit.js';
import { randomToken, sha256 } from '../core/crypto.js';

export const SESSION_COOKIE = 'bot_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const PERMISSIONS = [
  'inbox',
  'contacts',
  'catalog',
  'knowledge',
  'orders',
  'leads',
  'followups',
  'settings',
  'whatsapp',
  'audit',
  'users',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const DEFAULT_ROLES: { code: string; name: string; permissions: string[] }[] = [
  { code: 'admin', name: 'Administrador', permissions: ['*'] },
  { code: 'agent', name: 'Vendedor/a', permissions: ['inbox', 'contacts', 'catalog', 'orders', 'leads', 'followups'] },
];

export type AuthUser = User & { role: Role };

export function can(user: AuthUser, permission: Permission): boolean {
  return user.role.permissions.includes('*') || user.role.permissions.includes(permission);
}

export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: { code: user.role.code, name: user.role.name },
    permissions: user.role.permissions.includes('*') ? [...PERMISSIONS] : user.role.permissions,
  };
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class AuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  hashPassword(password: string) {
    return hash(password);
  }

  async login(email: string, password: string, meta: { ip: string; userAgent: string | null }) {
    const user = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: { role: true } });
    const ok = user?.active ? await verify(user.passwordHash, password).catch(() => false) : false;
    if (!user || !ok) {
      await this.audit.log({ actorType: 'USER', action: 'auth.login_failed', data: { email }, ip: meta.ip });
      return null;
    }
    const token = randomToken();
    await this.db.session.create({
      data: {
        tokenHash: sha256(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ actorType: 'USER', actorId: user.id, action: 'auth.login', ip: meta.ip });
    return { token, user };
  }

  async fromToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { role: true } } },
    });
    if (!session || session.expiresAt < new Date() || !session.user.active) return null;
    return session.user;
  }

  async logout(token: string | undefined) {
    if (token) await this.db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }

  async createUser(params: { email: string; name: string; password: string; roleCode: string }) {
    const role = await this.db.role.findUnique({ where: { code: params.roleCode } });
    if (!role) throw new Error(`No existe el rol ${params.roleCode} (ejecutá el seed)`);
    return this.db.user.create({
      data: {
        email: params.email.trim().toLowerCase(),
        name: params.name,
        passwordHash: await this.hashPassword(params.password),
        roleId: role.id,
      },
      include: { role: true },
    });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new HttpError(401, 'No autenticado');
  return request.user;
}

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = requireUser(request);
    if (!can(user, permission)) throw new HttpError(403, 'Sin permiso');
  };
}

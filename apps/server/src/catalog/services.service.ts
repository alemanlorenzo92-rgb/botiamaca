import type { EventService, Prisma, PrismaClient } from '@prisma/client';
import type { Faq } from './catalog-admin.service.js';

export const DEFAULT_SERVICES: { service: EventService; name: string }[] = [
  { service: 'GLITTER_BAR', name: 'Glitter Bar' },
  { service: 'SHIMMER_WALL', name: 'Shimmer Walls' },
];

export interface ServiceInput {
  name?: string;
  description?: string;
  conditions?: string;
  faqs?: Faq[];
  info?: Record<string, unknown>;
  active?: boolean;
}

/** Información estructurada de los servicios para eventos, cargada por la dueña. */
export class ServicesService {
  constructor(private readonly db: PrismaClient) {}

  async ensureDefaults() {
    for (const s of DEFAULT_SERVICES) {
      await this.db.serviceInfo.upsert({ where: { service: s.service }, create: s, update: {} });
    }
  }

  list() {
    return this.db.serviceInfo.findMany({ orderBy: { service: 'asc' } });
  }

  update(service: EventService, input: ServiceInput) {
    return this.db.serviceInfo.update({
      where: { service },
      data: {
        name: input.name?.trim(),
        description: input.description?.trim(),
        conditions: input.conditions?.trim(),
        faqs: input.faqs ? (input.faqs.filter((f) => f.q.trim() && f.a.trim()) as unknown as Prisma.InputJsonValue) : undefined,
        info: input.info as Prisma.InputJsonValue | undefined,
        active: input.active,
      },
    });
  }

  /** Vista para la IA: deja explícito qué no está cargado para que no lo invente. */
  async forAi(service: EventService) {
    const s = await this.db.serviceInfo.findUnique({ where: { service } });
    const media = await this.db.mediaAsset.findMany({
      where: { service, active: true },
      select: { id: true, kind: true, title: true },
      take: 6,
      orderBy: { createdAt: 'desc' },
    });
    const tutorials = await this.db.tutorial.findMany({ where: { service, active: true }, select: { id: true, title: true }, take: 5 });
    if (!s || !s.active || !s.description.trim()) {
      return { service, configured: false, media, tutorials };
    }
    return {
      service,
      configured: true,
      name: s.name,
      description: s.description,
      conditions: s.conditions.trim() || null,
      faqs: s.faqs,
      info: s.info,
      media: media.map((m) => ({ media_id: m.id, kind: m.kind, title: m.title })),
      tutorials,
    };
  }
}

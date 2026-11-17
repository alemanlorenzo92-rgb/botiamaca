import { createHash } from 'node:crypto';
import type { EventService, MediaKind, MediaSource, Prisma, PrismaClient } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';
import { normalize } from '../core/text.js';
import type { MediaStorage } from './storage.js';

/** Formatos que WhatsApp muestra sin problemas. */
const ALLOWED: Record<string, { kind: MediaKind; ext: string }> = {
  'image/jpeg': { kind: 'IMAGE', ext: 'jpg' },
  'image/png': { kind: 'IMAGE', ext: 'png' },
  'image/webp': { kind: 'IMAGE', ext: 'webp' },
  'video/mp4': { kind: 'VIDEO', ext: 'mp4' },
  'video/3gpp': { kind: 'VIDEO', ext: '3gp' },
};

export class MediaError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_FORMAT' | 'TOO_LARGE' | 'NOT_FOUND' | 'FILE_MISSING' | 'INACTIVE',
  ) {
    super(message);
  }
}

export interface MediaLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
}

export interface MediaFields {
  title?: string;
  description?: string;
  tags?: string[];
  isTutorial?: boolean;
  active?: boolean;
  productId?: string | null;
  categoryId?: string | null;
  service?: EventService | null;
}

const include = {
  product: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
} satisfies Prisma.MediaAssetInclude;

type AssetWithRefs = Prisma.MediaAssetGetPayload<{ include: typeof include }>;

const SERVICE_LABEL: Record<EventService, string> = { GLITTER_BAR: 'glitter bar', SHIMMER_WALL: 'shimmer wall' };

export function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

export class MediaService {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: MediaStorage,
    private readonly limits: MediaLimits,
  ) {}

  /** Detecta el tipo real por contenido (no por extensión) y valida tamaño. */
  async inspect(data: Buffer): Promise<{ kind: MediaKind; mime: string; ext: string }> {
    const type = await fileTypeFromBuffer(data);
    const allowed = type ? ALLOWED[type.mime] : undefined;
    if (!type || !allowed) throw new MediaError('Formato no soportado. Usá JPG, PNG, WEBP o MP4.', 'INVALID_FORMAT');
    const max = allowed.kind === 'IMAGE' ? this.limits.maxImageBytes : this.limits.maxVideoBytes;
    if (data.length > max) {
      throw new MediaError(`El archivo supera el máximo de ${Math.round(max / 1024 / 1024)} MB`, 'TOO_LARGE');
    }
    return { kind: allowed.kind, mime: type.mime, ext: allowed.ext };
  }

  /** Guarda un archivo. Si ya existe (mismo contenido) devuelve el existente sin duplicarlo. */
  async upload(params: {
    data: Buffer;
    originalName?: string | null;
    source?: MediaSource;
    importedChatId?: string | null;
    fields?: MediaFields;
  }): Promise<{ asset: AssetWithRefs; duplicate: boolean }> {
    const info = await this.inspect(params.data);
    const sha256 = createHash('sha256').update(params.data).digest('hex');
    const existing = await this.db.mediaAsset.findUnique({ where: { sha256 }, include });
    if (existing) {
      if (!(await this.storage.exists(existing.storageKey))) await this.storage.put(existing.storageKey, params.data);
      return { asset: existing, duplicate: true };
    }
    const storageKey = `${sha256.slice(0, 2)}/${sha256}.${info.ext}`;
    await this.storage.put(storageKey, params.data);
    const f = params.fields ?? {};
    const created = await this.db.mediaAsset.create({
      data: {
        sha256,
        kind: info.kind,
        mime: info.mime,
        sizeBytes: params.data.length,
        storageKey,
        originalName: params.originalName?.slice(0, 255) ?? null,
        title: f.title?.trim() ?? '',
        description: f.description?.trim() ?? '',
        tags: cleanTags(f.tags) ?? [],
        isTutorial: f.isTutorial ?? false,
        active: f.active ?? true,
        productId: f.productId ?? null,
        categoryId: f.categoryId ?? null,
        service: f.service ?? null,
        source: params.source ?? 'UPLOAD',
        importedChatId: params.importedChatId ?? null,
      },
    });
    return { asset: await this.refreshSearch(created.id), duplicate: false };
  }

  async update(id: string, fields: MediaFields) {
    await this.db.mediaAsset.update({
      where: { id },
      data: {
        title: fields.title?.trim(),
        description: fields.description?.trim(),
        tags: cleanTags(fields.tags),
        isTutorial: fields.isTutorial,
        active: fields.active,
        productId: fields.productId,
        categoryId: fields.categoryId,
        service: fields.service,
      },
    });
    return this.refreshSearch(id);
  }

  private async refreshSearch(id: string) {
    const a = await this.db.mediaAsset.findUniqueOrThrow({ where: { id }, include });
    const searchText = normalize(
      [a.title, a.description, a.tags.join(' '), a.product?.name, a.category?.name, a.service ? SERVICE_LABEL[a.service] : '', a.isTutorial ? 'tutorial como se usa' : '', a.kind === 'IMAGE' ? 'foto imagen' : 'video']
        .filter(Boolean)
        .join(' '),
    );
    return this.db.mediaAsset.update({ where: { id }, data: { searchText }, include });
  }

  async remove(id: string) {
    const asset = await this.db.mediaAsset.delete({ where: { id } });
    const stillUsed = await this.db.mediaAsset.count({ where: { storageKey: asset.storageKey } });
    if (!stillUsed) await this.storage.remove(asset.storageKey);
    return asset;
  }

  /** Búsqueda para la IA: solo contenido activo y real cargado por la dueña o aprobado de chats. */
  async search(query: string, opts: { kind?: MediaKind | null; productId?: string | null; service?: EventService | null; tutorialsOnly?: boolean; limit?: number } = {}) {
    const terms = normalize(query)
      .split(' ')
      .filter((t) => t.length > 2)
      .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
    const where: Prisma.MediaAssetWhereInput = { active: true };
    if (opts.kind) where.kind = opts.kind;
    if (opts.productId) where.productId = opts.productId;
    if (opts.service) where.service = opts.service;
    if (opts.tutorialsOnly) where.isTutorial = true;
    if (terms.length && !opts.productId && !opts.service) where.OR = terms.map((t) => ({ searchText: { contains: t } }));
    const rows = await this.db.mediaAsset.findMany({ where, include, take: 100, orderBy: { createdAt: 'desc' } });
    const scored = rows
      .map((a) => ({ a, score: terms.reduce((acc, t) => acc + (a.searchText.includes(t) ? 1 : 0), 0) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, Math.min(opts.limit ?? 5, 10));
    return scored.map(({ a }) => this.view(a));
  }

  view(a: AssetWithRefs) {
    return {
      media_id: a.id,
      kind: a.kind,
      title: a.title || a.originalName || 'Sin título',
      description: a.description || null,
      tags: a.tags,
      is_tutorial: a.isTutorial,
      product: a.product?.name ?? null,
      category: a.category?.name ?? null,
      service: a.service,
    };
  }

  async details(id: string) {
    const a = await this.db.mediaAsset.findUnique({ where: { id }, include });
    return a ? { ...this.view(a), active: a.active, mime: a.mime, size_bytes: a.sizeBytes } : null;
  }

  /** Lee el archivo para enviarlo. Falla con un error claro si falta o está desactivado. */
  async load(id: string, opts: { requireActive?: boolean } = {}) {
    const asset = await this.db.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new MediaError('El archivo no existe en la biblioteca', 'NOT_FOUND');
    if (opts.requireActive && !asset.active) throw new MediaError('El archivo está desactivado', 'INACTIVE');
    if (!(await this.storage.exists(asset.storageKey))) throw new MediaError('El archivo no está en el almacenamiento', 'FILE_MISSING');
    return { asset, data: await this.storage.get(asset.storageKey) };
  }
}

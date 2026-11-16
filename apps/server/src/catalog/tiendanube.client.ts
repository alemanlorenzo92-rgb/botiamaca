import type { Logger } from '../core/logger.js';

export interface TiendanubeConfig {
  storeId: string;
  accessToken: string;
  userAgent: string;
  apiVersion: string;
}

export type I18n = Record<string, string | null> | string | null | undefined;

export interface TnVariant {
  id: number;
  product_id: number;
  price: string | null;
  promotional_price: string | null;
  stock_management: boolean;
  stock: number | null;
  sku: string | null;
  weight: string | null;
  values: I18n[];
}

export interface TnProduct {
  id: number;
  name: I18n;
  description: I18n;
  handle: I18n;
  canonical_url?: string | null;
  brand?: string | null;
  tags?: string | null;
  published: boolean;
  free_shipping?: boolean;
  updated_at?: string;
  attributes?: I18n[];
  variants: TnVariant[];
  images?: { src: string; position?: number }[];
  categories?: { id: number }[];
}

export interface TnCategory {
  id: number;
  name: I18n;
  handle: I18n;
  parent: number | null;
}

export class TiendanubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function pickI18n(value: I18n): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.es ?? Object.values(value).find((v) => !!v) ?? '';
}

/** Cliente de la API oficial de Tiendanube (nunca scraping). */
export class TiendanubeClient {
  constructor(
    private readonly config: TiendanubeConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get baseUrl() {
    return `https://api.tiendanube.com/${this.config.apiVersion}/${this.config.storeId}`;
  }

  async request<T>(path: string, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authentication: `bearer ${this.config.accessToken}`,
        'User-Agent': this.config.userAgent,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < 5) {
      const resetMs = Number(res.headers.get('x-rate-limit-reset') ?? '1000');
      await new Promise((r) => setTimeout(r, Math.min(Math.max(resetMs, 500), 10_000)));
      return this.request<T>(path, attempt + 1);
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return this.request<T>(path, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TiendanubeError(`Tiendanube ${res.status} en ${path}: ${body.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const perPage = 200;
    const all: T[] = [];
    for (let page = 1; page < 500; page++) {
      const sep = path.includes('?') ? '&' : '?';
      let batch: T[];
      try {
        batch = await this.request<T[]>(`${path}${sep}per_page=${perPage}&page=${page}`);
      } catch (error) {
        if (error instanceof TiendanubeError && error.status === 404 && page > 1) break;
        throw error;
      }
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    this.logger.debug({ path, count: all.length }, 'tiendanube paginate');
    return all;
  }

  listProducts() {
    return this.paginate<TnProduct>('/products');
  }

  listCategories() {
    return this.paginate<TnCategory>('/categories');
  }

  async getProduct(id: string | number): Promise<TnProduct | null> {
    try {
      return await this.request<TnProduct>(`/products/${id}`);
    } catch (error) {
      if (error instanceof TiendanubeError && error.status === 404) return null;
      throw error;
    }
  }
}

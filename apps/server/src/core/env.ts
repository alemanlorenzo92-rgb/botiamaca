import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY debe ser 32 bytes en base64'),
  LOG_LEVEL: z.string().default('info'),
  /** Detrás de un proxy reverso: 'true' o la cantidad de saltos. Si el puerto es público, dejar 'false'. */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v)))
    .refine((v) => typeof v === 'boolean' || (Number.isInteger(v) && v >= 0), 'TRUST_PROXY debe ser true, false o un número'),
  WHATSAPP_ENABLED: bool,
  WHATSAPP_CONTACT_LINK: z.string().url().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(800),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /// Carpeta de la biblioteca multimedia (en producción, un volumen persistente)
  MEDIA_DIR: z.string().default('./data/media'),
  MEDIA_MAX_IMAGE_MB: z.coerce.number().positive().default(10),
  /// WhatsApp acepta videos de hasta 16 MB
  MEDIA_MAX_VIDEO_MB: z.coerce.number().positive().default(16),
  IMPORT_MAX_MB: z.coerce.number().positive().default(200),
});

export type Env = z.infer<typeof schema>;

function emptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === '' ? undefined : v]));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(emptyToUndefined(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${issues}`);
  }
  return parsed.data;
}

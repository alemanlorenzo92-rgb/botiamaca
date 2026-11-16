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
  WHATSAPP_ENABLED: bool,
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(800),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  TIENDANUBE_STORE_ID: z.string().optional(),
  TIENDANUBE_ACCESS_TOKEN: z.string().optional(),
  TIENDANUBE_APP_SECRET: z.string().optional(),
  TIENDANUBE_USER_AGENT: z.string().default('WhatsAppSalesBot (contacto@ejemplo.com)'),
  TIENDANUBE_API_VERSION: z.string().default('2025-03'),
  CATALOG_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
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

import { z } from 'zod';

/** Palabras clave que el modo `strict` no garantiza: igual se validan en el backend con zod. */
const UNSUPPORTED = new Set(['minLength', 'maxLength', 'minItems', 'maxItems']);

/** Convierte un esquema zod a JSON Schema compatible con el modo `strict` de OpenAI. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return tighten(json) as Record<string, unknown>;
}

function tighten(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tighten);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) continue;
    if ((k === 'maximum' && v === Number.MAX_SAFE_INTEGER) || (k === 'minimum' && v === Number.MIN_SAFE_INTEGER)) {
      continue;
    }
    if (k === 'pattern' && (node as Record<string, unknown>).format === 'uuid') continue;
    out[k] = tighten(v);
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    out.properties ??= {};
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

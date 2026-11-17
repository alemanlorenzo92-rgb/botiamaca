/** Quita datos personales de un texto antes de guardarlo o mandarlo a OpenAI. */
const RULES: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\b\d{22}\b/g, '[cbu]'],
  [/\b(alias)\s*:?\s*[a-z0-9]+(?:\.[a-z0-9]+){1,3}\b/gi, '$1 [alias]'],
  [/\+?\d[\d\s().-]{7,}\d/g, '[teléfono]'],
  [/\b\d{1,2}\.?\d{3}\.?\d{3}\b/g, '[documento]'],
];

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function anonymize(text: string, names: Map<string, string> = new Map()): string {
  let out = text;
  for (const [re, label] of RULES) out = out.replace(re, label);
  // Nombres de participantes (completos y primer nombre) por su alias.
  for (const [name, alias] of names) {
    const parts = [name, ...name.split(/\s+/).filter((p) => p.length > 2)];
    for (const part of parts) {
      if (/^\+?[\d\s-]+$/.test(part)) continue;
      out = out.replace(new RegExp(`(?<![\\p{L}])${escape(part)}(?![\\p{L}])`, 'giu'), alias);
    }
  }
  return out;
}

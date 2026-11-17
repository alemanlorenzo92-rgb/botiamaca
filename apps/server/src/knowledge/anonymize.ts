/** Quita datos personales de un texto antes de guardarlo o mandarlo a OpenAI. */
const STREET = String.raw`(?:calle|av(?:enida|da)?\.?|bv\.?|bulevar|boulevard|pasaje|psje\.?|diagonal|camino)`;
const RULES: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/(?<![\w.@])@[\w.]{3,30}/g, '[usuario]'],
  [/\b\d{22}\b/g, '[cbu]'],
  [/\b(alias)\s*:?\s*[a-z0-9]+(?:\.[a-z0-9]+){1,3}\b/gi, '$1 [alias]'],
  [/\b\d{1,2}\.\d{3}\.\d{3}\b/g, '[documento]'],
  [/\b(dni|documento)\s*:?\s*\d{7,8}\b/gi, '$1 [documento]'],
  [/\+?\d[\d\s().-]{7,}\d/g, '[teléfono]'],
  // Direcciones: calle + número, piso/depto, código postal y lo que sigue a "mi dirección es…".
  [new RegExp(String.raw`(?<!\p{L})${STREET}\s+[\p{L}\d°º.' ]{2,40}?\s+(?:n[°º.]?\s*)?\d{1,5}(?!\d)`, 'giu'), '[dirección]'],
  [/(?<!\p{L})(piso|dpto\.?|depto\.?|departamento)\s*\d{1,3}\s*[°º]?\s*(?:[a-z](?!\p{L}))?/giu, '[dirección]'],
  [/(?<!\p{L})(c\.?\s?p\.?|c[oó]digo postal)\s*:?\s*[a-z]?\d{4}[a-z]{0,3}(?!\p{L})/giu, '$1 [código postal]'],
  [/(?<!\p{L})(direcci[oó]n|domicilio|vivo en|env[ií]a(?:lo|melo|mela|la)? a|entreg(?:a|ar|alo) en)(\s*(?:es)?\s*:?\s*)[^\n.,;!?]*\d[^\n.,;!?]*/giu, '$1$2[dirección]'],
  [/(?<!\p{L})([Bb]arrio|[Bb]° ?)\s*\p{Lu}[\p{L}'’]*(?:\s+\p{Lu}[\p{L}'’]*){0,2}/gu, '$1 [barrio]'],
];

/** Palabras con mayúscula que no son nombres de personas (saludos, negocio, días, meses…). */
const NOT_NAMES = new Set(
  (
    'buenas buen buenos buena gracias hola chau male style glitter shimmer bar wall walls cliente dueña todo todos todas ' +
    'chicas chicos linda lindo hermosa hermoso genia genio amiga amigo reina bella divina señora señor sra sr dios muchas ' +
    'muchos mil igualmente perfecto dale ok si sí no ya te me que qué cómo como cuando dónde donde es el la los las un una ' +
    'lunes martes miércoles jueves viernes sábado domingo enero febrero marzo abril mayo junio julio agosto septiembre ' +
    'octubre noviembre diciembre navidad año nuevo feliz día'
  ).split(' '),
);

const NAME = String.raw`\p{Lu}[\p{L}'’]+(?:\s+\p{Lu}[\p{L}'’]+){0,2}`;
/** Contextos donde una palabra con mayúscula suele ser el nombre de alguien. */
const NAME_CONTEXTS: RegExp[] = [
  new RegExp(String.raw`(?<!\p{L})([Ss]oy|[Mm]e llamo|[Mm]i nombre es|[Dd]e parte de|[Aa] nombre de|[Hh]abla)(\s+)(${NAME})`, 'gu'),
  new RegExp(
    String.raw`(?<!\p{L})([Mm]i|[Tt]u|[Ss]u)\s+(?:hij[oa]|mam[aá]|madre|pap[aá]|padre|marido|espos[oa]|novi[oa]|herman[oa]|amig[oa]|prim[oa]|t[ií][oa]|sobrin[oa]|niet[oa]|abuel[oa]|cuñad[oa]|suegr[oa]|compañer[oa]|vecin[oa]|jef[ae]|soci[oa]|clienta|cliente)(\s+)(${NAME})`,
    'gu',
  ),
  new RegExp(
    String.raw`(?<!\p{L})([Hh]ola|[Gg]racias|[Cc]hau|[Bb]uen[oa]s(?:\s+(?:d[ií]as|tardes|noches))?|[Qq]uerid[oa]|[Hh]ermosa|[Gg]enia|[Dd]ale)(\s*,?\s+)(${NAME})`,
    'gu',
  ),
];

function redactName(name: string): string {
  const words = name.split(/(\s+)/);
  let i = 0;
  while (i < words.length && (words[i]!.trim() === '' || !NOT_NAMES.has(words[i]!.toLowerCase()))) i++;
  const nameWords = words.slice(0, i).join('').trim();
  if (!nameWords || /^Cliente\s*\d*$/.test(nameWords)) return name;
  return `[nombre]${words.slice(i).join('').replace(/^(?=\S)/, ' ')}`;
}

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
  // Nombres de terceros mencionados en el texto (hija, amiga, quien retira…), sin tocar el resto de la frase.
  for (const re of NAME_CONTEXTS) out = out.replace(re, (m: string, ...g: string[]) => m.slice(0, m.length - g[2]!.length) + redactName(g[2]!));
  return out;
}

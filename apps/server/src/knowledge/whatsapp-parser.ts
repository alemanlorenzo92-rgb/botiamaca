/**
 * Parser de chats exportados desde WhatsApp ("Exportar chat"), formatos Android e iOS en español e inglés.
 * Además de estos exports, el bot aprende del historial que WhatsApp manda al vincular el número
 * (`ChatImportService.importHistory`), que trae solo los mensajes recientes.
 */
export interface ParsedMessage {
  sentAt: Date;
  author: string;
  text: string;
  mediaFile: string | null;
  mediaOmitted: boolean;
}

export interface ParsedChat {
  participants: string[];
  messages: ParsedMessage[];
  skippedLines: number;
}

// 16/11/2026, 21:40 - Nombre: texto | 16/11/26 9:40 p. m. - Nombre: texto
const ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\s+-\s+([^:]+?):\s([\s\S]*)$/i;
// [16/11/26, 21:40:12] Nombre: texto
const IOS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]\s+([^:]+?):\s([\s\S]*)$/i;
// Línea de sistema con fecha pero sin autor ("Los mensajes están cifrados…")
const SYSTEM = /^\[?\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}:\d{2}/;

const ATTACHED = [
  /^<adjunto: (.+?)>$/i,
  /^<attached: (.+?)>$/i,
  /^(.+?\.\w{2,5}) \((?:archivo adjunto|file attached)\)$/i,
];
const OMITTED = /^<?(multimedia omitido|media omitted|imagen omitida|video omitido|audio omitido|sticker omitido|image omitted|video omitted|audio omitted|sticker omitted)>?$/i;

const INVISIBLE = /[\u200e\u200f\u202a-\u202e\ufeff]/g;

function toDate(d: string, m: string, y: string, hh: string, mm: string, ss: string | undefined, ampm: string | undefined, utcOffsetMinutes: number) {
  let year = Number(y);
  if (year < 100) year += 2000;
  let hour = Number(hh);
  if (ampm) {
    const pm = ampm.toLowerCase().startsWith('p');
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const utc = Date.UTC(year, Number(m) - 1, Number(d), hour, Number(mm), Number(ss ?? 0));
  return new Date(utc - utcOffsetMinutes * 60_000);
}

/** utcOffsetMinutes: zona horaria del teléfono que exportó (Argentina = -180). */
export function parseWhatsAppExport(raw: string, utcOffsetMinutes = -180): ParsedChat {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const messages: ParsedMessage[] = [];
  const participants = new Set<string>();
  let skippedLines = 0;

  for (const original of lines) {
    const line = original.replace(INVISIBLE, '');
    const match = ANDROID.exec(line) ?? IOS.exec(line);
    if (match) {
      const [, d, m, y, hh, mm, ss, ampm, author, body] = match as unknown as string[];
      const name = author!.trim();
      participants.add(name);
      const text = body!.trim();
      let mediaFile: string | null = null;
      for (const re of ATTACHED) {
        const a = re.exec(text);
        if (a) mediaFile = a[1]!.trim();
      }
      const mediaOmitted = OMITTED.test(text);
      messages.push({
        sentAt: toDate(d!, m!, y!, hh!, mm!, ss, ampm, utcOffsetMinutes),
        author: name,
        text: mediaFile || mediaOmitted ? '' : text,
        mediaFile,
        mediaOmitted,
      });
    } else if (SYSTEM.test(line)) {
      skippedLines++;
    } else if (messages.length && line.trim()) {
      const last = messages[messages.length - 1]!;
      last.text = last.text ? `${last.text}\n${line}` : line;
    } else if (line.trim()) {
      skippedLines++;
    }
  }
  messages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  return { participants: [...participants], messages, skippedLines };
}

import type { Prisma } from '@prisma/client';

export const DEFAULT_TIME_ZONE = 'America/Argentina/Cordoba';

/** `{ timezone?, days: { mon: [["09:00", "18:00"]], ... } }` con días sun, mon, tue, wed, thu, fri, sat. */
export interface BusinessHours {
  timezone?: string;
  days: Record<string, [string, string][]>;
}

/** true/false según el horario de atención humana; null si no hay horario cargado. */
export function isWithinBusinessHours(hours: Prisma.JsonValue | null, now: Date, defaultTz = DEFAULT_TIME_ZONE): boolean | null {
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return null;
  const h = hours as unknown as BusinessHours;
  if (!h.days || typeof h.days !== 'object') return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: h.timezone ?? defaultTz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return null;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3);
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  const ranges = Array.isArray(h.days[day]) ? h.days[day] : [];
  return ranges.some((range) => {
    const from = toMinutes(range?.[0]);
    const to = toMinutes(range?.[1]);
    return from !== null && to !== null && minute >= from && minute < to;
  });
}

/** "9:00" o "09:00" → minutos desde la medianoche; null si no es una hora válida. */
export function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total <= 24 * 60 ? total : null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: h.timezone ?? defaultTz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3);
  const time = `${get('hour')}:${get('minute')}`;
  return (h.days[day] ?? []).some(([from, to]) => time >= from && time < to);
}

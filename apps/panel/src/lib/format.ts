const TZ = 'America/Argentina/Cordoba';

export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'sin dato';
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(Number(value));
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(value));
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

export function contactName(c: { name?: string | null; pushName?: string | null; phone?: string | null } | null | undefined) {
  return c?.name || c?.pushName || c?.phone || 'Sin nombre';
}

export const CONVERSATION_STATUS: Record<string, string> = {
  AI_ACTIVE: 'IA atendiendo',
  HUMAN_REQUESTED: 'Pide persona',
  HUMAN_ACTIVE: 'Persona atendiendo',
  AI_PAUSED: 'IA pausada',
  RESOLVED: 'Resuelta',
};

export const BUYER_TYPE: Record<string, string> = {
  UNKNOWN: 'Sin definir',
  RETAIL: 'Minorista',
  WHOLESALE: 'Mayorista',
  EVENT: 'Eventos',
};

export const ORDER_STATUS: Record<string, string> = {
  PENDING_REVIEW: 'A revisar',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
  FULFILLED: 'Entregado',
};

export const LEAD_STATUS: Record<string, string> = {
  NEW: 'Nuevo',
  QUOTING: 'Para cotizar',
  QUOTED: 'Cotizado',
  WON: 'Ganado',
  LOST: 'Perdido',
};

export const SERVICE: Record<string, string> = { GLITTER_BAR: 'Glitter Bar', SHIMMER_WALL: 'Shimmer Wall' };

export const FOLLOWUP_STATUS: Record<string, string> = { PENDING: 'Pendiente', DONE: 'Hecho', CANCELLED: 'Cancelado' };

import type { Channel } from '@prisma/client';

export function channelOf(jid: string): Channel {
  if (jid.startsWith('ig:')) return 'INSTAGRAM';
  if (jid.startsWith('fb:')) return 'MESSENGER';
  return 'WHATSAPP';
}

export function whatsappDigits(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.hostname !== 'wa.me') return null;
    const digits = url.pathname.slice(1);
    return /^\d+$/.test(digits) ? digits : null;
  } catch {
    return null;
  }
}

export function whatsappTarget(link: string): string {
  const digits = whatsappDigits(link);
  if (!digits) return link;
  const number = digits.startsWith('549') ? `+54 9 ${digits.slice(3)}` : `+${digits}`;
  return `${number} ${link}`;
}

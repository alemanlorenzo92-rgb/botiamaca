import type { Channel } from '@prisma/client';

export function channelOf(jid: string): Channel {
  if (jid.startsWith('ig:')) return 'INSTAGRAM';
  if (jid.startsWith('fb:')) return 'MESSENGER';
  return 'WHATSAPP';
}

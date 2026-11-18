export interface Me {
  id: string;
  email: string;
  name: string;
  role: { code: string; name: string };
  permissions: string[];
}

export interface Contact {
  id: string;
  waJid: string;
  channel: 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
  phone: string | null;
  name: string | null;
  pushName: string | null;
  buyerType: string;
  interests: string[];
  notes: string | null;
  memorySummary: string | null;
  marketingConsent: boolean;
  botMuted: boolean;
  lastMessageAt: string | null;
  conversation?: { id: string; status: string } | null;
}

export interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  author: 'CUSTOMER' | 'AI' | 'HUMAN' | 'SYSTEM';
  type: string;
  text: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  sentByUser?: { id: string; name: string } | null;
}

export interface Conversation {
  id: string;
  status: string;
  unreadCount: number;
  humanRequestReason: string | null;
  updatedAt: string;
  contact: Contact;
  assignedUser: { id: string; name: string } | null;
  lastMessage?: Message | null;
}

export type BusEvent =
  | { type: 'message.created'; conversationId: string; messageId: string }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'whatsapp.status'; status: string; qr?: string | null }
  | { type: 'followup.due'; followupId: string }
  | { type: 'human.requested'; conversationId: string; reason: string | null };

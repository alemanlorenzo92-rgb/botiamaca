'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { BUYER_TYPE, CONVERSATION_STATUS, contactName, dateTime } from '@/lib/format';
import { useLiveEvents } from '@/lib/session';
import type { Conversation, Message } from '@/lib/types';

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'Todas' },
  { key: 'HUMAN_REQUESTED', label: 'Piden persona' },
  { key: 'HUMAN_ACTIVE', label: 'Persona atendiendo' },
  { key: 'AI_ACTIVE', label: 'IA atendiendo' },
  { key: 'AI_PAUSED', label: 'IA pausada' },
  { key: 'RESOLVED', label: 'Resueltas' },
];

const AUTHOR: Record<string, string> = { CUSTOMER: 'Cliente', AI: 'IA', HUMAN: 'Persona', SYSTEM: 'Sistema' };

function ConversationList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Conversation[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ conversations: Conversation[] }>(`/conversations${qs({ status: filter, q })}`);
    setItems(r.conversations);
  }, [filter, q]);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  useLiveEvents(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load().catch(() => {}), 400);
  });

  return (
    <div className="conv-list">
      <div style={{ padding: 12 }} className="stack">
        <input placeholder="Buscar por nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {items.length === 0 && <p className="muted" style={{ padding: 12 }}>No hay conversaciones.</p>}
      {items.map((c) => (
        <div key={c.id} className={`conv-item ${c.id === selected ? 'active' : ''}`} onClick={() => onSelect(c.id)}>
          <div className="row between">
            <span>
              <strong>{contactName(c.contact)}</strong>
              {c.contact.channel !== 'WHATSAPP' && <span className="muted small"> · {c.contact.channel === 'INSTAGRAM' ? 'Instagram' : 'Facebook'}</span>}
            </span>
            {c.unreadCount > 0 && <span className="unread">{c.unreadCount}</span>}
          </div>
          <div className="row between">
            <span className={`badge ${c.status}`}>{CONVERSATION_STATUS[c.status]}</span>
            <span className="muted small">{dateTime(c.lastMessage?.createdAt ?? c.updatedAt)}</span>
          </div>
          <div className="preview">{c.lastMessage?.text ?? (c.lastMessage ? `[${c.lastMessage.type}]` : '')}</div>
        </div>
      ))}
    </div>
  );
}

function ChatView({ id }: { id: string }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}`);
    setConversation(r.conversation);
    setMessages(r.messages);
    if (r.conversation.unreadCount > 0) void api(`/conversations/${id}/read`, { body: {} }).catch(() => {});
  }, [id]);

  useEffect(() => {
    setConversation(null);
    setMessages([]);
    setError(null);
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  useLiveEvents((e) => {
    if ('conversationId' in e && e.conversationId === id) void load().catch(() => {});
  });

  const action = async (name: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setError(null);
    try {
      await api(`/conversations/${id}/${name}`, { body: {} });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setBotMuted = async (botMuted: boolean) => {
    setError(null);
    try {
      await api(`/contacts/${conversation!.contact.id}`, { method: 'PATCH', body: { botMuted } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/conversations/${id}/messages`, { body: { text } });
      setText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!conversation) return <div className="chat center muted">{error ?? 'Cargando…'}</div>;
  const s = conversation.status;

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="row between">
          <div>
            <strong>{contactName(conversation.contact)}</strong>
            {conversation.contact.channel !== 'WHATSAPP' && <span className="muted small"> · {conversation.contact.channel === 'INSTAGRAM' ? 'Instagram' : 'Facebook'}</span>}{' '}
            <span className="muted small">
              {conversation.contact.phone ?? conversation.contact.waJid} · {BUYER_TYPE[conversation.contact.buyerType]}
            </span>
          </div>
          <span className={`badge ${s}`}>{CONVERSATION_STATUS[s]}</span>
        </div>
        {s === 'HUMAN_REQUESTED' && conversation.humanRequestReason && (
          <div className="small">Motivo: {conversation.humanRequestReason}</div>
        )}
        {conversation.assignedUser && <div className="small muted">Asignada a {conversation.assignedUser.name}</div>}
        <div className="row">
          {s !== 'HUMAN_ACTIVE' && <button onClick={() => action('take')}>Tomar conversación</button>}
          {s !== 'AI_ACTIVE' && (
            <button onClick={() => action('release', 'La IA va a volver a responder a este cliente. ¿Seguro?')}>
              Devolver a la IA
            </button>
          )}
          {s !== 'AI_PAUSED' && s !== 'RESOLVED' && <button onClick={() => action('pause')}>Pausar IA</button>}
          {s !== 'RESOLVED' && <button onClick={() => action('resolve')}>Resolver</button>}
          <button onClick={() => setBotMuted(!conversation.contact.botMuted)}>
            {conversation.contact.botMuted ? 'Dejar que el bot le responda' : 'Que el bot no le responda nunca'}
          </button>
        </div>
        {conversation.contact.botMuted && <div className="small muted">El bot nunca le responde a este contacto: lo atendés siempre vos.</div>}
      </div>
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.author} ${m.status}`}>
            {m.text ?? <em className="muted">[{m.type}]</em>}
            <div className="meta">
              {AUTHOR[m.author]}
              {m.sentByUser ? ` (${m.sentByUser.name})` : ''} · {dateTime(m.createdAt)}
              {m.status === 'FAILED' && ` · no enviado: ${m.error ?? ''}`}
              {m.status === 'DISCARDED' && ` · bloqueado: ${m.error ?? ''}`}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && <p className="error" style={{ padding: '0 12px' }}>{error}</p>}
      <div className="composer">
        <textarea
          placeholder={s === 'HUMAN_ACTIVE' ? 'Escribí tu respuesta…' : 'Al responder, tomás la conversación y la IA deja de contestar'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>
          Enviar
        </button>
      </div>
    </div>
  );
}

function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('c');
  return (
    <div className="inbox">
      <ConversationList selected={selected} onSelect={(id) => router.replace(`/inbox?c=${id}`)} />
      {selected ? <ChatView id={selected} /> : <div className="chat center muted">Elegí una conversación</div>}
    </div>
  );
}

export default function InboxPage() {
  return (
    <Shell>
      <Suspense>
        <Inbox />
      </Suspense>
    </Shell>
  );
}

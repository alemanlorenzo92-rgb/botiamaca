'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { BUYER_TYPE, LEAD_STATUS, ORDER_STATUS, SERVICE, contactName, dateTime, money } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Contact } from '@/lib/types';
import { useData } from '@/lib/use-data';

interface Detail {
  contact: Contact & {
    orders: { id: string; number: number; status: string; totalEstimate: string | null; createdAt: string }[];
    eventLeads: { id: string; service: string; status: string; createdAt: string }[];
    followups: { id: string; dueAt: string; reason: string; status: string }[];
  };
  cart: unknown;
}

function ContactDetail({ id, onSaved }: { id: string; onSaved: () => void }) {
  const { can } = useSession();
  const { data, reload } = useData<Detail>(`/contacts/${id}`);
  const [form, setForm] = useState({ name: '', buyerType: 'UNKNOWN', interests: '', notes: '', memorySummary: '' });
  const [follow, setFollow] = useState({ dueAt: '', reason: '' });
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const c = data.contact;
    setForm({
      name: c.name ?? '',
      buyerType: c.buyerType,
      interests: c.interests.join(', '),
      notes: c.notes ?? '',
      memorySummary: c.memorySummary ?? '',
    });
  }, [data]);

  if (!data) return <div className="card muted">Cargando…</div>;
  const c = data.contact;

  const save = async () => {
    setMsg(null);
    try {
      await api(`/contacts/${id}`, {
        method: 'PATCH',
        body: {
          name: form.name || null,
          buyerType: form.buyerType,
          interests: form.interests.split(',').map((s) => s.trim()).filter(Boolean),
          notes: form.notes || null,
          memorySummary: form.memorySummary || null,
        },
      });
      setMsg('Guardado');
      onSaved();
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const addFollowup = async () => {
    setMsg(null);
    try {
      await api('/followups', { body: { contactId: id, dueAt: new Date(follow.dueAt).toISOString(), reason: follow.reason } });
      setFollow({ dueAt: '', reason: '' });
      setMsg('Seguimiento agendado');
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card stack">
      <div className="row between">
        <h2>{contactName(c)}</h2>
        {c.conversation && <Link href={`/inbox?c=${c.conversation.id}`}>Abrir chat</Link>}
      </div>
      <div className="muted small">{c.phone ?? c.waJid}</div>
      <label>
        Nombre
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label>
        Tipo de comprador
        <select value={form.buyerType} onChange={(e) => setForm({ ...form, buyerType: e.target.value })}>
          {Object.entries(BUYER_TYPE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Intereses (separados por coma)
        <input value={form.interests} onChange={(e) => setForm({ ...form, interests: e.target.value })} />
      </label>
      <label>
        Notas internas
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>
      <label>
        Memoria de la IA
        <textarea rows={4} value={form.memorySummary} onChange={(e) => setForm({ ...form, memorySummary: e.target.value })} />
      </label>
      <div className="row">
        <button className="primary" onClick={save}>
          Guardar
        </button>
        {msg && <span className="small">{msg}</span>}
      </div>

      {can('orders') && c.orders.length > 0 && (
        <>
          <h3>Pedidos</h3>
          {c.orders.map((o) => (
            <div key={o.id} className="small">
              #{o.number} · {ORDER_STATUS[o.status]} · {money(o.totalEstimate)} · {dateTime(o.createdAt)}
            </div>
          ))}
        </>
      )}
      {can('leads') && c.eventLeads.length > 0 && (
        <>
          <h3>Eventos</h3>
          {c.eventLeads.map((l) => (
            <div key={l.id} className="small">
              {SERVICE[l.service]} · {LEAD_STATUS[l.status]} · {dateTime(l.createdAt)}
            </div>
          ))}
        </>
      )}
      {can('followups') && (
        <>
          <h3>Seguimientos</h3>
          {c.followups.map((f) => (
            <div key={f.id} className="small">
              {dateTime(f.dueAt)} · {f.reason} · {f.status}
            </div>
          ))}
          <div className="row">
            <input type="datetime-local" value={follow.dueAt} onChange={(e) => setFollow({ ...follow, dueAt: e.target.value })} />
            <input placeholder="Motivo" value={follow.reason} onChange={(e) => setFollow({ ...follow, reason: e.target.value })} />
            <button disabled={!follow.dueAt || !follow.reason} onClick={addFollowup}>
              Agendar
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Contacts() {
  const [q, setQ] = useState('');
  const [buyerType, setBuyerType] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, reload } = useData<{ contacts: Contact[]; total: number }>(`/contacts${qs({ q, buyerType, limit: 100 })}`);

  return (
    <div className="split">
      <div className="stack">
        <h1>Contactos</h1>
        <div className="row">
          <input style={{ maxWidth: 280 }} placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ maxWidth: 180 }} value={buyerType} onChange={(e) => setBuyerType(e.target.value)}>
            <option value="">Todos los tipos</option>
            {Object.entries(BUYER_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <span className="muted small">{data?.total ?? 0} contactos</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Tipo</th>
              <th>Último mensaje</th>
            </tr>
          </thead>
          <tbody>
            {data?.contacts.map((c) => (
              <tr key={c.id} className={`clickable ${selected === c.id ? 'selected' : ''}`} onClick={() => setSelected(c.id)}>
                <td>{contactName(c)}</td>
                <td>{c.phone ?? '—'}</td>
                <td>{BUYER_TYPE[c.buyerType]}</td>
                <td>{dateTime(c.lastMessageAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? <ContactDetail key={selected} id={selected} onSaved={reload} /> : <div className="card muted">Elegí un contacto</div>}
    </div>
  );
}

export default function ContactsPage() {
  return (
    <Shell>
      <Contacts />
    </Shell>
  );
}

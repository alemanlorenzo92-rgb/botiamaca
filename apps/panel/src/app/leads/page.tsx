'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { LEAD_STATUS, SERVICE, contactName, date, dateTime, money } from '@/lib/format';
import { useData } from '@/lib/use-data';

interface Lead {
  id: string;
  service: string;
  status: string;
  customerName: string | null;
  eventDate: string | null;
  eventDateText: string | null;
  location: string | null;
  eventType: string | null;
  guests: number | null;
  startTime: string | null;
  duration: string | null;
  servicesRequested: string | null;
  measures: string | null;
  colorStyle: string | null;
  rentalDuration: string | null;
  extraInfo: string | null;
  quoteAmount: string | null;
  quoteNotes: string | null;
  createdAt: string;
  missingFields: string[];
  contact: { id: string; name: string | null; pushName: string | null; phone: string | null };
}

const FIELDS: [keyof Lead, string][] = [
  ['customerName', 'Nombre'],
  ['eventType', 'Tipo de evento'],
  ['location', 'Lugar'],
  ['guests', 'Invitados'],
  ['startTime', 'Hora'],
  ['duration', 'Duración'],
  ['servicesRequested', 'Servicios'],
  ['measures', 'Medidas'],
  ['colorStyle', 'Color / estilo'],
  ['rentalDuration', 'Tiempo de alquiler'],
  ['extraInfo', 'Otros datos'],
];

function LeadCard({ lead, onChange }: { lead: Lead; onChange: () => void }) {
  const [amount, setAmount] = useState(lead.quoteAmount ?? '');
  const [notes, setNotes] = useState(lead.quoteNotes ?? '');
  const update = async (body: Record<string, unknown>) => {
    await api(`/leads/${lead.id}`, { method: 'PATCH', body });
    onChange();
  };
  return (
    <div className="card stack">
      <div className="row between">
        <strong>
          {SERVICE[lead.service]} · {contactName(lead.contact)}
        </strong>
        <span className="badge">{LEAD_STATUS[lead.status]}</span>
      </div>
      <div className="small">
        Fecha: {lead.eventDate ? date(lead.eventDate) : (lead.eventDateText ?? '—')} · recibido {dateTime(lead.createdAt)}
      </div>
      {FIELDS.filter(([k]) => lead[k] !== null && lead[k] !== '').map(([k, label]) => (
        <div key={k} className="small">
          <span className="muted">{label}:</span> {String(lead[k])}
        </div>
      ))}
      {lead.missingFields.length > 0 && <div className="badge warn">Faltan datos: {lead.missingFields.join(', ')}</div>}
      <div className="row">
        <input type="number" placeholder="Monto cotizado" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 160 }} />
        <input placeholder="Notas de la cotización" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button onClick={() => update({ quoteAmount: amount === '' ? null : Number(amount), quoteNotes: notes || null, status: 'QUOTED' })}>
          Guardar cotización
        </button>
      </div>
      {lead.quoteAmount && <div className="small">Cotizado: {money(lead.quoteAmount)}</div>}
      <div className="row">
        <button onClick={() => update({ status: 'WON' })}>Ganado</button>
        <button className="danger" onClick={() => update({ status: 'LOST' })}>
          Perdido
        </button>
      </div>
    </div>
  );
}

function Leads() {
  const [service, setService] = useState('');
  const [status, setStatus] = useState('');
  const { data, reload } = useData<{ leads: Lead[]; total: number }>(`/leads${qs({ service, status, limit: 100 })}`);
  return (
    <div className="stack">
      <h1>Consultas de eventos</h1>
      <p className="muted small">La IA junta los datos; el precio lo define el equipo.</p>
      <div className="row">
        <select style={{ maxWidth: 200 }} value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">Todos los servicios</option>
          {Object.entries(SERVICE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select style={{ maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          {Object.entries(LEAD_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="grid2">
        {data?.leads.map((l) => <LeadCard key={l.id} lead={l} onChange={reload} />)}
      </div>
      {data && data.total === 0 && <p className="muted">No hay consultas.</p>}
    </div>
  );
}

export default function LeadsPage() {
  return (
    <Shell>
      <Leads />
    </Shell>
  );
}

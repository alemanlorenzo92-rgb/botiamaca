'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { FOLLOWUP_STATUS, contactName, dateTime } from '@/lib/format';
import { useLiveEvents } from '@/lib/session';
import { useData } from '@/lib/use-data';

interface Followup {
  id: string;
  dueAt: string;
  reason: string;
  status: string;
  createdBy: string;
  notifiedAt: string | null;
  contact: { id: string; name: string | null; pushName: string | null; phone: string | null };
  assignedUser: { id: string; name: string } | null;
}

function Followups() {
  const [status, setStatus] = useState('PENDING');
  const { data, reload } = useData<{ followups: Followup[]; total: number }>(`/followups${qs({ status, limit: 200 })}`);
  useLiveEvents((e) => {
    if (e.type === 'followup.due') void reload();
  });
  const update = async (id: string, body: Record<string, unknown>) => {
    await api(`/followups/${id}`, { method: 'PATCH', body });
    await reload();
  };
  const now = Date.now();
  return (
    <div className="stack">
      <h1>Seguimientos</h1>
      <p className="muted small">Los seguimientos avisan al equipo; el bot no le escribe solo al cliente. Se agendan desde Contactos.</p>
      <div className="tabs">
        {Object.entries(FOLLOWUP_STATUS).map(([k, v]) => (
          <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>
            {v}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>Vence</th>
            <th>Cliente</th>
            <th>Motivo</th>
            <th>Origen</th>
            <th>Asignado</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.followups.map((f) => (
            <tr key={f.id}>
              <td>
                {dateTime(f.dueAt)} {f.status === 'PENDING' && new Date(f.dueAt).getTime() < now && <span className="badge warn">vencido</span>}
              </td>
              <td>
                <Link href="/contacts">{contactName(f.contact)}</Link>
              </td>
              <td>{f.reason}</td>
              <td>{f.createdBy === 'AI' ? 'IA' : 'Equipo'}</td>
              <td>{f.assignedUser?.name ?? '—'}</td>
              <td>
                {f.status === 'PENDING' && (
                  <div className="row">
                    <button onClick={() => update(f.id, { status: 'DONE' })}>Hecho</button>
                    <button className="danger" onClick={() => update(f.id, { status: 'CANCELLED' })}>
                      Cancelar
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.total === 0 && <p className="muted">No hay seguimientos.</p>}
    </div>
  );
}

export default function FollowupsPage() {
  return (
    <Shell>
      <Followups />
    </Shell>
  );
}

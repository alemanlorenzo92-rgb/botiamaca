'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { qs } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useData } from '@/lib/use-data';

interface Entry {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
  ip: string | null;
  createdAt: string;
}

interface Run {
  id: string;
  conversationId: string;
  model: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls: { name: string; ok: boolean }[];
  error: string | null;
  createdAt: string;
}

function Audit() {
  const [tab, setTab] = useState<'audit' | 'ai'>('audit');
  const [action, setAction] = useState('');
  const audit = useData<{ entries: Entry[] }>(tab === 'audit' ? `/audit${qs({ action, limit: 200 })}` : null);
  const runs = useData<{ runs: Run[] }>(tab === 'ai' ? '/ai-runs?limit=100' : null);
  return (
    <div className="stack">
      <h1>Auditoría</h1>
      <div className="tabs">
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          Acciones
        </button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
          Corridas de IA
        </button>
      </div>
      {tab === 'audit' && (
        <>
          <input style={{ maxWidth: 280 }} placeholder="Filtrar por acción (ej. conversation)" value={action} onChange={(e) => setAction(e.target.value)} />
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Actor</th>
                <th>Acción</th>
                <th>Entidad</th>
                <th>Datos</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.entries.map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.createdAt)}</td>
                  <td>{e.actorType}</td>
                  <td>{e.action}</td>
                  <td className="small">{e.entityType ? `${e.entityType} ${e.entityId?.slice(0, 8) ?? ''}` : '—'}</td>
                  <td>{e.data && Object.keys(e.data as object).length ? <pre>{JSON.stringify(e.data)}</pre> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {tab === 'ai' && (
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Estado</th>
              <th>Modelo</th>
              <th>Tokens (entrada/salida)</th>
              <th>Latencia</th>
              <th>Herramientas</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.data?.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={`/inbox?c=${r.conversationId}`}>{dateTime(r.createdAt)}</a>
                </td>
                <td>{r.status}</td>
                <td>{r.model}</td>
                <td>
                  {r.inputTokens} / {r.outputTokens}
                </td>
                <td>{(r.latencyMs / 1000).toFixed(1)} s</td>
                <td className="small">{r.toolCalls.map((t) => `${t.name}${t.ok ? '' : ' (error)'}`).join(', ') || '—'}</td>
                <td className="error small">{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AuditPage() {
  return (
    <Shell>
      <Audit />
    </Shell>
  );
}

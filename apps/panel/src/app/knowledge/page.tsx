'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, ApiError, qs, upload } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useData } from '@/lib/use-data';

const KINDS: Record<string, string> = {
  STYLE: 'Tono y estilo',
  FAQ: 'Pregunta frecuente',
  PRODUCT: 'Producto',
  SERVICE: 'Servicio',
  POLICY: 'Política (envíos, pagos, mayorista)',
  OBJECTION: 'Objeción',
  SALES_PROCESS: 'Proceso de venta',
  OTHER: 'Otro',
};
const STATUS: Record<string, string> = { PENDING: 'Para revisar', CONFLICT: 'En conflicto', APPROVED: 'Aprobado', DISABLED: 'Desactivado', REJECTED: 'Rechazado' };

interface Doc {
  id: string;
  kind: string;
  title: string;
  content: string;
  status: string;
  confidence: number;
  temporal: boolean;
  version: number;
  conflictNote: string | null;
  conflictWith: { id: string; title: string; content: string; status: string } | null;
  sources: { id: string; excerpt: string; chat: { fileName: string } | null }[];
  _count: { sources: number };
}
interface ImportRow {
  id: string;
  fileName: string;
  participants: string[];
  messageCount: number;
  mediaCount: number;
  status: string;
  error: string | null;
  createdAt: string;
  _count: { sources: number; chunks: number };
}
interface Preview {
  participants: string[];
  messagesByParticipant: Record<string, number>;
  messageCount: number;
  mediaFiles: number;
}

function DocCard({ d, reload }: { d: Doc; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ title: d.title, content: d.content, kind: d.kind, temporal: d.temporal });
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const status = (s: string) => act(() => api(`/knowledge/${d.id}/status`, { body: { status: s } }));
  return (
    <div className="card kdoc">
      <div className="row between">
        <div className="row">
          <span className={`badge ${d.status}`}>{STATUS[d.status]}</span>
          <span className="badge">{KINDS[d.kind]}</span>
          {d.temporal && <span className="badge warn">puede cambiar</span>}
          <span className="muted small">confianza {Math.round(d.confidence * 100)}% · {d._count.sources} fuentes · v{d.version}</span>
        </div>
      </div>
      {editing ? (
        <>
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <textarea rows={4} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
          <div className="row">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} style={{ maxWidth: 260 }}>
              {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={f.temporal} onChange={(e) => setF({ ...f, temporal: e.target.checked })} /> Dato que puede cambiar</label>
          </div>
        </>
      ) : (
        <>
          <strong>{d.title}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{d.content}</div>
        </>
      )}
      {d.conflictWith && (
        <div className="source">
          Contradice a: <strong>{d.conflictWith.title}</strong> ({STATUS[d.conflictWith.status]}) — {d.conflictWith.content}
          {d.conflictNote && <div>Motivo: {d.conflictNote}</div>}
          <div>Si aprobás este, el anterior se desactiva.</div>
        </div>
      )}
      {d.sources.map((s) => (
        <div key={s.id} className="source">“{s.excerpt}” {s.chat ? `— ${s.chat.fileName}` : ''}</div>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="row">
        {editing ? (
          <>
            <button className="primary" onClick={() => act(async () => { await api(`/knowledge/${d.id}`, { method: 'PATCH', body: f }); setEditing(false); })}>Guardar</button>
            <button onClick={() => setEditing(false)}>Cancelar</button>
          </>
        ) : (
          <>
            {d.status !== 'APPROVED' && <button className="primary" onClick={() => status('APPROVED')}>Aprobar</button>}
            <button onClick={() => setEditing(true)}>Editar</button>
            {d.status === 'APPROVED' && <button onClick={() => status('DISABLED')}>Desactivar</button>}
            {d.status !== 'REJECTED' && d.status !== 'APPROVED' && <button className="danger" onClick={() => status('REJECTED')}>Rechazar</button>}
          </>
        )}
      </div>
    </div>
  );
}

function Documents() {
  const [status, setStatus] = useState('PENDING');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const docs = useData<{ documents: Doc[]; counts: Record<string, number> }>(`/knowledge${qs({ status, kind, q })}`);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ kind: 'FAQ', title: '', content: '' });
  const add = async () => {
    await api('/knowledge', { body: f });
    setF({ kind: 'FAQ', title: '', content: '' });
    setAdding(false);
    void docs.reload();
  };
  return (
    <div className="stack">
      <div className="tabs">
        {Object.entries(STATUS).map(([k, v]) => (
          <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>
            {v} ({docs.data?.counts[k] ?? 0})
          </button>
        ))}
      </div>
      <div className="row">
        <input placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">Todos los tipos</option>
          {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button onClick={() => setAdding(!adding)}>+ Escribir conocimiento</button>
      </div>
      {adding && (
        <div className="card stack">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input placeholder="Título" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <textarea rows={4} placeholder="Qué tiene que saber o hacer la vendedora" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
          <div className="row"><button className="primary" disabled={!f.title || !f.content} onClick={add}>Guardar (queda aprobado)</button></div>
        </div>
      )}
      {docs.error && <p className="error">{docs.error}</p>}
      {docs.data && !docs.data.documents.length && <p className="muted">No hay nada en esta sección.</p>}
      {docs.data?.documents.map((d) => <DocCard key={`${d.id}-${d.version}-${d.status}`} d={d} reload={() => void docs.reload()} />)}
    </div>
  );
}

function Imports() {
  const list = useData<{ imports: ImportRow[] }>('/imports');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [owner, setOwner] = useState('');
  const [consent, setConsent] = useState(false);
  const [mediaConsent, setMediaConsent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setMsg(null);
    if (!f) return;
    try {
      const p = await upload<Preview>('/imports/preview', f);
      setPreview(p);
      setOwner(Object.entries(p.messagesByParticipant).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const send = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await upload<{ duplicate: boolean; inserted: number; skipped: number; mediaImported: number; mediaErrors: string[] }>('/imports', file, {
        ownerName: owner,
        consent: String(consent),
        mediaConsent: String(mediaConsent),
      });
      setMsg(
        r.duplicate
          ? 'Este chat ya estaba importado.'
          : `Importado: ${r.inserted} mensajes nuevos (${r.skipped} ya estaban), ${r.mediaImported} archivos. Se está analizando; el conocimiento aparece en "Para revisar".${r.mediaErrors.length ? ` Archivos no válidos: ${r.mediaErrors.length}.` : ''}`,
      );
      setFile(null);
      setPreview(null);
      void list.reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (row: ImportRow) => {
    if (!confirm(`¿Borrar "${row.fileName}", sus mensajes, archivos y el conocimiento que salió solo de este chat?`)) return;
    await api(`/imports/${row.id}`, { method: 'DELETE' });
    void list.reload();
  };
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Importar un chat de WhatsApp</h2>
        <p className="muted small">
          En WhatsApp: abrí el chat → ⋮ → Más → Exportar chat (con o sin archivos). Subí el .txt o el .zip. Los nombres, teléfonos, emails y CBU se reemplazan antes de guardarse.
        </p>
        <input type="file" accept=".txt,.zip,text/plain,application/zip" onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
        {preview && (
          <>
            <p className="small">{preview.messageCount} mensajes · {preview.mediaFiles} archivos adjuntos</p>
            <label>
              ¿Quién sos vos (la dueña) en este chat?
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                {preview.participants.map((p) => <option key={p} value={p}>{p} ({preview.messagesByParticipant[p]} mensajes)</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Autorizo usar este chat para que la IA aprenda</label>
            <label className="check"><input type="checkbox" checked={mediaConsent} onChange={(e) => setMediaConsent(e.target.checked)} /> Guardar las fotos y videos del chat en la biblioteca (quedan desactivados hasta que los revise)</label>
            <div className="row"><button className="primary" disabled={!consent || !owner || busy} onClick={send}>{busy ? 'Importando…' : 'Importar'}</button></div>
          </>
        )}
        {msg && <p className="small">{msg}</p>}
      </div>
      {list.error && <p className="error">{list.error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Archivo</th><th>Estado</th><th>Mensajes</th><th>Aprendido</th><th /></tr>
          </thead>
          <tbody>
            {list.data?.imports.map((r) => (
              <tr key={r.id}>
                <td>{r.fileName}<div className="muted small">{dateTime(r.createdAt)} · {r.participants.join(', ')}</div></td>
                <td><span className={`badge ${r.status}`}>{r.status}</span>{r.error && <div className="error small">{r.error}</div>}</td>
                <td>{r.messageCount}{r.mediaCount ? ` · ${r.mediaCount} archivos` : ''}</td>
                <td className="small">{r._count.sources} fuentes · {r._count.chunks} ejemplos</td>
                <td className="actions">
                  {(r.status === 'FAILED' || r.status === 'DONE') && (
                    <button onClick={async () => { await api(`/imports/${r.id}/reprocess`, { body: {} }); void list.reload(); }}>Reprocesar</button>
                  )}
                  <button className="danger" onClick={() => remove(r)}>Borrar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Tester() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ documents: { id: string; title: string; content: string; similarity: number }[]; examples: { id: string; text: string }[] } | null>(null);
  return (
    <div className="card stack">
      <h2>Probar qué usaría la IA</h2>
      <div className="row">
        <input placeholder="Ej: hacen envíos a Córdoba?" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 360 }} />
        <button disabled={!query} onClick={async () => setResult(await api('/knowledge/search', { body: { query } }))}>Buscar</button>
      </div>
      {result && !result.documents.length && !result.examples.length && <p className="muted">No encontró conocimiento aprobado relevante.</p>}
      {result?.documents.map((d) => <div key={d.id} className="source"><strong>{d.title}</strong> ({Math.round(d.similarity * 100)}%) — {d.content}</div>)}
      {result?.examples.map((e) => <div key={e.id} className="source">{e.text}</div>)}
    </div>
  );
}

function Knowledge() {
  const [tab, setTab] = useState<'docs' | 'imports' | 'test'>('docs');
  return (
    <div className="stack">
      <h1>Centro de conocimiento</h1>
      <p className="muted small">La IA solo usa lo aprobado. Lo que aprende de los chats queda para que lo revises antes.</p>
      <div className="tabs">
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>Conocimiento</button>
        <button className={tab === 'imports' ? 'active' : ''} onClick={() => setTab('imports')}>Chats importados</button>
        <button className={tab === 'test' ? 'active' : ''} onClick={() => setTab('test')}>Probar</button>
      </div>
      {tab === 'docs' && <Documents />}
      {tab === 'imports' && <Imports />}
      {tab === 'test' && <Tester />}
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <Knowledge />
    </Shell>
  );
}

'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs, upload } from '@/lib/api';
import { useData } from '@/lib/use-data';

interface Asset {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  title: string;
  description: string;
  tags: string[];
  active: boolean;
  isTutorial: boolean;
  source: 'UPLOAD' | 'IMPORT';
  size: number;
  service: string | null;
  product: { id: string; name: string } | null;
}
interface Tutorial {
  id: string;
  title: string;
  content: string;
  active: boolean;
  service: string | null;
  product: { id: string; name: string } | null;
  media: { id: string; kind: string; title: string }[];
}
type ProductOption = { id: string; name: string };

const SERVICES: Record<string, string> = { GLITTER_BAR: 'Glitter Bar', SHIMMER_WALL: 'Shimmer Walls' };

function Uploader({ products, onDone }: { products: ProductOption[]; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [f, setF] = useState({ title: '', tags: '', productId: '', service: '', isTutorial: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const results: string[] = [];
    for (const file of files) {
      try {
        const r = await upload<{ duplicate: boolean }>('/media', file, { ...f, isTutorial: String(f.isTutorial), title: f.title || file.name });
        results.push(`${file.name}: ${r.duplicate ? 'ya estaba cargado' : 'subido'}`);
      } catch (e) {
        results.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setMsg(results.join(' · '));
    setFiles([]);
    setBusy(false);
    onDone();
  };
  return (
    <div className="card stack">
      <h2>Subir fotos o videos</h2>
      <p className="muted small">JPG, PNG, WEBP, MP4 o 3GP. La IA solo envía lo que esté activo acá.</p>
      <input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      <div className="grid2">
        <label>Título<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ej: Glitter dorado en rostro" /></label>
        <label>Etiquetas<input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="dorado, fiesta, rostro" /></label>
        <label>
          Producto
          <select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
            <option value="">—</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Servicio
          <select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}>
            <option value="">—</option>
            {Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={f.isTutorial} onChange={(e) => setF({ ...f, isTutorial: e.target.checked })} /> Es un tutorial</label>
      <div className="row">
        <button className="primary" disabled={!files.length || busy} onClick={send}>{busy ? 'Subiendo…' : `Subir ${files.length || ''}`}</button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

function AssetCard({ a, products, reload }: { a: Asset; products: ProductOption[]; reload: () => void }) {
  const patch = async (body: Record<string, unknown>) => {
    await api(`/media/${a.id}`, { method: 'PATCH', body });
    reload();
  };
  const remove = async () => {
    if (!confirm('¿Borrar este archivo?')) return;
    await api(`/media/${a.id}`, { method: 'DELETE' });
    reload();
  };
  const src = `/api/media/${a.id}/file`;
  return (
    <div className={a.active ? 'card media-card' : 'card media-card off'}>
      {a.kind === 'IMAGE' ? <img src={src} alt={a.title} loading="lazy" /> : <video src={src} controls preload="metadata" />}
      <input defaultValue={a.title} onBlur={(e) => e.target.value !== a.title && void patch({ title: e.target.value })} aria-label="Título" />
      <input defaultValue={a.tags.join(', ')} placeholder="etiquetas" onBlur={(e) => void patch({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} aria-label="Etiquetas" />
      <select value={a.product?.id ?? ''} onChange={(e) => void patch({ productId: e.target.value || null })} aria-label="Producto">
        <option value="">Sin producto</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select value={a.service ?? ''} onChange={(e) => void patch({ service: e.target.value || null })} aria-label="Servicio">
        <option value="">Sin servicio</option>
        {Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <div className="small muted">
        {a.kind === 'IMAGE' ? 'Foto' : 'Video'} · {(a.size / 1024 / 1024).toFixed(1)} MB{a.source === 'IMPORT' ? ' · de un chat importado' : ''}
        {a.isTutorial ? ' · tutorial' : ''}
      </div>
      <div className="row">
        <button className={a.active ? '' : 'primary'} onClick={() => void patch({ active: !a.active })}>{a.active ? 'Desactivar' : 'Activar'}</button>
        <button className="danger" onClick={remove}>Borrar</button>
      </div>
    </div>
  );
}

function Tutorials({ assets, products }: { assets: Asset[]; products: ProductOption[] }) {
  const list = useData<{ tutorials: Tutorial[] }>('/tutorials');
  const [f, setF] = useState({ title: '', content: '', productId: '', service: '', mediaIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api('/tutorials', { body: { ...f, productId: f.productId || null, service: f.service || null } });
      setF({ title: '', content: '', productId: '', service: '', mediaIds: [] });
      void list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Nuevo tutorial</h2>
        <label>Título<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label>Paso a paso<textarea rows={5} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></label>
        <div className="grid2">
          <label>
            Producto
            <select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
              <option value="">—</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            Videos o fotos
            <select multiple value={f.mediaIds} onChange={(e) => setF({ ...f, mediaIds: [...e.target.selectedOptions].map((o) => o.value) })}>
              {assets.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row"><button className="primary" disabled={!f.title.trim()} onClick={save}>Guardar tutorial</button></div>
      </div>
      {list.data?.tutorials.map((t) => (
        <div key={t.id} className="card stack">
          <div className="row between">
            <strong>{t.title}</strong>
            <button className="danger" onClick={async () => { if (confirm('¿Borrar tutorial?')) { await api(`/tutorials/${t.id}`, { method: 'DELETE' }); void list.reload(); } }}>Borrar</button>
          </div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.content}</div>
          <div className="muted small">{t.product?.name ?? (t.service ? SERVICES[t.service] : '')} · {t.media.length} archivos</div>
        </div>
      ))}
    </div>
  );
}

function Library() {
  const [tab, setTab] = useState<'media' | 'tutorials'>('media');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [active, setActive] = useState('');
  const media = useData<{ media: Asset[] }>(`/media${qs({ q, kind, active })}`);
  const products = useData<{ products: ProductOption[] }>('/catalog/products?limit=100');
  const productList = products.data?.products ?? [];
  return (
    <div className="stack">
      <h1>Fotos, videos y tutoriales</h1>
      <div className="tabs">
        <button className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>Biblioteca</button>
        <button className={tab === 'tutorials' ? 'active' : ''} onClick={() => setTab('tutorials')}>Tutoriales</button>
      </div>
      {tab === 'media' ? (
        <>
          <Uploader products={productList} onDone={() => void media.reload()} />
          <div className="row">
            <input placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 140 }}>
              <option value="">Todo</option>
              <option value="IMAGE">Fotos</option>
              <option value="VIDEO">Videos</option>
            </select>
            <select value={active} onChange={(e) => setActive(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="">Activos e inactivos</option>
              <option value="true">Activos</option>
              <option value="false">Para revisar / inactivos</option>
            </select>
          </div>
          {media.error && <p className="error">{media.error}</p>}
          {media.data && !media.data.media.length && <p className="muted">No hay archivos.</p>}
          <div className="media-grid">
            {media.data?.media.map((a) => <AssetCard key={a.id} a={a} products={productList} reload={() => void media.reload()} />)}
          </div>
        </>
      ) : (
        <Tutorials assets={media.data?.media ?? []} products={productList} />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <Library />
    </Shell>
  );
}

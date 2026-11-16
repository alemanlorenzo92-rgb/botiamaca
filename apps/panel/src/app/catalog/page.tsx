'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useData } from '@/lib/use-data';

interface Status {
  configured: boolean;
  webhooksConfigured: boolean;
  products: number;
  pendingWebhooks: number;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; error: string | null; stats: Record<string, number> } | null;
  lastOk: { startedAt: string } | null;
}

interface Product {
  id: string;
  name: string;
  url: string | null;
  published: boolean;
  syncedAt: string;
  variants: {
    id: string;
    values: string[];
    sku: string | null;
    inventory: { managed: boolean; quantity: number | null } | null;
    prices: { amount: string; priceList: { code: string } }[];
  }[];
}

function stock(v: Product['variants'][number]) {
  if (!v.inventory) return 'sin dato';
  if (!v.inventory.managed) return 'sin control';
  return String(v.inventory.quantity ?? 0);
}

function price(v: Product['variants'][number], code: string) {
  const p = v.prices.find((x) => x.priceList.code === code);
  return p ? money(p.amount) : '—';
}

function Catalog() {
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const status = useData<Status>('/catalog/status');
  const products = useData<{ products: Product[]; total: number }>(`/catalog/products${qs({ q, limit: 100 })}`);

  const sync = async () => {
    setMsg(null);
    try {
      await api('/catalog/sync', { body: {} });
      setMsg('Sincronización iniciada. Puede tardar unos minutos.');
      setTimeout(() => void status.reload(), 3000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const s = status.data;
  return (
    <div className="stack">
      <h1>Catálogo (Tiendanube)</h1>
      <div className="card stack">
        {s && !s.configured && (
          <p className="error">Tiendanube no está configurado: faltan TIENDANUBE_STORE_ID y TIENDANUBE_ACCESS_TOKEN.</p>
        )}
        {s && (
          <div className="grid2">
            <div>
              <div className="muted small">Productos sincronizados</div>
              <strong>{s.products}</strong>
            </div>
            <div>
              <div className="muted small">Última sincronización correcta</div>
              <strong>{dateTime(s.lastOk?.startedAt)}</strong>
            </div>
            <div>
              <div className="muted small">Última corrida</div>
              <strong>{s.lastRun ? `${s.lastRun.status} · ${dateTime(s.lastRun.startedAt)}` : '—'}</strong>
              {s.lastRun?.error && <div className="error small">{s.lastRun.error}</div>}
            </div>
            <div>
              <div className="muted small">Webhooks</div>
              <strong>{s.webhooksConfigured ? `activos · ${s.pendingWebhooks} pendientes` : 'sin configurar'}</strong>
            </div>
          </div>
        )}
        <div className="row">
          <button className="primary" disabled={!s?.configured} onClick={sync}>
            Sincronizar ahora
          </button>
          {msg && <span className="small">{msg}</span>}
        </div>
      </div>
      <input style={{ maxWidth: 320 }} placeholder="Buscar producto" value={q} onChange={(e) => setQ(e.target.value)} />
      <table>
        <thead>
          <tr>
            <th>Producto</th>
            <th>Variante</th>
            <th>SKU</th>
            <th>Minorista</th>
            <th>Mayorista</th>
            <th>Stock</th>
          </tr>
        </thead>
        <tbody>
          {products.data?.products.flatMap((p) =>
            p.variants.map((v, i) => (
              <tr key={v.id}>
                <td>
                  {i === 0 &&
                    (p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.name}
                      </a>
                    ) : (
                      p.name
                    ))}
                  {i === 0 && !p.published && <span className="badge warn">oculto</span>}
                </td>
                <td>{v.values.join(' / ') || 'Única'}</td>
                <td>{v.sku ?? '—'}</td>
                <td>{price(v, 'retail')}</td>
                <td>{price(v, 'wholesale')}</td>
                <td>{stock(v)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      {products.data && products.data.total === 0 && <p className="muted">No hay productos sincronizados.</p>}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <Shell>
      <Catalog />
    </Shell>
  );
}

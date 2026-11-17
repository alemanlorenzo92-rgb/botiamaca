'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { money } from '@/lib/format';
import { useData } from '@/lib/use-data';

interface Faq {
  q: string;
  a: string;
}
interface Category {
  id: string;
  name: string;
  description: string | null;
  visible: boolean;
  _count?: { products: number };
}
interface Variant {
  id: string;
  values: string[];
  sku: string | null;
  inventory: { managed: boolean; quantity: number | null } | null;
  prices: { amount: string; priceList: { code: string } }[];
}
interface Product {
  id: string;
  name: string;
  description: string | null;
  features: string | null;
  usage: string | null;
  recommendations: string | null;
  faqs: Faq[] | null;
  tags: string[];
  published: boolean;
  categories: { category: { id: string; name: string } }[];
  _count: { media: number };
  variants: Variant[];
}
interface Service {
  service: 'GLITTER_BAR' | 'SHIMMER_WALL';
  name: string;
  description: string;
  conditions: string;
  faqs: Faq[];
  active: boolean;
}

interface VariantForm {
  id?: string;
  values: string;
  retailPrice: string;
  wholesalePrice: string;
  stock: string;
}

const priceOf = (v: Variant, code: string) => v.prices.find((p) => p.priceList.code === code)?.amount ?? '';
const stockOf = (v: Variant) => (v.inventory?.quantity ?? null) === null ? '' : String(v.inventory!.quantity);
const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

function faqsToText(faqs: Faq[] | null | undefined) {
  return (faqs ?? []).map((f) => `${f.q}\n${f.a}`).join('\n\n');
}
function textToFaqs(text: string): Faq[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim().split('\n'))
    .filter((l) => l[0])
    .map(([q, ...a]) => ({ q: q!.trim(), a: a.join(' ').trim() }));
}

function ProductEditor({ product, categories, onDone }: { product: Product | null; categories: Category[]; onDone: () => void }) {
  const [f, setF] = useState({
    name: product?.name ?? '',
    description: product?.description ?? '',
    features: product?.features ?? '',
    usage: product?.usage ?? '',
    recommendations: product?.recommendations ?? '',
    faqs: faqsToText(product?.faqs),
    tags: product?.tags.join(', ') ?? '',
    published: product?.published ?? true,
    categoryIds: product?.categories.map((c) => c.category.id) ?? [],
  });
  const [variants, setVariants] = useState<VariantForm[]>(
    product?.variants.length
      ? product.variants.map((v) => ({ id: v.id, values: v.values.join(' / '), retailPrice: priceOf(v, 'retail'), wholesalePrice: priceOf(v, 'wholesale'), stock: stockOf(v) }))
      : [{ values: '', retailPrice: '', wholesalePrice: '', stock: '' }],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        ...f,
        tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        faqs: textToFaqs(f.faqs),
        variants: variants
          .filter((v) => v.values.trim() || v.retailPrice || v.wholesalePrice || v.stock || v.id)
          .map((v) => ({
            id: v.id ?? null,
            values: v.values.split('/').map((x) => x.trim()).filter(Boolean),
            retailPrice: num(v.retailPrice),
            wholesalePrice: num(v.wholesalePrice),
            stock: v.stock.trim() === '' ? null : Math.round(Number(v.stock)),
          })),
      };
      if (product) await api(`/catalog/products/${product.id}`, { method: 'PATCH', body });
      else await api('/catalog/products', { body });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card stack">
      <h2>{product ? 'Editar producto' : 'Nuevo producto'}</h2>
      <label>Nombre<input value={f.name} onChange={set('name')} /></label>
      <label>Descripción<textarea rows={3} value={f.description} onChange={set('description')} /></label>
      <div className="grid2">
        <label>Características<textarea rows={3} value={f.features} onChange={set('features')} /></label>
        <label>Cómo se usa<textarea rows={3} value={f.usage} onChange={set('usage')} /></label>
        <label>Recomendaciones<textarea rows={3} value={f.recommendations} onChange={set('recommendations')} /></label>
        <label>
          Preguntas frecuentes
          <textarea rows={3} value={f.faqs} onChange={set('faqs')} placeholder={'¿Es lavable?\nSí, sale con agua.\n\n(otra pregunta…)'} />
        </label>
      </div>
      <label>Etiquetas (separadas por coma)<input value={f.tags} onChange={set('tags')} /></label>
      <div className="row">
        {categories.map((c) => (
          <label key={c.id} className="check">
            <input
              type="checkbox"
              checked={f.categoryIds.includes(c.id)}
              onChange={(e) => setF({ ...f, categoryIds: e.target.checked ? [...f.categoryIds, c.id] : f.categoryIds.filter((x) => x !== c.id) })}
            />
            {c.name}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} /> Visible para la IA
        </label>
      </div>
      <h3>Variantes, precios y stock</h3>
      <p className="muted small">Dejá vacío lo que no tengas: la IA dirá que ese dato no está cargado y no lo inventa.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Variante (ej. Dorado / 10 g)</th>
              <th>Precio minorista</th>
              <th>Precio mayorista</th>
              <th>Stock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {variants.map((v, i) => {
              const upd = (k: keyof VariantForm) => (e: { target: { value: string } }) => setVariants(variants.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
              return (
                <tr key={i}>
                  <td><input value={v.values} onChange={upd('values')} placeholder="Única" /></td>
                  <td><input inputMode="decimal" value={v.retailPrice} onChange={upd('retailPrice')} placeholder="sin cargar" /></td>
                  <td><input inputMode="decimal" value={v.wholesalePrice} onChange={upd('wholesalePrice')} placeholder="sin cargar" /></td>
                  <td><input inputMode="numeric" value={v.stock} onChange={upd('stock')} placeholder="sin dato" /></td>
                  <td>
                    <button className="danger" onClick={() => setVariants(variants.filter((_, j) => j !== i))} aria-label="Quitar variante">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button onClick={() => setVariants([...variants, { values: '', retailPrice: '', wholesalePrice: '', stock: '' }])}>+ Variante</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" disabled={saving || !f.name.trim()} onClick={save}>Guardar</button>
        <button onClick={onDone}>Cancelar</button>
      </div>
    </div>
  );
}

function Products({ categories }: { categories: Category[] }) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const products = useData<{ products: Product[]; total: number }>(`/catalog/products${qs({ q, limit: 100 })}`);
  const remove = async (p: Product) => {
    if (!confirm(`¿Borrar "${p.name}"?`)) return;
    await api(`/catalog/products/${p.id}`, { method: 'DELETE' });
    void products.reload();
  };
  if (editing)
    return (
      <ProductEditor
        product={editing === 'new' ? null : editing}
        categories={categories}
        onDone={() => {
          setEditing(null);
          void products.reload();
        }}
      />
    );
  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Buscar producto" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <button className="primary" onClick={() => setEditing('new')}>+ Producto</button>
        <span className="muted small">{products.data?.total ?? 0} productos</span>
      </div>
      {products.error && <p className="error">{products.error}</p>}
      {products.data && !products.data.products.length && <p className="muted">Todavía no hay productos cargados.</p>}
      <div className="table-wrap">
        <table>
          <tbody>
            {products.data?.products.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong> {!p.published && <span className="badge warn">oculto</span>}
                  <div className="muted small">{p.categories.map((c) => c.category.name).join(', ')} · {p._count.media} fotos/videos</div>
                </td>
                <td className="small">
                  {p.variants.map((v) => (
                    <div key={v.id}>
                      {v.values.join(' / ') || 'Única'}: {priceOf(v, 'retail') ? money(priceOf(v, 'retail')) : 'sin precio'}
                      {priceOf(v, 'wholesale') && ` · may. ${money(priceOf(v, 'wholesale'))}`} · stock {stockOf(v) || 'sin dato'}
                    </div>
                  ))}
                </td>
                <td className="actions">
                  <button onClick={() => setEditing(p)}>Editar</button>
                  <button className="danger" onClick={() => remove(p)}>Borrar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Categories({ categories, reload }: { categories: Category[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    try {
      await api('/catalog/categories', { body: { name } });
      setName('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const rename = async (c: Category) => {
    const next = prompt('Nuevo nombre', c.name);
    if (next) await api('/catalog/categories', { body: { id: c.id, name: next } });
    reload();
  };
  const remove = async (c: Category) => {
    if (!confirm(`¿Borrar la categoría "${c.name}"? Los productos no se borran.`)) return;
    await api(`/catalog/categories/${c.id}`, { method: 'DELETE' });
    reload();
  };
  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Nueva categoría" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
        <button className="primary" disabled={!name.trim()} onClick={add}>Agregar</button>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <tbody>
          {categories.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="muted small">{c._count?.products ?? 0} productos</td>
              <td className="actions">
                <button onClick={() => rename(c)}>Renombrar</button>
                <button className="danger" onClick={() => remove(c)}>Borrar</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServiceCard({ s, reload }: { s: Service; reload: () => void }) {
  const [f, setF] = useState({ description: s.description, conditions: s.conditions, faqs: faqsToText(s.faqs), active: s.active });
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`/catalog/services/${s.service}`, { method: 'PATCH', body: { ...f, faqs: textToFaqs(f.faqs) } });
      setMsg('Guardado');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card stack">
      <h2>{s.name}</h2>
      <label>Qué es y qué incluye<textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label>Condiciones (zonas, anticipación, seña, duración)<textarea rows={3} value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} /></label>
      <label>Preguntas frecuentes<textarea rows={3} value={f.faqs} onChange={(e) => setF({ ...f, faqs: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ofrecer este servicio</label>
      <p className="muted small">Los precios de eventos no se informan automáticamente: la IA toma los datos y te deriva el presupuesto.</p>
      <div className="row">
        <button className="primary" onClick={save}>Guardar</button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

function Catalog() {
  const [tab, setTab] = useState<'products' | 'categories' | 'services'>('products');
  const categories = useData<{ categories: Category[] }>('/catalog/categories');
  const services = useData<{ services: Service[] }>('/catalog/services');
  return (
    <div className="stack">
      <h1>Catálogo de Male Style</h1>
      <div className="tabs">
        <button className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Productos</button>
        <button className={tab === 'categories' ? 'active' : ''} onClick={() => setTab('categories')}>Categorías</button>
        <button className={tab === 'services' ? 'active' : ''} onClick={() => setTab('services')}>Servicios para eventos</button>
      </div>
      {tab === 'products' && <Products categories={categories.data?.categories ?? []} />}
      {tab === 'categories' && <Categories categories={categories.data?.categories ?? []} reload={() => void categories.reload()} />}
      {tab === 'services' && (
        <div className="grid2">
          {services.error && <p className="error">{services.error}</p>}
          {services.data?.services.map((s) => <ServiceCard key={s.service} s={s} reload={() => void services.reload()} />)}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <Catalog />
    </Shell>
  );
}

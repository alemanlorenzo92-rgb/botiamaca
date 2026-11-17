'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useData } from '@/lib/use-data';

const KEY_INFO: Record<string, { label: string; help: string }> = {
  business_profile: { label: 'Perfil del negocio', help: 'Qué vende, ubicación, horarios de atención humana, redes.' },
  store_links: { label: 'Links de la tienda', help: 'Web, Instagram, catálogo.' },
  payment_methods: { label: 'Medios de pago', help: 'Solo los confirmados por el negocio.' },
  shipping_policy: { label: 'Envíos', help: 'Zonas, costos o cómo se cotizan, tiempos, retiro.' },
  wholesale_conditions: { label: 'Condiciones mayoristas', help: 'Mínimo de compra, cómo se accede a la lista mayorista.' },
  retail_conditions: { label: 'Condiciones minoristas', help: 'Cambios, devoluciones, promociones vigentes.' },
  handoff_rules: { label: 'Cuándo pasar a una persona', help: 'Casos en los que la IA debe derivar siempre.' },
  faq: { label: 'Preguntas frecuentes', help: 'Respuestas confirmadas por el negocio.' },
};

function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function fromText(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  return t;
}

function BusinessSettings() {
  const { data, reload } = useData<{ keys: string[]; values: Record<string, unknown> }>('/settings/business');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setDrafts(Object.fromEntries(data.keys.map((k) => [k, toText(data.values[k])])));
  }, [data]);

  if (!data) return <p className="muted">Cargando…</p>;

  const save = async (key: string) => {
    try {
      await api(`/settings/business/${key}`, { method: 'PUT', body: { value: fromText(drafts[key] ?? '') } });
      setMsg({ ...msg, [key]: 'Guardado' });
      await reload();
    } catch (e) {
      setMsg({ ...msg, [key]: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="stack">
      <p className="muted small">
        Lo que no esté cargado acá, la IA lo informa como &quot;sin dato&quot; y ofrece una persona. Nunca inventa precios ni
        condiciones.
      </p>
      <div className="grid2">
        {data.keys.map((k) => (
          <div key={k} className="card stack">
            <div className="row between">
              <strong>{KEY_INFO[k]?.label ?? k}</strong>
              {data.values[k] === undefined ? <span className="badge warn">sin cargar</span> : <span className="badge">cargado</span>}
            </div>
            <div className="muted small">{KEY_INFO[k]?.help}</div>
            <textarea rows={6} value={drafts[k] ?? ''} onChange={(e) => setDrafts({ ...drafts, [k]: e.target.value })} />
            <div className="row">
              <button className="primary" onClick={() => save(k)}>
                Guardar
              </button>
              {msg[k] && <span className="small">{msg[k]}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface AiSettings {
  enabled: boolean;
  model: string | null;
  personality: string;
  instructions: string;
  greeting: string | null;
  handoffMessage: string;
  errorMessage: string;
  outsideHoursMessage: string | null;
  businessHours: unknown;
  maxRepliesPerHour: number;
  dailyTokenBudget: number | null;
  debounceSeconds: number;
  historyMessages: number;
}

function AiSettingsForm() {
  const { data, reload } = useData<{ ai: AiSettings }>('/settings/ai');
  const [form, setForm] = useState<AiSettings | null>(null);
  const [hours, setHours] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (data) {
      setForm(data.ai);
      setHours(toText(data.ai.businessHours));
    }
  }, [data]);
  if (!form) return <p className="muted">Cargando…</p>;

  const text = (key: keyof AiSettings, label: string, rows = 3) => (
    <label>
      {label}
      <textarea rows={rows} value={(form[key] as string | null) ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );
  const num = (key: keyof AiSettings, label: string) => (
    <label>
      {label}
      <input
        type="number"
        value={(form[key] as number | null) ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value === '' ? null : Number(e.target.value) })}
      />
    </label>
  );

  const save = async () => {
    setMsg(null);
    let businessHours: unknown = null;
    if (hours.trim()) {
      try {
        businessHours = JSON.parse(hours);
      } catch {
        setMsg('El horario no es JSON válido');
        return;
      }
    }
    try {
      await api('/settings/ai', {
        method: 'PUT',
        body: {
          model: form.model || null,
          personality: form.personality,
          instructions: form.instructions,
          greeting: form.greeting || null,
          handoffMessage: form.handoffMessage,
          errorMessage: form.errorMessage,
          outsideHoursMessage: form.outsideHoursMessage || null,
          businessHours,
          maxRepliesPerHour: form.maxRepliesPerHour,
          dailyTokenBudget: form.dailyTokenBudget,
          debounceSeconds: form.debounceSeconds,
          historyMessages: form.historyMessages,
        },
      });
      setMsg('Guardado');
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card stack" style={{ maxWidth: 760 }}>
      <label>
        Modelo (vacío = el de OPENAI_MODEL)
        <input value={form.model ?? ''} onChange={(e) => setForm({ ...form, model: e.target.value })} />
      </label>
      {text('personality', 'Personalidad', 4)}
      {text('instructions', 'Instrucciones adicionales', 6)}
      {text('greeting', 'Saludo inicial (opcional)')}
      {text('handoffMessage', 'Mensaje al pasar con una persona')}
      {text('errorMessage', 'Mensaje si la IA falla')}
      {text('outsideHoursMessage', 'Mensaje fuera de horario (opcional)')}
      <label>
        Horario de atención humana (JSON, vacío = sin horario)
        <textarea
          rows={4}
          placeholder={'{"days": {"mon": [["09:00", "18:00"]], "sat": [["10:00", "13:00"]]}}'}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
      </label>
      <div className="grid2">
        {num('maxRepliesPerHour', 'Máx. respuestas por hora y cliente')}
        {num('dailyTokenBudget', 'Presupuesto diario de tokens (vacío = sin límite)')}
        {num('debounceSeconds', 'Espera antes de responder (segundos)')}
        {num('historyMessages', 'Mensajes de historial que lee la IA')}
      </div>
      <div className="row">
        <button className="primary" onClick={save}>
          Guardar
        </button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

interface User {
  id: string;
  email: string;
  name: string;
  active: boolean;
  lastLoginAt: string | null;
  role: { code: string; name: string };
}

function Users() {
  const { user: me } = useSession();
  const { data, reload } = useData<{ users: User[] }>('/users');
  const [form, setForm] = useState({ email: '', name: '', password: '', roleCode: 'agent' });
  const [msg, setMsg] = useState<string | null>(null);
  const create = async () => {
    setMsg(null);
    try {
      await api('/users', { body: form });
      setForm({ email: '', name: '', password: '', roleCode: 'agent' });
      setMsg('Usuario creado');
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const toggle = async (u: User) => {
    await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
    await reload();
  };
  return (
    <div className="stack">
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Email</th>
            <th>Rol</th>
            <th>Último ingreso</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role.name}</td>
              <td>{dateTime(u.lastLoginAt)}</td>
              <td>
                {u.id !== me.id && (
                  <button className={u.active ? 'danger' : ''} onClick={() => toggle(u)}>
                    {u.active ? 'Desactivar' : 'Activar'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card stack" style={{ maxWidth: 520 }}>
        <h2>Nuevo usuario</h2>
        <input placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input
          placeholder="Contraseña (mín. 10 caracteres)"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <select value={form.roleCode} onChange={(e) => setForm({ ...form, roleCode: e.target.value })}>
          <option value="agent">Vendedor/a</option>
          <option value="admin">Administrador</option>
        </select>
        <div className="row">
          <button className="primary" disabled={!form.email || !form.name || form.password.length < 10} onClick={create}>
            Crear
          </button>
          {msg && <span className="small">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

function Settings() {
  const { can } = useSession();
  const [tab, setTab] = useState<'business' | 'ai' | 'users'>('business');
  return (
    <div className="stack">
      <h1>Configuración</h1>
      <div className="tabs">
        <button className={tab === 'business' ? 'active' : ''} onClick={() => setTab('business')}>
          Datos del negocio
        </button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
          IA
        </button>
        {can('users') && (
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            Usuarios
          </button>
        )}
      </div>
      {tab === 'business' && <BusinessSettings />}
      {tab === 'ai' && <AiSettingsForm />}
      {tab === 'users' && can('users') && <Users />}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Shell>
      <Settings />
    </Shell>
  );
}

'use client';

import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { useData } from '@/lib/use-data';

interface Dashboard {
  conversations: Record<string, number>;
  orders: Record<string, number>;
  leads: Record<string, number>;
  followupsDue: number;
  knowledge: Record<string, number>;
  products: number;
  media: Record<string, number>;
  imports: Record<string, number>;
  aiRuns24h: Record<string, number>;
  whatsapp: string;
  openai: boolean;
}

function Stat({ href, label, value, alert }: { href: string; label: string; value: number | string; alert?: boolean }) {
  return (
    <Link href={href} className={alert ? 'card stat alert' : 'card stat'}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </Link>
  );
}

function Home() {
  const { data, error } = useData<Dashboard>('/dashboard');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;
  const failed = (data.aiRuns24h.ERROR ?? 0) + (data.aiRuns24h.TIMEOUT ?? 0);
  return (
    <div className="stack">
      <h1>Inicio</h1>
      {!data.openai && <p className="badge warn">Falta OPENAI_API_KEY: la IA no responde ni aprende de los chats.</p>}
      {data.whatsapp !== 'CONNECTED' && <p className="badge warn">WhatsApp: {data.whatsapp === 'DISABLED' ? 'deshabilitado' : 'sin conectar'}</p>}
      <h2>Para atender</h2>
      <div className="stats">
        <Stat href="/inbox" label="Piden hablar con vos" value={data.conversations.HUMAN_REQUESTED ?? 0} alert={(data.conversations.HUMAN_REQUESTED ?? 0) > 0} />
        <Stat href="/inbox" label="Atendiendo vos" value={data.conversations.HUMAN_ACTIVE ?? 0} />
        <Stat href="/inbox" label="Atiende la IA" value={data.conversations.AI_ACTIVE ?? 0} />
        <Stat href="/orders" label="Pedidos a revisar" value={data.orders.PENDING_REVIEW ?? 0} alert={(data.orders.PENDING_REVIEW ?? 0) > 0} />
        <Stat href="/leads" label="Eventos nuevos" value={data.leads.NEW ?? 0} />
        <Stat href="/followups" label="Seguimientos vencidos" value={data.followupsDue} alert={data.followupsDue > 0} />
      </div>
      <h2>Lo que sabe la IA</h2>
      <div className="stats">
        <Stat href="/knowledge" label="Conocimiento para revisar" value={(data.knowledge.PENDING ?? 0) + (data.knowledge.CONFLICT ?? 0)} alert={(data.knowledge.CONFLICT ?? 0) > 0} />
        <Stat href="/knowledge" label="Conocimiento aprobado" value={data.knowledge.APPROVED ?? 0} />
        <Stat href="/knowledge" label="Chats procesándose" value={(data.imports.PENDING ?? 0) + (data.imports.PROCESSING ?? 0)} />
        <Stat href="/catalog" label="Productos" value={data.products} />
        <Stat href="/library" label="Fotos y videos activos" value={data.media.true ?? 0} />
        <Stat href="/library" label="Para revisar (importados)" value={data.media.false ?? 0} />
        <Stat href="/audit" label="Errores de IA (24 h)" value={failed} alert={failed > 0} />
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <Home />
    </Shell>
  );
}

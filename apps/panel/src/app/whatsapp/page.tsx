'use client';

import { Shell } from '@/components/Shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLiveEvents } from '@/lib/session';
import { useData } from '@/lib/use-data';

interface Status {
  status: string;
  qr: string | null;
  me: string | null;
  lastConnected: string | null;
  lastError: string | null;
}

const LABEL: Record<string, string> = {
  DISABLED: 'Deshabilitado (WHATSAPP_ENABLED=false)',
  DISCONNECTED: 'Desconectado',
  CONNECTING: 'Conectando…',
  QR: 'Esperando escaneo del QR',
  CONNECTED: 'Conectado',
  LOGGED_OUT: 'Sesión cerrada',
};

function WhatsApp() {
  const { data, reload, setData } = useData<Status>('/whatsapp/status');
  useLiveEvents((e) => {
    if (e.type === 'whatsapp.status') {
      setData((prev) => (prev ? { ...prev, status: e.status, qr: e.qr ?? null } : prev));
      void reload();
    }
  });
  const logout = async () => {
    if (!confirm('Se va a desvincular el número y habrá que escanear un QR nuevo. ¿Seguro?')) return;
    await api('/whatsapp/logout', { body: {} });
    await reload();
  };
  if (!data) return <p className="muted">Cargando…</p>;
  return (
    <div className="stack">
      <h1>WhatsApp</h1>
      <div className="card stack" style={{ maxWidth: 520 }}>
        <div>
          Estado: <strong>{LABEL[data.status] ?? data.status}</strong>
        </div>
        {data.me && <div className="small">Número vinculado: {data.me.split(':')[0]?.split('@')[0]}</div>}
        <div className="small muted">Última conexión: {dateTime(data.lastConnected)}</div>
        {data.lastError && <div className="error small">{data.lastError}</div>}
        {data.status === 'QR' && data.qr && (
          <>
            <p>En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo, y escaneá este código.</p>
            <img className="qr" src={data.qr} alt="Código QR de WhatsApp" />
          </>
        )}
        <p className="small muted">
          Integración no oficial (WhatsApp Web). Usá un número dedicado al negocio y evitá envíos masivos.
        </p>
        {data.status !== 'DISABLED' && (
          <div>
            <button className="danger" onClick={logout}>
              Desvincular número
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WhatsAppPage() {
  return (
    <Shell>
      <WhatsApp />
    </Shell>
  );
}

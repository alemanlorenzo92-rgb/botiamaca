'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { SessionContext } from '@/lib/session';
import type { BusEvent, Me } from '@/lib/types';

const NAV: { href: string; label: string; permission: string }[] = [
  { href: '/dashboard', label: 'Inicio', permission: 'inbox' },
  { href: '/inbox', label: 'Bandeja', permission: 'inbox' },
  { href: '/contacts', label: 'Contactos', permission: 'contacts' },
  { href: '/catalog', label: 'Catálogo', permission: 'catalog' },
  { href: '/library', label: 'Fotos y videos', permission: 'catalog' },
  { href: '/knowledge', label: 'Conocimiento', permission: 'knowledge' },
  { href: '/orders', label: 'Pedidos', permission: 'orders' },
  { href: '/leads', label: 'Eventos', permission: 'leads' },
  { href: '/followups', label: 'Seguimientos', permission: 'followups' },
  { href: '/settings', label: 'Configuración', permission: 'settings' },
  { href: '/whatsapp', label: 'WhatsApp', permission: 'whatsapp' },
  { href: '/audit', label: 'Auditoría', permission: 'audit' },
];

function AiSwitch({ can }: { can: (p: string) => boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!can('settings')) return;
    api<{ ai: { enabled: boolean } }>('/settings/ai').then((r) => setEnabled(r.ai.enabled), () => {});
  }, [can]);
  if (enabled === null) return null;
  const toggle = async () => {
    const next = !enabled;
    if (!next && !confirm('¿Apagar todas las respuestas automáticas de la IA?')) return;
    const r = await api<{ ai: { enabled: boolean } }>('/settings/ai/toggle', { body: { enabled: next } });
    setEnabled(r.ai.enabled);
  };
  return (
    <button className={enabled ? 'switch on' : 'switch off'} onClick={toggle} title="Interruptor general de la IA">
      IA {enabled ? 'encendida' : 'apagada'}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [live, setLive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const pathname = usePathname();

  useEffect(() => {
    api<{ user: Me }>('/auth/me').then((r) => setUser(r.user), () => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    const source = new EventSource('/api/events');
    const dispatch = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as BusEvent;
      listeners.current.forEach((l) => l(event));
    };
    for (const type of ['message.created', 'conversation.updated', 'whatsapp.status', 'followup.due', 'human.requested']) {
      source.addEventListener(type, dispatch as EventListener);
    }
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [user]);

  useEffect(() => {
    const onEvent = (e: BusEvent) => {
      if (e.type === 'human.requested' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Un cliente pide hablar con una persona', { body: e.reason ?? '' });
      }
    };
    listeners.current.add(onEvent);
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
    return () => {
      listeners.current.delete(onEvent);
    };
  }, []);

  const subscribe = useCallback((listener: (e: BusEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo(() => {
    if (!user) return null;
    const can = (p: string) => user.permissions.includes(p);
    return { user, can, subscribe };
  }, [user, subscribe]);

  if (!value) return <div className="center muted">Cargando…</div>;

  const required = NAV.find((n) => pathname?.startsWith(n.href))?.permission;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} });
    window.location.href = '/login';
  };

  return (
    <SessionContext.Provider value={value}>
      <div className="layout">
        <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
          <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menú">☰ Male Style</button>
          <div className="brand">Male Style</div>
          <nav>
            {NAV.filter((n) => value.can(n.permission)).map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setMenuOpen(false)} className={pathname?.startsWith(n.href) ? 'active' : ''}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="sidebar-footer">
            <AiSwitch can={value.can} />
            <div className="muted small">
              <span className={live ? 'dot ok' : 'dot bad'} /> {live ? 'En vivo' : 'Sin conexión en vivo'}
            </div>
            <div className="small">
              {value.user.name} · {value.user.role.name}
            </div>
            <button className="link" onClick={logout}>
              Cerrar sesión
            </button>
          </div>
        </aside>
        <main className="main">
          {required && !value.can(required) ? <p className="muted">No tenés acceso a esta sección.</p> : children}
        </main>
      </div>
    </SessionContext.Provider>
  );
}

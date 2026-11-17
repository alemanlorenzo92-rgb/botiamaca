'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import type { BusEvent, Me } from './types';

interface SessionValue {
  user: Me;
  can: (permission: string) => boolean;
  subscribe: (listener: (event: BusEvent) => void) => () => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession fuera de <Shell>');
  return value;
}

/** Escucha los eventos en vivo (SSE) mientras el componente está montado. */
export function useLiveEvents(listener: (event: BusEvent) => void) {
  const { subscribe } = useSession();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

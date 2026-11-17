export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Error ${res.status}`);
  return data as T;
}

export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false);
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : '';
}

export async function upload<T = unknown>(path: string, file: File, fields: Record<string, string | undefined> = {}): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') form.append(k, v);
  form.append('file', file);
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Error ${res.status}`, data);
  return data as T;
}

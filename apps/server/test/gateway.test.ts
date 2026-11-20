import { expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Cipher } from '../src/core/crypto.js';
import type { EventBus } from '../src/core/events.js';
import type { Logger } from '../src/core/logger.js';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = {
    ev: {
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
      }),
    },
    end: vi.fn(),
    updateMediaMessage: vi.fn(),
    user: null as { id: string; name: string } | null,
  };

  return {
    handlers,
    socket,
    makeWASocket: vi.fn(() => socket),
  };
});

vi.mock('baileys', () => ({
  default: mocks.makeWASocket,
  Browsers: { macOS: vi.fn(() => 'Chrome') },
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  downloadMediaMessage: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [1, 2, 3] })),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  normalizeMessageContent: vi.fn((message: unknown) => message),
}));

vi.mock('../src/whatsapp/auth-state.js', () => ({
  clearAuthState: vi.fn(),
  usePostgresAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  })),
}));

vi.mock('../src/whatsapp/message-mapper.js', () => ({
  mapWAMessage: vi.fn(),
}));

vi.mock('../src/ai/transcriber.js', () => ({
  transcribeIfAudio: vi.fn(async (message: unknown) => message),
}));

import { WhatsAppGateway } from '../src/whatsapp/gateway.js';

it('schedules a reconnect when persisting a close status fails', async () => {
  vi.useFakeTimers();
  mocks.handlers.clear();
  mocks.socket.ev.on.mockClear();
  mocks.makeWASocket.mockClear().mockReturnValue(mocks.socket);

  const upsert = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('database unavailable'));
  const db = { waState: { upsert } } as unknown as PrismaClient;
  const logger = {
    child: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const bus = { publish: vi.fn() } as unknown as EventBus;
  const gateway = new WhatsAppGateway(db, {} as Cipher, bus, logger as unknown as Logger, vi.fn(async () => {}));

  try {
    await gateway.start();
    const onConnectionUpdate = mocks.handlers.get('connection.update');
    expect(onConnectionUpdate).toBeDefined();

    onConnectionUpdate?.({
      connection: 'close',
      lastDisconnect: { error: { message: 'connection closed', output: { statusCode: 428 } } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(gateway.getStatus()).toMatchObject({ status: 'DISCONNECTED', qr: null });
    expect(logger.warn).toHaveBeenCalledWith(
      { disconnectReasonCode: 428 },
      'WhatsApp conexión cerrada',
    );
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), status: 'DISCONNECTED' },
      'no se pudo guardar estado de WhatsApp',
    );
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await gateway.stop();
    vi.useRealTimers();
  }
});

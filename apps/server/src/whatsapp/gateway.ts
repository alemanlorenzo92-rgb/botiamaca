import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from 'baileys';
import type { PrismaClient } from '@prisma/client';
import QRCode from 'qrcode';
import type { Cipher } from '../core/crypto.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { clearAuthState, usePostgresAuthState } from './auth-state.js';
import { mapWAMessage } from './message-mapper.js';
import { WhatsAppNotConnectedError, type InboundWhatsAppMessage, type OutboundMedia, type WhatsAppTransport } from './transport.js';

export type WhatsAppStatus = 'DISABLED' | 'DISCONNECTED' | 'CONNECTING' | 'QR' | 'CONNECTED' | 'LOGGED_OUT';

const MAX_BACKOFF_MS = 60_000;
const APPEND_MAX_AGE_MS = 10 * 60 * 1000;
/** WhatsApp manda el historial en varias tandas: se junta todo y se procesa cuando dejan de llegar. */
const HISTORY_QUIET_MS = 30_000;

/** Tras reconectar, Baileys reenvía historial ("append"): solo se procesa lo reciente. */
export function shouldHandleUpsert(type: string, timestamp: Date, now = Date.now()): boolean {
  return type === 'notify' || now - timestamp.getTime() <= APPEND_MAX_AGE_MS;
}

/**
 * Adaptador Baileys (integración NO oficial de WhatsApp Web). Debe correr en una sola instancia.
 */
export class WhatsAppGateway implements WhatsAppTransport {
  private sock: WASocket | null = null;
  private status: WhatsAppStatus = 'DISCONNECTED';
  private qrDataUrl: string | null = null;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private historyBuffer: InboundWhatsAppMessage[] = [];
  private historyTimer: NodeJS.Timeout | null = null;
  private historyOwner: string | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: Cipher,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly onMessage: (msg: InboundWhatsAppMessage) => Promise<void>,
    private readonly onConnected: () => void = () => {},
    private readonly onHistory: (messages: InboundWhatsAppMessage[], ownerName: string | null) => Promise<unknown> = async () => {},
  ) {}

  getStatus() {
    return { status: this.status, qr: this.qrDataUrl, me: this.sock?.user?.id ?? null };
  }

  isConnected(): boolean {
    return this.status === 'CONNECTED' && !!this.sock;
  }

  private async setStatus(status: WhatsAppStatus, extra: { error?: string | null } = {}) {
    this.status = status;
    if (status !== 'QR') this.qrDataUrl = null;
    const now = new Date();
    await this.db.waState.upsert({
      where: { id: 1 },
      create: { id: 1, status },
      update: {
        status,
        meJid: this.sock?.user?.id ?? undefined,
        ...(status === 'CONNECTED' ? { lastConnected: now, lastError: null } : {}),
        ...(status === 'DISCONNECTED' || status === 'LOGGED_OUT' ? { lastDisconnect: now } : {}),
        ...(extra.error !== undefined ? { lastError: extra.error } : {}),
      },
    });
    this.bus.publish({ type: 'whatsapp.status', status, qr: this.qrDataUrl });
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    await this.setStatus('CONNECTING');
    const { state, saveCreds } = await usePostgresAuthState(this.db, this.cipher);
    const waLogger = this.logger.child({ module: 'baileys' });
    waLogger.level = 'warn';

    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined;
    }

    // El nombre de la cuenta es por vinculación: lo pendiente se procesa con el de la sesión anterior y después se reinicia.
    void this.flushHistory();
    this.historyOwner = null;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
      browser: Browsers.macOS('Desktop'),
      logger: waLogger,
      markOnlineOnConnect: false,
      // Historial completo al vincular: el bot aprende de todos los chats que WhatsApp mande (no responde ninguno).
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());

    sock.ev.on('connection.update', (update) => {
      void (async () => {
        if (update.qr) {
          this.qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 320 });
          this.status = 'QR';
          this.bus.publish({ type: 'whatsapp.status', status: 'QR', qr: this.qrDataUrl });
          await this.db.waState.upsert({ where: { id: 1 }, create: { id: 1, status: 'QR' }, update: { status: 'QR' } });
        }
        if (update.connection === 'open') {
          this.attempts = 0;
          await this.setStatus('CONNECTED');
          this.onConnected();
          this.logger.info({ me: sock.user?.id }, 'WhatsApp conectado');
        }
        if (update.connection === 'close') {
          const code = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const reason = update.lastDisconnect?.error?.message ?? 'desconocido';
          this.sock = null;
          if (this.stopping) return;
          if (code === DisconnectReason.loggedOut) {
            this.logger.warn('Sesión de WhatsApp cerrada desde el teléfono: hace falta escanear un QR nuevo');
            await clearAuthState(this.db);
            await this.setStatus('LOGGED_OUT', { error: 'Sesión cerrada desde el teléfono' });
            this.scheduleReconnect(2000);
            return;
          }
          await this.setStatus('DISCONNECTED', { error: `${code ?? ''} ${reason}`.trim() });
          const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
          this.attempts += 1;
          this.scheduleReconnect(delay);
        }
      })().catch((error: unknown) => this.logger.error({ err: error }, 'error en connection.update'));
    });

    // Historial que WhatsApp manda al vincular: no se responde, solo se usa para aprender.
    sock.ev.on('messaging-history.set', ({ messages }) => {
      this.historyOwner = sock.user?.name ?? this.historyOwner;
      for (const raw of messages) {
        const mapped = mapWAMessage(raw);
        if (mapped) this.historyBuffer.push(mapped);
      }
      if (this.historyTimer) clearTimeout(this.historyTimer);
      this.historyTimer = setTimeout(() => this.flushHistory(), HISTORY_QUIET_MS);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      void (async () => {
        for (const raw of messages) {
          const mapped = mapWAMessage(raw);
          if (!mapped) continue;
          if (!shouldHandleUpsert(type, mapped.timestamp)) continue;
          try {
            await this.onMessage(mapped);
          } catch (error) {
            this.logger.error({ err: error, externalId: mapped.externalId }, 'no se pudo procesar el mensaje entrante');
          }
        }
      })();
    });
  }

  private flushHistory(): Promise<unknown> {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    const batch = this.historyBuffer;
    this.historyBuffer = [];
    if (!batch.length) return Promise.resolve();
    return this.onHistory(batch, this.historyOwner).catch((error: unknown) => this.logger.error({ err: error }, 'no se pudo procesar el historial'));
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error: unknown) => {
        this.logger.error({ err: error }, 'falló la reconexión de WhatsApp');
        this.scheduleReconnect(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** ++this.attempts));
      });
    }, delayMs);
  }

  async sendText(jid: string, text: string): Promise<{ externalId: string }> {
    if (!this.sock || !this.isConnected()) throw new WhatsAppNotConnectedError();
    const sent = await this.sock.sendMessage(jid, { text });
    if (!sent?.key.id) throw new Error('WhatsApp no devolvió id de mensaje');
    return { externalId: sent.key.id };
  }

  async sendMedia(jid: string, media: OutboundMedia): Promise<{ externalId: string }> {
    if (!this.sock || !this.isConnected()) throw new WhatsAppNotConnectedError();
    const caption = media.caption ?? undefined;
    const sent = await this.sock.sendMessage(
      jid,
      media.kind === 'IMAGE'
        ? { image: media.data, mimetype: media.mimetype, caption }
        : { video: media.data, mimetype: media.mimetype, caption },
    );
    if (!sent?.key.id) throw new Error('WhatsApp no devolvió id de mensaje');
    return { externalId: sent.key.id };
  }

  /** Cierra la sesión vinculada y genera un QR nuevo. */
  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      this.sock?.end(undefined);
    }
    this.sock = null;
    await clearAuthState(this.db);
    await this.setStatus('LOGGED_OUT');
    this.scheduleReconnect(1000);
  }

  async stop(): Promise<void> {
    await this.flushHistory();
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
    this.sock = null;
  }
}

/** Transporte usado cuando WhatsApp está deshabilitado (desarrollo/pruebas). */
export class DisabledTransport implements WhatsAppTransport {
  isConnected() {
    return false;
  }
  async sendText(): Promise<{ externalId: string }> {
    throw new WhatsAppNotConnectedError();
  }
  async sendMedia(): Promise<{ externalId: string }> {
    throw new WhatsAppNotConnectedError();
  }
}

import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { AiOrchestrator, openAiLlm, type LlmClient } from './ai/orchestrator.js';
import { CatalogAdminService } from './catalog/catalog-admin.service.js';
import { CatalogService } from './catalog/catalog.service.js';
import { ServicesService } from './catalog/services.service.js';
import { ConversationService } from './conversations/conversation.service.js';
import { HandoffService } from './conversations/handoff.service.js';
import { ReplyGuard } from './conversations/reply-guard.js';
import { ReplyWorker } from './conversations/reply-worker.js';
import { AutoFollowupService } from './conversations/auto-followup.js';
import { MessageSender } from './conversations/sender.js';
import { AuditService } from './core/audit.js';
import { Cipher } from './core/crypto.js';
import type { Env } from './core/env.js';
import { EventBus } from './core/events.js';
import type { Logger } from './core/logger.js';
import { SettingsService } from './core/settings.js';
import { FollowupsService } from './events/followups.service.js';
import { LeadsService } from './events/leads.service.js';
import { AuthService } from './http/auth.js';
import { CartService } from './sales/cart.service.js';
import { MediaService } from './media/media.service.js';
import { LocalMediaStorage } from './media/storage.js';
import { DisabledTransport, WhatsAppGateway } from './whatsapp/gateway.js';
import type { MediaStorage } from './media/storage.js';
import { localEmbedder, openAiEmbedder, type Embedder } from './knowledge/embedder.js';
import { ChatImportService } from './knowledge/import.service.js';
import { JobRunner } from './knowledge/jobs.js';
import { KnowledgeService } from './knowledge/knowledge.service.js';
import type { InboundWhatsAppMessage, WhatsAppTransport } from './whatsapp/transport.js';
import { ChannelRouter } from './meta/channel-router.js';
import { MetaTransport } from './meta/meta-transport.js';

export interface ContainerOverrides {
  db?: PrismaClient;
  transport?: WhatsAppTransport;
  llm?: LlmClient | null;
  storage?: MediaStorage;
  embedder?: Embedder;
}

/** Arma todos los servicios. Un solo proceso: Baileys exige una única instancia. */
export function createContainer(env: Env, logger: Logger, overrides: ContainerOverrides = {}) {
  const db = overrides.db ?? new PrismaClient();
  const bus = new EventBus();
  const cipher = new Cipher(env.ENCRYPTION_KEY);
  const audit = new AuditService(db);
  const settings = new SettingsService(db);

  let onMessage: (msg: InboundWhatsAppMessage) => Promise<void> = async () => {};
  let onConnected: () => void = () => {};
  let onHistory: (messages: InboundWhatsAppMessage[], ownerName: string | null) => Promise<unknown> = async () => {};
  const gateway =
    !overrides.transport && env.WHATSAPP_ENABLED
      ? new WhatsAppGateway(db, cipher, bus, logger, (msg) => onMessage(msg), () => onConnected(), (msgs, owner) => onHistory(msgs, owner))
      : null;
  const whatsappTransport: WhatsAppTransport = overrides.transport ?? gateway ?? new DisabledTransport();
  const metaEnabled = !!(env.META_APP_SECRET && env.META_VERIFY_TOKEN && env.META_PAGE_ACCESS_TOKEN && env.META_APP_ID);
  const metaTransport = new MetaTransport(metaEnabled ? env.META_PAGE_ACCESS_TOKEN! : null);
  const transport: WhatsAppTransport = new ChannelRouter(whatsappTransport, metaTransport);

  const media = new MediaService(db, overrides.storage ?? new LocalMediaStorage(env.MEDIA_DIR), {
    maxImageBytes: env.MEDIA_MAX_IMAGE_MB * 1024 * 1024,
    maxVideoBytes: env.MEDIA_MAX_VIDEO_MB * 1024 * 1024,
  });
  const sender = new MessageSender(db, transport, bus, media);
  const handoff = new HandoffService(db, bus, audit, settings, sender);
  const conversations = new ConversationService(db, bus, handoff);


  const catalog = new CatalogService(db);
  const catalogAdmin = new CatalogAdminService(db);
  const services = new ServicesService(db);
  const cart = new CartService(db, bus);
  const leads = new LeadsService(db, bus);
  const followups = new FollowupsService(db, bus, logger);

  const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 2, timeout: env.OPENAI_TIMEOUT_MS }) : null;
  const llm = overrides.llm !== undefined ? overrides.llm : openai ? openAiLlm(openai) : null;
  const embedder = overrides.embedder ?? (openai ? openAiEmbedder(openai, env.OPENAI_EMBEDDING_MODEL) : localEmbedder);
  const jobs = new JobRunner(db, logger);
  const knowledge = new KnowledgeService(db, llm, embedder, logger, { model: env.OPENAI_MODEL });
  const chatImport = new ChatImportService(db, media, jobs, logger, {
    maxUncompressedBytes: env.IMPORT_MAX_MB * 1024 * 1024,
    maxFileBytes: Math.max(env.MEDIA_MAX_IMAGE_MB, env.MEDIA_MAX_VIDEO_MB) * 1024 * 1024,
  });
  jobs.on('knowledge.extract', async (payload) => {
    await knowledge.extractChat((payload as { chatId: string }).chatId);
  });
  const ai = new AiOrchestrator(
    llm,
    { db, catalog, cart, leads, followups, handoff, settings, audit, media, sender, services },
    {
      model: env.OPENAI_MODEL,
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.OPENAI_TIMEOUT_MS,
    },
    logger,
    knowledge,
    () => {
      if (env.WHATSAPP_CONTACT_LINK) return env.WHATSAPP_CONTACT_LINK;
      const me = gateway?.isConnected() ? gateway.getStatus().me : null;
      const number = me?.split('@')[0]?.split(':')[0];
      return number ? `https://wa.me/${number}` : null;
    },
  );
  const guard = new ReplyGuard(db, settings);
  const worker = new ReplyWorker(db, guard, ai, sender, handoff, settings, logger);
  const autoFollowups = new AutoFollowupService(db, settings, sender, logger);
  onHistory = (msgs, owner) => chatImport.importHistory(msgs, owner);
  onConnected = () => {
    void worker.recoverPending().catch((err: unknown) => logger.error({ err }, 'no se pudieron retomar respuestas pendientes'));
  };

  onMessage = async (msg) => {
    const result = await conversations.ingest(msg);
    if (result.kind === 'customer' && result.needsReply) await worker.schedule(result.conversationId);
  };

  const auth = new AuthService(db, audit);

  return {
    env,
    logger,
    db,
    bus,
    audit,
    settings,
    transport,
    metaTransport,
    gateway,
    sender,
    handoff,
    conversations,
    catalog,
    catalogAdmin,
    services,
    media,
    jobs,
    knowledge,
    chatImport,
    cart,
    leads,
    followups,
    autoFollowups,
    ai,
    guard,
    worker,
    auth,
    /** Punto de entrada de mensajes de WhatsApp (también usado en tests). */
    handleInbound: (msg: InboundWhatsAppMessage) => onMessage(msg),
  };
}

export type Container = ReturnType<typeof createContainer>;

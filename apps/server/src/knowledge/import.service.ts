import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import AdmZip from 'adm-zip';
import type { Logger } from '../core/logger.js';
import { MediaError, type MediaService } from '../media/media.service.js';
import { anonymize } from './anonymize.js';
import type { JobRunner } from './jobs.js';
import type { InboundWhatsAppMessage } from '../whatsapp/transport.js';
import { parseWhatsAppExport, type ParsedChat } from './whatsapp-parser.js';

export const OWNER_ALIAS = 'Dueña';
/** Del historial que manda WhatsApp al vincular se usan hasta 5000 mensajes por chat (la extracción los parte en tramos). */
const HISTORY_MAX_MESSAGES = 5000;
const HISTORY_MIN_MESSAGES = 4;

export class ImportError extends Error {
  constructor(
    message: string,
    readonly participants?: string[],
  ) {
    super(message);
  }
}

interface Extracted {
  text: string;
  fileName: string;
  /** Adjuntos del ZIP; se descomprimen recién cuando se usan, de a uno. */
  files: Map<string, () => Buffer>;
}

function sha256(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex');
}

/** Importa chats exportados de WhatsApp (TXT o ZIP con adjuntos) de forma idempotente. */
export class ChatImportService {
  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
    private readonly jobs: JobRunner,
    private readonly logger: Logger,
    private readonly limits = { maxUncompressedBytes: 200 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024 },
  ) {}

  extract(data: Buffer, fileName: string): Extracted {
    const isZip = data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (!isZip) return { text: data.toString('utf8'), fileName, files: new Map() };
    let zip: AdmZip;
    try {
      zip = new AdmZip(data);
    } catch {
      throw new ImportError('El ZIP está dañado o no se puede leer');
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX'));
    const txt = entries
      .filter((e) => e.entryName.toLowerCase().endsWith('.txt'))
      .sort((a, b) => b.header.size - a.header.size)[0];
    if (!txt) throw new ImportError('El ZIP no tiene el archivo .txt del chat');
    const total = entries.reduce((sum, e) => sum + e.header.size, 0);
    if (total > this.limits.maxUncompressedBytes || txt.header.size > this.limits.maxUncompressedBytes)
      throw new ImportError('El ZIP descomprimido es demasiado grande');
    const files = new Map<string, () => Buffer>();
    for (const e of entries) {
      // Los adjuntos más grandes que el máximo de la biblioteca se descartan sin descomprimir.
      if (e === txt || e.header.size > this.limits.maxFileBytes) continue;
      // Solo el nombre del archivo: nunca rutas del ZIP (evita path traversal).
      files.set(path.basename(e.entryName), () => e.getData());
    }
    return { text: txt.getData().toString('utf8'), fileName: path.basename(txt.entryName), files };
  }

  /** Vista previa sin guardar: participantes y cantidad de mensajes para elegir quién es la dueña. */
  preview(data: Buffer, fileName: string) {
    const { text, files } = this.extract(data, fileName);
    const chat = parseWhatsAppExport(text);
    if (!chat.messages.length) throw new ImportError('No se encontraron mensajes. ¿Es un chat exportado desde WhatsApp?');
    const counts = Object.fromEntries(chat.participants.map((p) => [p, chat.messages.filter((m) => m.author === p).length]));
    return {
      participants: chat.participants,
      messagesByParticipant: counts,
      messageCount: chat.messages.length,
      mediaFiles: files.size,
      from: chat.messages[0]!.sentAt,
      to: chat.messages[chat.messages.length - 1]!.sentAt,
    };
  }

  async import(params: { data: Buffer; fileName: string; ownerName: string; consent: boolean; mediaConsent: boolean; userId?: string | null }) {
    if (!params.consent) throw new ImportError('Confirmá que este chat se puede usar para aprender');
    const { text, files } = this.extract(params.data, params.fileName);
    const hash = sha256(text);
    const existing = await this.db.importedChat.findUnique({ where: { sha256: hash } });
    if (existing) return { chat: existing, duplicate: true, inserted: 0, skipped: 0, mediaImported: 0, mediaErrors: [] as string[] };

    const parsed: ParsedChat = parseWhatsAppExport(text);
    if (!parsed.messages.length) throw new ImportError('No se encontraron mensajes. ¿Es un chat exportado desde WhatsApp?');
    const owner = parsed.participants.find((p) => p.toLowerCase() === params.ownerName.trim().toLowerCase());
    if (!owner) throw new ImportError('Elegí cuál de los participantes es la dueña', parsed.participants);

    // El nombre del export suele traer el contacto ("Chat de WhatsApp con Juan…"): no se guarda.
    const first = parsed.messages[0]!.sentAt.toISOString().slice(0, 10);
    const safeName = `Chat del ${first.split('-').reverse().join('/')} (${parsed.messages.length} mensajes)${path.extname(params.fileName).toLowerCase() === '.zip' ? '.zip' : '.txt'}`;
    const aliases = new Map<string, string>();
    let n = 0;
    for (const p of parsed.participants) aliases.set(p, p === owner ? OWNER_ALIAS : `Cliente ${++n}`);

    const chat = await this.db.importedChat.create({
      data: {
        fileName: safeName,
        sha256: hash,
        ownerName: OWNER_ALIAS,
        participants: [...aliases.values()],
        consent: true,
        mediaConsent: params.mediaConsent,
        status: 'PENDING',
        importedById: params.userId ?? null,
      },
    });

    try {
      return await this.store(chat.id, parsed, owner, aliases, files, params.mediaConsent);
    } catch (error) {
      // Sin importación a medias: si algo falla se borra todo y el mismo archivo se puede reintentar.
      await this.remove(chat.id).catch((e: unknown) => this.logger.error({ err: e, chatId: chat.id }, 'no se pudo limpiar la importación fallida'));
      throw error;
    }
  }

  /**
   * Aprende del historial que WhatsApp manda al vincular el número (sin responderle a nadie): chats de a dos con
   * mensajes de la dueña y de la clienta. Se anonimiza igual que un export y el conocimiento queda pendiente de revisión.
   */
  async importHistory(messages: InboundWhatsAppMessage[], ownerName: string | null = null) {
    const byChat = new Map<string, InboundWhatsAppMessage[]>();
    for (const m of messages) {
      if (m.type !== 'TEXT' || !m.text?.trim()) continue;
      // El mismo chat puede llegar como número o como LID: se agrupa por el número cuando WhatsApp lo informa.
      const key = m.chatJid.endsWith('@lid') && m.altJid?.endsWith('@s.whatsapp.net') ? m.altJid : m.chatJid;
      const list = byChat.get(key) ?? [];
      list.push(m);
      byChat.set(key, list);
    }
    let imported = 0;
    for (const [jid, all] of byChat) {
      const list = [...all].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).slice(-HISTORY_MAX_MESSAGES);
      if (list.length < HISTORY_MIN_MESSAGES || !list.some((m) => m.fromMe) || !list.some((m) => !m.fromMe)) continue;
      const ids = [...new Set(all.flatMap((m) => [m.chatJid, m.altJid]).filter((x): x is string => !!x))];
      const muted = await this.db.contact.findFirst({ where: { OR: [{ waJid: { in: ids } }, { waAltJid: { in: ids } }], botMuted: true }, select: { id: true } });
      if (muted) continue;
      const hash = sha256(`history|${jid}|${list.at(-1)!.externalId}`);
      if (await this.db.importedChat.findUnique({ where: { sha256: hash } })) continue;
      // Etiquetas internas (sin espacios, no aparecen en el texto); el número de la clienta no se guarda.
      const owner = 'historial:duena';
      const customer = `historial:${sha256(jid).slice(0, 16)}`;
      const aliases = new Map([[owner, OWNER_ALIAS], [customer, 'Cliente 1']]);
      const pushName = list.find((m) => !m.fromMe && m.pushName)?.pushName;
      if (pushName) aliases.set(pushName, 'Cliente 1');
      if (ownerName) aliases.set(ownerName, OWNER_ALIAS);
      const parsed: ParsedChat = {
        participants: [owner, customer],
        skippedLines: 0,
        messages: list.map((m) => ({ sentAt: m.timestamp, author: m.fromMe ? owner : customer, text: m.text!, mediaFile: null, mediaOmitted: false })),
      };
      const chat = await this.db.importedChat.create({
        data: {
          fileName: `Historial de WhatsApp del ${list[0]!.timestamp.toISOString().slice(0, 10).split('-').reverse().join('/')} (${list.length} mensajes)`,
          sha256: hash,
          ownerName: OWNER_ALIAS,
          participants: [OWNER_ALIAS, 'Cliente 1'],
          consent: true,
          mediaConsent: false,
          status: 'PENDING',
        },
      });
      try {
        await this.store(chat.id, parsed, owner, aliases, new Map(), false);
        imported++;
      } catch (error) {
        await this.remove(chat.id).catch((e: unknown) => this.logger.error({ err: e, chatId: chat.id }, 'no se pudo limpiar la importación fallida'));
        this.logger.error({ err: error }, 'no se pudo aprender de un chat del historial');
      }
    }
    this.logger.info({ messages: messages.length, chats: byChat.size, imported }, 'historial de WhatsApp procesado para aprender');
    return { imported };
  }

  private async store(
    chatId: string,
    parsed: ParsedChat,
    owner: string,
    aliases: Map<string, string>,
    files: Map<string, () => Buffer>,
    mediaConsent: boolean,
  ) {
    const chat = { id: chatId };
    const sig = (m: ParsedChat['messages'][number]) => `${m.sentAt.toISOString()}|${m.author}|${m.text}|${m.mediaFile ?? ''}`;
    // El chat se identifica por la clienta (primer participante que no es la dueña), no por el contenido del export:
    // así exports solapados del mismo chat (de a dos: dueña y clienta) dan las mismas claves aunque uno tenga más historia.
    const customer = parsed.messages.find((m) => m.author !== owner)?.author ?? '';
    // Mensajes idénticos en el mismo minuto (p. ej. "Dale!" dos veces) se distinguen por su número de aparición.
    const seen = new Map<string, number>();
    const occurrence = parsed.messages.map((m) => {
      const n = (seen.get(sig(m)) ?? 0) + 1;
      seen.set(sig(m), n);
      return n;
    });
    const rows = parsed.messages.map((m, position) => ({
      chatId: chat.id,
      position,
      sentAt: m.sentAt,
      author: aliases.get(m.author)!,
      fromOwner: m.author === owner,
      text: anonymize(m.text, aliases),
      mediaFile: m.mediaFile,
      // Nombres reales hasheados (no se guardan): una respuesta igual a la misma hora en otro chat no choca.
      dedupeKey: sha256(`${customer}#${sig(m)}#${occurrence[position]}`),
    }));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      inserted += (await this.db.importedMessage.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true })).count;
    }

    let mediaImported = 0;
    const mediaErrors: string[] = [];
    if (mediaConsent) {
      for (const m of parsed.messages) {
        if (!m.mediaFile) continue;
        const file = files.get(m.mediaFile);
        if (!file) continue;
        try {
          // Los medios importados quedan desactivados hasta que la dueña los revise: la IA no los envía antes.
          const r = await this.media.upload({ data: file(), originalName: m.mediaFile, source: 'IMPORT', importedChatId: chat.id, fields: { active: false } });
          if (!r.duplicate) mediaImported++;
        } catch (error) {
          if (error instanceof MediaError) mediaErrors.push(`${m.mediaFile}: ${error.message}`);
          else throw error;
        }
      }
    }

    const saved = await this.db.importedChat.update({
      where: { id: chat.id },
      data: { messageCount: inserted, mediaCount: mediaImported, error: mediaErrors.length ? mediaErrors.slice(0, 20).join('\n') : null },
    });
    if (inserted) await this.jobs.enqueue('knowledge.extract', { chatId: chat.id });
    else await this.db.importedChat.update({ where: { id: chat.id }, data: { status: 'DONE', processedAt: new Date() } });
    this.logger.info({ chatId: chat.id, inserted, skipped: rows.length - inserted }, 'chat importado');
    return { chat: saved, duplicate: false, inserted, skipped: rows.length - inserted, mediaImported, mediaErrors };
  }

  /** Borra la importación, sus mensajes, medios importados y el conocimiento que solo salía de este chat. */
  async remove(chatId: string) {
    const docs = await this.db.knowledgeDocument.findMany({
      where: { sources: { some: { chatId } } },
      include: { sources: { select: { chatId: true } } },
    });
    const onlyThisChat = docs.filter((d) => d.sources.every((s) => s.chatId === chatId)).map((d) => d.id);
    const media = await this.db.mediaAsset.findMany({ where: { importedChatId: chatId, source: 'IMPORT' }, select: { id: true } });
    await this.db.knowledgeDocument.deleteMany({ where: { id: { in: onlyThisChat } } });
    for (const m of media) await this.media.remove(m.id);
    await this.db.importedChat.delete({ where: { id: chatId } });
    return { deletedDocuments: onlyThisChat.length, deletedMedia: media.length };
  }
}

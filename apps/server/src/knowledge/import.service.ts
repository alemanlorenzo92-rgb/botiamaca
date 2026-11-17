import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import AdmZip from 'adm-zip';
import type { Logger } from '../core/logger.js';
import { MediaError, type MediaService } from '../media/media.service.js';
import { anonymize } from './anonymize.js';
import type { JobRunner } from './jobs.js';
import { parseWhatsAppExport, type ParsedChat } from './whatsapp-parser.js';

export const OWNER_ALIAS = 'Dueña';

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
  files: Map<string, Buffer>;
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
    const files = new Map<string, Buffer>();
    for (const e of entries) {
      if (e === txt) continue;
      // Solo el nombre del archivo: nunca rutas del ZIP (evita path traversal).
      files.set(path.basename(e.entryName), e.getData());
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

    const aliases = new Map<string, string>();
    let n = 0;
    for (const p of parsed.participants) aliases.set(p, p === owner ? OWNER_ALIAS : `Cliente ${++n}`);

    const chat = await this.db.importedChat.create({
      data: {
        fileName: params.fileName.slice(0, 255),
        sha256: hash,
        ownerName: OWNER_ALIAS,
        participants: [...aliases.values()],
        consent: true,
        mediaConsent: params.mediaConsent,
        status: 'PENDING',
        importedById: params.userId ?? null,
      },
    });

    const rows = parsed.messages.map((m, position) => ({
      chatId: chat.id,
      position,
      sentAt: m.sentAt,
      author: aliases.get(m.author)!,
      fromOwner: m.author === owner,
      text: anonymize(m.text, aliases),
      mediaFile: m.mediaFile,
      // Incluye el nombre real (hasheado, no se guarda) para detectar el mismo mensaje en exports solapados.
      dedupeKey: sha256(`${m.sentAt.toISOString()}|${m.author}|${m.text}|${m.mediaFile ?? ''}`),
    }));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      inserted += (await this.db.importedMessage.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true })).count;
    }

    let mediaImported = 0;
    const mediaErrors: string[] = [];
    if (params.mediaConsent) {
      for (const m of parsed.messages) {
        if (!m.mediaFile) continue;
        const file = files.get(m.mediaFile);
        if (!file) continue;
        try {
          // Los medios importados quedan desactivados hasta que la dueña los revise: la IA no los envía antes.
          const r = await this.media.upload({ data: file, originalName: m.mediaFile, source: 'IMPORT', importedChatId: chat.id, fields: { active: false } });
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

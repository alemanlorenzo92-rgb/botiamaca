import type { KnowledgeKind, KnowledgeStatus, Prisma, PrismaClient } from '@prisma/client';
import type { Response } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { LlmClient } from '../ai/orchestrator.js';
import type { Logger } from '../core/logger.js';
import { anonymize } from './anonymize.js';
import { toVectorLiteral, type Embedder } from './embedder.js';

const KINDS = ['STYLE', 'FAQ', 'PRODUCT', 'SERVICE', 'POLICY', 'OBJECTION', 'SALES_PROCESS', 'OTHER'] as const;
export const DUPLICATE_SIMILARITY = 0.92;
const CONFLICT_CHECK_SIMILARITY = 0.75;
const MAX_SEGMENT_CHARS = 12_000;
const MAX_EXAMPLES_PER_CHAT = 300;

const itemSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(3000),
  temporal: z.boolean(),
  confidence: z.number().min(0).max(1),
  excerpt: z.string().max(1000),
});
export type ExtractedItem = z.infer<typeof itemSchema>;
const extractionSchema = z.object({ items: z.array(itemSchema).max(40) });
const conflictSchema = z.object({ contradicts: z.boolean(), note: z.string().max(500) });

const EXTRACT_INSTRUCTIONS = `Analizás conversaciones reales de WhatsApp entre la dueña de Male Style (tienda de glitter, maquillaje artístico y servicios para eventos: Glitter Bar y Shimmer Walls) y sus clientes. Los nombres ya están reemplazados por "Dueña" y "Cliente N".
Extraé SOLO conocimiento comercial reutilizable que la DUEÑA demuestra, para que una vendedora virtual responda como ella:
- STYLE: tono, saludos, despedidas, emojis, forma de tratar al cliente.
- FAQ: preguntas frecuentes y la respuesta que da la dueña.
- PRODUCT: información de productos (uso, características, recomendaciones).
- SERVICE: Glitter Bar, Shimmer Walls, presupuestos para eventos.
- POLICY: envíos, pagos, mayorista/minorista, mínimos, horarios, cambios.
- OBJECTION: cómo responde a objeciones (precio caro, dudas, comparaciones).
- SALES_PROCESS: cómo califica, presenta, cierra, hace seguimiento o deriva.
Reglas:
- No incluyas datos personales de clientes (nombres, teléfonos, direcciones, montos de un pedido puntual).
- No conviertas un caso particular en regla general. Si algo parece excepción, no lo incluyas.
- Marcá temporal=true para precios, promociones, fechas, stock o cualquier dato que puede cambiar.
- confidence: 0.9 si es claro y repetido, 0.5 si aparece una vez, menos si es ambiguo.
- excerpt: fragmento corto y literal del chat que lo respalda.
- content: redactado como instrucción clara para la vendedora, en español rioplatense.
- Si no hay nada útil, devolvé items vacío.`;

const CONFLICT_INSTRUCTIONS = `Compará dos conocimientos de una tienda. Respondé contradicts=true solo si dicen cosas incompatibles (por ejemplo, condiciones, precios, mínimos o políticas distintas). Si uno complementa al otro, contradicts=false. note: explicación breve en español.`;

function jsonSchema(name: string, schema: Record<string, unknown>) {
  return { format: { type: 'json_schema' as const, name, strict: true, schema } };
}

const ITEM_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'content', 'temporal', 'confidence', 'excerpt'],
        properties: {
          kind: { type: 'string', enum: KINDS },
          title: { type: 'string' },
          content: { type: 'string' },
          temporal: { type: 'boolean' },
          confidence: { type: 'number' },
          excerpt: { type: 'string' },
        },
      },
    },
  },
};
const CONFLICT_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['contradicts', 'note'],
  properties: { contradicts: { type: 'boolean' }, note: { type: 'string' } },
};

function outputText(res: Response): string {
  for (const item of res.output) {
    if (item.type === 'message') {
      for (const c of item.content) if (c.type === 'output_text') return c.text;
    }
  }
  throw new Error('OpenAI no devolvió texto');
}

interface Neighbor {
  id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  status: KnowledgeStatus;
  similarity: number;
}

export interface RetrievedKnowledge {
  documents: { id: string; kind: KnowledgeKind; title: string; content: string; temporal: boolean; similarity: number }[];
  examples: { id: string; text: string; similarity: number }[];
}

/** Extracción de conocimiento de chats importados, revisión por la dueña y recuperación (RAG con pgvector). */
export class KnowledgeService {
  constructor(
    private readonly db: PrismaClient,
    private readonly llm: LlmClient | null,
    private readonly embedder: Embedder,
    private readonly logger: Logger,
    private readonly cfg: { model: string; timeoutMs?: number },
  ) {}

  private async ask<T>(instructions: string, input: string, name: string, schema: Record<string, unknown>, parser: z.ZodType<T>): Promise<T> {
    if (!this.llm) throw new Error('Falta OPENAI_API_KEY: no se puede extraer conocimiento');
    const res = await this.llm.create(
      { model: this.cfg.model, instructions, input, text: jsonSchema(name, schema), max_output_tokens: 4000, store: false },
      { signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000) },
    );
    return parser.parse(JSON.parse(outputText(res)));
  }

  private async setEmbedding(chunkId: string, vector: number[]) {
    await this.db.$executeRaw`UPDATE knowledge_chunks SET embedding = ${toVectorLiteral(vector)}::vector WHERE id = ${chunkId}::uuid`;
  }

  /** Procesa un chat importado: conocimiento propuesto (PENDING) + ejemplos de respuestas de la dueña. */
  async extractChat(chatId: string) {
    const chat = await this.db.importedChat.update({ where: { id: chatId }, data: { status: 'PROCESSING', error: null } });
    try {
      const messages = await this.db.importedMessage.findMany({ where: { chatId }, orderBy: [{ sentAt: 'asc' }, { position: 'asc' }] });
      const lines = messages.filter((m) => m.text.trim()).map((m) => `${m.author}: ${m.text}`);
      const segments: string[] = [];
      let current = '';
      for (const line of lines) {
        if (current.length + line.length > MAX_SEGMENT_CHARS && current) {
          segments.push(current);
          current = '';
        }
        current += `${line.slice(0, 2000)}\n`;
      }
      if (current) segments.push(current);

      const stats = { created: 0, duplicates: 0, conflicts: 0, examples: 0 };
      for (const segment of segments) {
        const { items } = await this.ask(EXTRACT_INSTRUCTIONS, segment, 'knowledge', ITEM_JSON, extractionSchema);
        for (const item of items) {
          const result = await this.addItem(item, chatId);
          if (result === 'created') stats.created++;
          else if (result === 'conflict') stats.conflicts++;
          else stats.duplicates++;
        }
      }
      stats.examples = await this.buildExamples(chatId, messages);
      await this.db.importedChat.update({ where: { id: chatId }, data: { status: 'DONE', processedAt: new Date() } });
      this.logger.info({ chatId, file: chat.fileName, ...stats }, 'conocimiento extraído');
      return stats;
    } catch (error) {
      await this.db.importedChat.update({
        where: { id: chatId },
        data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 1000) : String(error) },
      });
      throw error;
    }
  }

  /** Intercambios cliente → dueña como ejemplos de tono (solo se recuperan los más parecidos a la consulta). */
  private async buildExamples(chatId: string, messages: { fromOwner: boolean; text: string }[]) {
    await this.db.knowledgeChunk.deleteMany({ where: { chatId, kind: 'EXAMPLE' } });
    const pairs: string[] = [];
    for (let i = 0; i < messages.length && pairs.length < MAX_EXAMPLES_PER_CHAT; ) {
      const client: string[] = [];
      while (i < messages.length && !messages[i]!.fromOwner) client.push(messages[i++]!.text);
      const owner: string[] = [];
      while (i < messages.length && messages[i]!.fromOwner) owner.push(messages[i++]!.text);
      const c = client.filter(Boolean).join('\n').trim();
      const o = owner.filter(Boolean).join('\n').trim();
      if (c && o.length >= 15) pairs.push(`Cliente: ${c.slice(0, 600)}\nDueña: ${o.slice(0, 900)}`);
    }
    for (let i = 0; i < pairs.length; i += 64) {
      const batch = pairs.slice(i, i + 64);
      const vectors = await this.embedder.embed(batch);
      for (const [j, text] of batch.entries()) {
        const chunk = await this.db.knowledgeChunk.create({ data: { kind: 'EXAMPLE', chatId, text, active: true } });
        await this.setEmbedding(chunk.id, vectors[j]!);
      }
    }
    return pairs.length;
  }

  private async neighbors(vector: number[], limit = 3): Promise<Neighbor[]> {
    const v = toVectorLiteral(vector);
    return this.db.$queryRaw<Neighbor[]>`
      SELECT d.id, d.kind, d.title, d.content, d.status, (1 - (c.embedding <=> ${v}::vector))::float AS similarity
      FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
      WHERE c.kind = 'DOCUMENT' AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${v}::vector LIMIT ${limit}`;
  }

  /** Agrega un conocimiento: suma fuente si ya existe, marca conflicto si contradice uno existente. */
  async addItem(item: ExtractedItem, chatId: string | null): Promise<'created' | 'duplicate' | 'conflict' | 'rejected'> {
    const content = anonymize(item.content);
    const excerpt = anonymize(item.excerpt).slice(0, 1000);
    const [vector] = await this.embedder.embed([`${item.title}\n${content}`]);
    const near = await this.neighbors(vector!);
    const top = near[0];
    if (top && top.similarity >= DUPLICATE_SIMILARITY) {
      await this.db.knowledgeSource.create({ data: { documentId: top.id, chatId, excerpt } });
      if (top.status === 'REJECTED') return 'rejected';
      await this.db.$executeRaw`UPDATE knowledge_documents SET confidence = LEAST(1, confidence + 0.1), updated_at = now() WHERE id = ${top.id}::uuid`;
      return 'duplicate';
    }
    let conflict: { id: string; note: string } | null = null;
    for (const n of near) {
      if (n.similarity < CONFLICT_CHECK_SIMILARITY || n.kind !== item.kind || n.status === 'REJECTED') continue;
      const verdict = await this.ask(
        CONFLICT_INSTRUCTIONS,
        `A (existente): ${n.title}\n${n.content}\n\nB (nuevo): ${item.title}\n${content}`,
        'conflict',
        CONFLICT_JSON,
        conflictSchema,
      );
      if (verdict.contradicts) {
        conflict = { id: n.id, note: verdict.note };
        break;
      }
    }
    const doc = await this.db.knowledgeDocument.create({
      data: {
        kind: item.kind,
        title: item.title,
        content,
        temporal: item.temporal,
        confidence: item.confidence,
        status: conflict ? 'CONFLICT' : 'PENDING',
        conflictWithId: conflict?.id ?? null,
        conflictNote: conflict?.note ?? null,
        sources: { create: { chatId, excerpt } },
        chunks: { create: { kind: 'DOCUMENT', text: `${item.title}\n${content}`, active: false } },
      },
      include: { chunks: true },
    });
    await this.setEmbedding(doc.chunks[0]!.id, vector!);
    return conflict ? 'conflict' : 'created';
  }

  /** Conocimiento cargado a mano por la dueña: queda aprobado. */
  async createManual(input: { kind: KnowledgeKind; title: string; content: string; temporal?: boolean }, userId: string | null) {
    const [vector] = await this.embedder.embed([`${input.title}\n${input.content}`]);
    const doc = await this.db.knowledgeDocument.create({
      data: {
        kind: input.kind,
        title: input.title,
        content: input.content,
        temporal: input.temporal ?? false,
        confidence: 1,
        status: 'APPROVED',
        sources: { create: { excerpt: 'Cargado por la dueña' } },
        chunks: { create: { kind: 'DOCUMENT', text: `${input.title}\n${input.content}`, active: true } },
        reviews: { create: { action: 'created', userId } },
      },
      include: { chunks: true },
    });
    await this.setEmbedding(doc.chunks[0]!.id, vector!);
    return doc;
  }

  async setStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'DISABLED', userId: string | null, note?: string | null) {
    const doc = await this.db.knowledgeDocument.findUniqueOrThrow({ where: { id } });
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.db.knowledgeDocument.update({ where: { id }, data: { status } }),
      this.db.knowledgeChunk.updateMany({ where: { documentId: id }, data: { active: status === 'APPROVED' } }),
      this.db.knowledgeReview.create({ data: { documentId: id, action: status.toLowerCase(), userId, note: note ?? null, before: { status: doc.status } } }),
    ];
    // Aprobar uno en conflicto: la versión anterior que contradice queda desactivada.
    if (status === 'APPROVED' && doc.conflictWithId) {
      ops.push(
        this.db.knowledgeDocument.updateMany({ where: { id: doc.conflictWithId, status: 'APPROVED' }, data: { status: 'DISABLED' } }),
        this.db.knowledgeChunk.updateMany({ where: { documentId: doc.conflictWithId }, data: { active: false } }),
      );
    }
    await this.db.$transaction(ops);
    return this.db.knowledgeDocument.findUniqueOrThrow({ where: { id } });
  }

  async edit(id: string, input: { kind?: KnowledgeKind; title?: string; content?: string; temporal?: boolean }, userId: string | null) {
    const doc = await this.db.knowledgeDocument.findUniqueOrThrow({ where: { id } });
    const title = input.title ?? doc.title;
    const content = input.content ?? doc.content;
    const updated = await this.db.knowledgeDocument.update({
      where: { id },
      data: {
        kind: input.kind,
        title,
        content,
        temporal: input.temporal,
        version: { increment: 1 },
        reviews: { create: { action: 'edited', userId, before: { title: doc.title, content: doc.content, kind: doc.kind, temporal: doc.temporal } } },
      },
    });
    if (title !== doc.title || content !== doc.content) {
      const [vector] = await this.embedder.embed([`${title}\n${content}`]);
      const chunks = await this.db.knowledgeChunk.findMany({ where: { documentId: id, kind: 'DOCUMENT' } });
      for (const chunk of chunks) {
        await this.db.knowledgeChunk.update({ where: { id: chunk.id }, data: { text: `${title}\n${content}` } });
        await this.setEmbedding(chunk.id, vector!);
      }
    }
    return updated;
  }

  /** Activa o desactiva los ejemplos de tono de un chat importado. */
  async setChatExamples(chatId: string, active: boolean) {
    return (await this.db.knowledgeChunk.updateMany({ where: { chatId, kind: 'EXAMPLE' }, data: { active } })).count;
  }

  /** RAG: solo lo aprobado y relevante para la consulta, nunca todo el historial. */
  async retrieve(query: string, opts: { documents?: number; examples?: number; minSimilarity?: number } = {}): Promise<RetrievedKnowledge> {
    const text = query.trim();
    if (!text) return { documents: [], examples: [] };
    const [vector] = await this.embedder.embed([text.slice(0, 2000)]);
    const v = toVectorLiteral(vector!);
    const min = opts.minSimilarity ?? 0.25;
    const [documents, examples] = await Promise.all([
      this.db.$queryRaw<RetrievedKnowledge['documents']>`
        SELECT d.id, d.kind, d.title, d.content, d.temporal, (1 - (c.embedding <=> ${v}::vector))::float AS similarity
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE c.active AND c.kind = 'DOCUMENT' AND d.status = 'APPROVED' AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${v}::vector LIMIT ${opts.documents ?? 6}`,
      this.db.$queryRaw<RetrievedKnowledge['examples']>`
        SELECT c.id, c.text, (1 - (c.embedding <=> ${v}::vector))::float AS similarity
        FROM knowledge_chunks c JOIN imported_chats ch ON ch.id = c.chat_id
        WHERE c.active AND c.kind = 'EXAMPLE' AND ch.consent AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${v}::vector LIMIT ${opts.examples ?? 3}`,
    ]);
    return {
      documents: documents.filter((d) => d.similarity >= min),
      examples: examples.filter((e) => e.similarity >= min + 0.05),
    };
  }
}

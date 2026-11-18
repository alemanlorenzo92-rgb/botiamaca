import type { KnowledgeKind, KnowledgeStatus, Prisma, PrismaClient } from '@prisma/client';
import type { Response } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { LlmClient } from '../ai/orchestrator.js';
import type { Logger } from '../core/logger.js';
import { normalize } from '../core/text.js';
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
const CONSOLIDATE_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['topics', 'discard'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'content', 'temporal', 'ids'],
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          temporal: { type: 'boolean' },
          ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    discard: { type: 'array', items: { type: 'string' } },
  },
};
const consolidateSchema = z.object({
  topics: z.array(
    z.object({
      title: z.string().min(1),
      content: z.string().min(1),
      temporal: z.boolean(),
      ids: z.array(z.string()),
    }).strict(),
  ),
  discard: z.array(z.string()),
}).strict();
const KIND_LABELS: Record<KnowledgeKind, string> = {
  STYLE: 'estilo',
  FAQ: 'preguntas frecuentes',
  PRODUCT: 'productos',
  SERVICE: 'servicios',
  POLICY: 'políticas',
  OBJECTION: 'objeciones',
  SALES_PROCESS: 'proceso de venta',
  OTHER: 'otros',
};
const CONSOLIDATE_INSTRUCTIONS = `Sos la editora del conocimiento de Male Style, una tienda atendida solo por su dueña. Te paso temas de tipo "{kind}" que se sacaron de chats reales con clientas. Muchos dicen lo mismo con otras palabras.

Agrupalos en la menor cantidad posible de temas claros (en general entre 5 y 20). Cada tema nuevo junta todos los que hablan de lo mismo.

Reglas:
- No inventes nada: el contenido sale solo de los temas que te paso.
- Si dos temas se contradicen (por ejemplo, distinto costo, plazo o condición), NO los juntes: dejalos en temas separados.
- Si hay precios, montos o fechas concretas, copialos tal cual y marcá temporal=true.
- Cada id va en un solo tema. Un tema puede tener un solo id si no se parece a ningún otro.
- Poné en "discard" los ids que no sirven para atender clientas (charla personal, datos sueltos sin contexto, cosas de un solo caso).
- Título corto (máximo 80 caracteres). Contenido en español rioplatense, como instrucciones concretas para el bot, en no más de 1200 caracteres.`;

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

  private async ask<T>(
    instructions: string,
    input: string,
    name: string,
    schema: Record<string, unknown>,
    parser: z.ZodType<T>,
    maxOutputTokens = 4000,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.llm) throw new Error('Falta OPENAI_API_KEY: no se puede extraer conocimiento');
    const res = await this.llm.create(
      {
        model: this.cfg.model,
        instructions,
        input,
        text: jsonSchema(name, schema),
        max_output_tokens: maxOutputTokens,
        store: false,
        // Sin esto gpt-5 razona en "medium" y cada tramo tarda tanto que se corta por tiempo.
        ...(/^(gpt-5|o\d)/.test(this.cfg.model) ? { reasoning: { effort: 'low' as const } } : {}),
      },
      { signal: AbortSignal.timeout(timeoutMs ?? this.cfg.timeoutMs ?? 120_000) },
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

  async consolidate(kind: KnowledgeKind): Promise<number> {
    const where = { kind, status: 'PENDING' as const };
    const before = await this.db.knowledgeDocument.count({ where });
    const documents = await this.db.knowledgeDocument.findMany({
      where,
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: 60,
      select: { id: true, title: true, content: true },
    });
    if (documents.length < 2) {
      this.logger.info({ kind, before, after: before, reduction: 0 }, 'agrupación de conocimiento');
      return 0;
    }

    const ids = new Map<string, string>();
    const input = documents
      .map((doc, index) => {
        const shortId = String(index + 1);
        ids.set(shortId, doc.id);
        return `[${shortId}] ${anonymize(doc.title)}\n${anonymize(doc.content).slice(0, 600)}`;
      })
      .join('\n\n');
    const { topics, discard } = await this.ask(
      CONSOLIDATE_INSTRUCTIONS.replace('{kind}', KIND_LABELS[kind]),
      input,
      'knowledge_consolidation',
      CONSOLIDATE_JSON,
      consolidateSchema,
      12_000,
      300_000,
    );

    const assigned = new Set<string>();
    const validTopics: { topic: (typeof topics)[number]; ids: string[] }[] = [];
    for (const topic of topics) {
      const topicIds: string[] = [];
      for (const shortId of topic.ids) {
        const id = ids.get(shortId);
        if (!id || assigned.has(id)) continue;
        assigned.add(id);
        topicIds.push(id);
      }
      if (topicIds.length) validTopics.push({ topic, ids: topicIds });
    }

    const discarded = new Set<string>();
    for (const shortId of discard) {
      const id = ids.get(shortId);
      if (id && !assigned.has(id)) discarded.add(id);
    }

    for (const { topic, ids: topicIds } of validTopics) {
      const title = anonymize(topic.title).trim().slice(0, 200);
      const content = anonymize(topic.content).trim().slice(0, 3000);
      if (topicIds.length === 1) {
        const id = topicIds[0]!;
        const existing = await this.db.knowledgeDocument.findFirst({
          where: { id, ...where },
          select: { title: true, content: true },
        });
        if (existing && (existing.title !== title || existing.content !== content)) {
          await this.edit(id, { title, content, temporal: topic.temporal }, null);
        }
        continue;
      }

      const originals = await this.db.knowledgeDocument.findMany({
        where: { id: { in: topicIds }, ...where },
        select: { id: true, confidence: true },
      });
      if (originals.length !== topicIds.length) continue;
      const [vector] = await this.embedder.embed([`${title}\n${content}`]);
      await this.db.$transaction(async (tx) => {
        const current = await tx.knowledgeDocument.findMany({
          where: { id: { in: topicIds }, ...where },
          select: { id: true, confidence: true },
        });
        if (current.length !== topicIds.length) return;

        const merged = await tx.knowledgeDocument.create({
          data: {
            kind,
            title,
            content,
            temporal: topic.temporal,
            confidence: Math.max(...current.map((doc) => doc.confidence)),
            status: 'PENDING',
            chunks: { create: { kind: 'DOCUMENT', text: `${title}\n${content}`, active: false } },
          },
          include: { chunks: { select: { id: true } } },
        });
        await tx.$executeRaw`UPDATE knowledge_chunks SET embedding = ${toVectorLiteral(vector!)}::vector WHERE id = ${merged.chunks[0]!.id}::uuid`;
        await tx.knowledgeSource.updateMany({ where: { documentId: { in: topicIds } }, data: { documentId: merged.id } });
        await tx.knowledgeDocument.updateMany({ where: { conflictWithId: { in: topicIds } }, data: { conflictWithId: null } });
        await tx.knowledgeDocument.deleteMany({ where: { id: { in: topicIds } } });
      });
    }

    for (const id of discarded) {
      const pending = await this.db.knowledgeDocument.findFirst({ where: { id, ...where }, select: { id: true } });
      if (pending) await this.setStatus(id, 'REJECTED', null, 'Descartado al agrupar');
    }

    const after = await this.db.knowledgeDocument.count({ where });
    const reduction = Math.max(0, before - after);
    this.logger.info(
      { kind, before, after, reduction, mergedTopics: validTopics.filter((entry) => entry.ids.length > 1).length, discarded: discarded.size },
      'agrupación de conocimiento',
    );
    return reduction;
  }

  async consolidateAll(): Promise<number> {
    let totalReduction = 0;
    for (const kind of KINDS) {
      let pending = await this.db.knowledgeDocument.count({ where: { kind, status: 'PENDING' } });
      let reductionForKind = 0;
      let rounds = 0;
      while (pending > 20 && rounds < 10) {
        rounds++;
        const reduction = await this.consolidate(kind);
        reductionForKind += reduction;
        if (!reduction) break;
        pending = await this.db.knowledgeDocument.count({ where: { kind, status: 'PENDING' } });
      }
      totalReduction += reductionForKind;
      this.logger.info({ kind, rounds, reduction: reductionForKind, pending }, 'agrupación completa por tipo');
    }
    return totalReduction;
  }

  /** Intercambios cliente → dueña como ejemplos de tono (solo se recuperan los más parecidos a la consulta). */
  private async buildExamples(chatId: string, messages: { fromOwner: boolean; text: string }[]) {
    const active = !(await this.db.knowledgeChunk.count({ where: { chatId, kind: 'EXAMPLE', active: false } }));
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
        const chunk = await this.db.knowledgeChunk.create({ data: { kind: 'EXAMPLE', chatId, text, active } });
        await this.setEmbedding(chunk.id, vectors[j]!);
      }
    }
    return pairs.length;
  }

  private conflictVerdict(existing: Neighbor, title: string, content: string) {
    return this.ask(CONFLICT_INSTRUCTIONS, `A (existente): ${existing.title}\n${existing.content}\n\nB (nuevo): ${title}\n${content}`, 'conflict', CONFLICT_JSON, conflictSchema);
  }

  private async neighbors(vector: number[], limit = 3): Promise<Neighbor[]> {
    const v = toVectorLiteral(vector);
    return this.db.$queryRaw<Neighbor[]>`
      SELECT d.id, d.kind, d.title, d.content, d.status, (1 - (c.embedding <=> ${v}::vector))::float AS similarity
      FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
      WHERE c.kind = 'DOCUMENT' AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${v}::vector LIMIT ${limit}`;
  }

  /** Los guardados van de a uno: buscar vecinos y crear tiene que ser atómico aunque se extraigan varios chats a la vez. */
  private saving: Promise<unknown> = Promise.resolve();

  /** Agrega un conocimiento: suma fuente si ya existe, marca conflicto si contradice uno existente. */
  async addItem(item: ExtractedItem, chatId: string | null): Promise<'created' | 'duplicate' | 'conflict' | 'rejected'> {
    const content = anonymize(item.content);
    const excerpt = anonymize(item.excerpt).slice(0, 1000);
    // El embedding va fuera del turno: solo buscar vecinos y guardar se hace de a uno.
    const [vector] = await this.embedder.embed([`${item.title}\n${content}`]);
    const run = this.saving.then(() => this.addItemNow(item, chatId, content, excerpt, vector!));
    this.saving = run.catch(() => {});
    return run;
  }

  private async addItemNow(item: ExtractedItem, chatId: string | null, content: string, excerpt: string, vector: number[]): Promise<'created' | 'duplicate' | 'conflict' | 'rejected'> {
    const near = await this.neighbors(vector);
    const top = near[0];
    let conflict: { id: string; note: string } | null = null;
    // Muy parecido pero con otro texto (p. ej. otro valor): primero se pregunta si contradice.
    if (top && top.similarity >= DUPLICATE_SIMILARITY && top.kind === item.kind && top.status !== 'REJECTED' && normalize(top.content) !== normalize(content)) {
      const verdict = await this.conflictVerdict(top, item.title, content);
      if (verdict.contradicts) conflict = { id: top.id, note: verdict.note };
    }
    if (!conflict && top && top.similarity >= DUPLICATE_SIMILARITY) {
      await this.db.knowledgeSource.create({ data: { documentId: top.id, chatId, excerpt } });
      if (top.status === 'REJECTED') return 'rejected';
      await this.db.$executeRaw`UPDATE knowledge_documents SET confidence = LEAST(1, confidence + 0.1), updated_at = now() WHERE id = ${top.id}::uuid`;
      return 'duplicate';
    }
    for (const n of conflict ? [] : near) {
      if (n.similarity < CONFLICT_CHECK_SIMILARITY || n.kind !== item.kind || n.status === 'REJECTED') continue;
      const verdict = await this.conflictVerdict(n, item.title, content);
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
    const changed = title !== doc.title || content !== doc.content;
    // Embedding antes de guardar: si falla, no queda texto nuevo con el vector viejo.
    const vector = changed ? (await this.embedder.embed([`${title}\n${content}`]))[0]! : null;
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
    if (vector) {
      const chunks = await this.db.knowledgeChunk.findMany({ where: { documentId: id, kind: 'DOCUMENT' } });
      for (const chunk of chunks) {
        await this.db.knowledgeChunk.update({ where: { id: chunk.id }, data: { text: `${title}\n${content}` } });
        await this.setEmbedding(chunk.id, vector);
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

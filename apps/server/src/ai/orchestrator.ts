import type { Message, Prisma } from '@prisma/client';
import type OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import type { AiResponder } from '../conversations/reply-worker.js';
import { sha256 } from '../core/crypto.js';
import type { Logger } from '../core/logger.js';
import { BUSINESS_SETTING_KEYS } from '../core/settings.js';
import { truncate } from '../core/text.js';
import type { KnowledgeService, RetrievedKnowledge } from '../knowledge/knowledge.service.js';
import { buildInstructions } from './prompt.js';
import { openAiTools, runTool, type ToolContext, type ToolDeps } from './tools.js';

/** Lo mínimo que necesitamos del cliente de OpenAI (permite simularlo en tests). */
export interface LlmClient {
  create(params: ResponseCreateParamsNonStreaming, options: { signal: AbortSignal; timeout?: number }): Promise<Response>;
}

export function openAiLlm(client: OpenAI): LlmClient {
  return { create: (params, options) => client.responses.create(params, options) };
}

export interface OrchestratorConfig {
  model: string;
  maxOutputTokens: number;
  /** Tiempo máximo por llamada a OpenAI. */
  requestTimeoutMs: number;
  /** Tiempo máximo de toda la corrida (todas las vueltas). */
  totalTimeoutMs?: number;
  maxRounds?: number;
}

export class AiTimeoutError extends Error {
  constructor() {
    super('La IA superó el tiempo máximo de respuesta');
  }
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super('Falta OPENAI_API_KEY');
  }
}

interface ToolLog {
  name: string;
  args: unknown;
  ok: boolean;
  error?: string;
  ms: number;
}

const DEFAULT_MAX_ROUNDS = 5;
const MAX_TOOL_OUTPUT_CHARS = 12_000;

const MEDIA_LABEL: Record<Message['type'], string | null> = {
  TEXT: null,
  IMAGE: 'una imagen',
  AUDIO: 'un audio (no podés escucharlo: pedile que lo escriba)',
  VIDEO: 'un video',
  DOCUMENT: 'un archivo',
  STICKER: 'un sticker',
  LOCATION: 'una ubicación',
  OTHER: 'un mensaje que no se puede leer',
};

/** Convierte el historial guardado en mensajes para la Responses API. */
export function historyToInput(messages: Message[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    const media = MEDIA_LABEL[m.type];
    const audioText = m.type === 'AUDIO' ? m.text?.trim() : null;
    const body = audioText
      ? `[Envió un audio; transcripción automática] ${audioText}`
      : [media ? `[Envió ${media}]` : null, m.text?.trim() || null].filter(Boolean).join(' ');
    if (!body) continue;
    if (m.author === 'CUSTOMER') items.push({ role: 'user', content: body });
    else if (m.author === 'HUMAN') items.push({ role: 'assistant', content: `[Respondió la dueña] ${body}` });
    else items.push({ role: 'assistant', content: body });
  }
  return items;
}

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Orquestador de la IA: arma el contexto (configuración, perfil y memoria del cliente, historial),
 * llama a la Responses API y ejecuta las herramientas en un loop acotado.
 * Cada corrida queda registrada en `ai_runs`.
 */
export class AiOrchestrator implements AiResponder {
  private readonly tools = openAiTools();

  constructor(
    private readonly llm: LlmClient | null,
    private readonly deps: ToolDeps,
    private readonly config: OrchestratorConfig,
    private readonly logger: Logger,
    private readonly knowledge: KnowledgeService | null = null,
  ) {}

  private async retrieve(recent: Message[], toolLog: ToolLog[]): Promise<RetrievedKnowledge | null> {
    if (!this.knowledge) return null;
    const query = recent
      .filter((m) => m.author === 'CUSTOMER' && m.text)
      .slice(0, 3)
      .map((m) => m.text)
      .join('\n');
    if (!query) return null;
    const t = Date.now();
    try {
      const found = await this.knowledge.retrieve(query);
      // Trazabilidad: qué conocimiento y ejemplos se usaron en esta respuesta.
      if (found.documents.length || found.examples.length)
        toolLog.push({ name: 'rag', args: { documents: found.documents.map((d) => d.id), examples: found.examples.map((e) => e.id) }, ok: true, ms: Date.now() - t });
      return found;
    } catch (error) {
      this.logger.error({ err: error }, 'no se pudo recuperar conocimiento');
      toolLog.push({ name: 'rag', args: null, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - t });
      return null;
    }
  }

  async respond(conversationId: string): Promise<{ text: string | null }> {
    const { db, settings } = this.deps;
    const started = Date.now();
    const ai = await settings.getAi();
    const model = ai.model ?? this.config.model;
    const toolLog: ToolLog[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    const finish = async (status: 'OK' | 'ERROR', error?: string) => {
      await db.aiRun
        .create({
          data: {
            conversationId,
            model,
            status,
            inputTokens,
            outputTokens,
            toolCalls: toolLog as unknown as Prisma.InputJsonValue,
            latencyMs: Date.now() - started,
            error: error ?? null,
          },
        })
        .catch((err: unknown) => this.logger.error({ err, conversationId }, 'no se pudo registrar ai_run'));
    };

    try {
      if (!this.llm) throw new AiNotConfiguredError();
      const conversation = await db.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        include: { contact: true },
      });
      const [recent, business] = await Promise.all([
        db.message.findMany({
          where: { conversationId, status: { in: ['RECEIVED', 'SENT'] } },
          orderBy: { createdAt: 'desc' },
          take: ai.historyMessages,
        }),
        settings.getAllBusiness(),
      ]);
      const ctx: ToolContext = { conversationId, contact: conversation.contact, handedOff: false, mediaSent: 0 };
      const instructions = buildInstructions({
        ai,
        contact: ctx.contact,
        businessProfile: business.business_profile ?? null,
        configuredTopics: BUSINESS_SETTING_KEYS.filter((k) => business[k] !== undefined && business[k] !== null),
        now: new Date(),
        knowledge: await this.retrieve(recent, toolLog),
        firstReply: isFirstReply(
          (await db.message.findFirst({ where: { conversationId, direction: 'OUTBOUND', author: { in: ['AI', 'HUMAN'] }, status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }))?.createdAt ?? null,
        ),
      });
      const input = historyToInput(recent.reverse());
      if (!input.length) {
        await finish('OK');
        return { text: null };
      }

      const maxRounds = this.config.maxRounds ?? DEFAULT_MAX_ROUNDS;
      const deadline = started + (this.config.totalTimeoutMs ?? this.config.requestTimeoutMs * 2);
      const reasoning = isReasoningModel(model);
      let text: string | null = null;

      for (let round = 0; round < maxRounds; round++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AiTimeoutError();
        const lastRound = round === maxRounds - 1;
        const params: ResponseCreateParamsNonStreaming = {
          model,
          instructions,
          input,
          tools: this.tools,
          tool_choice: lastRound ? 'none' : 'auto',
          max_output_tokens: ai.maxOutputTokens ?? this.config.maxOutputTokens,
          store: false,
          safety_identifier: sha256(ctx.contact.id).slice(0, 32),
          ...(reasoning ? { reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'] } : {}),
          ...(model.startsWith('gpt-5') ? { text: { verbosity: 'low' } } : {}),
          ...(ai.temperature !== null && !reasoning ? { temperature: ai.temperature } : {}),
        };
        let response: Response;
        try {
          response = await this.llm.create(params, {
            signal: AbortSignal.timeout(Math.min(remaining, this.config.requestTimeoutMs)),
          });
        } catch (error) {
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new AiTimeoutError();
          }
          throw error;
        }
        inputTokens += response.usage?.input_tokens ?? 0;
        outputTokens += response.usage?.output_tokens ?? 0;
        if (response.error) throw new Error(`OpenAI: ${response.error.message}`);

        const calls = response.output.filter((o) => o.type === 'function_call');
        if (!calls.length) {
          text = response.output_text?.trim() || null;
          if (!text && response.status === 'incomplete') {
            throw new Error(`Respuesta incompleta de OpenAI (${response.incomplete_details?.reason ?? 'sin motivo'})`);
          }
          break;
        }

        input.push(...(response.output as ResponseInputItem[]));
        for (const call of calls) {
          const t0 = Date.now();
          const outcome = await runTool(call.name, call.arguments, ctx, this.deps);
          toolLog.push({
            name: call.name,
            args: parseArgs(call.arguments),
            ok: outcome.ok,
            ...(outcome.ok ? {} : { error: outcome.error }),
            ms: Date.now() - t0,
          });
          if (!outcome.ok && outcome.internal) {
            this.logger.error({ conversationId, tool: call.name, error: outcome.error }, 'falló una herramienta');
          }
          const payload = outcome.ok
            ? outcome.output
            : { error: outcome.internal ? 'Error interno al consultar el dato' : outcome.error };
          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: truncate(JSON.stringify(payload ?? null), MAX_TOOL_OUTPUT_CHARS),
          });
          if (ctx.handedOff) break;
        }

        if (ctx.handedOff) {
          await finish('OK');
          return { text: null };
        }
      }

      await finish('OK');
      return { text };
    } catch (error) {
      await finish('ERROR', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

/** Si la tienda nunca respondió (o la última respuesta tiene más de 3 días), la clienta recién llega o vuelve. */
export function isFirstReply(lastReplyAt: Date | null, now = Date.now()): boolean {
  return !lastReplyAt || now - lastReplyAt.getTime() > 3 * 24 * 60 * 60 * 1000;
}

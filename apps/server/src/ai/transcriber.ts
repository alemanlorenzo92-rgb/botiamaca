import type OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import type { Logger } from '../core/logger.js';
import type { InboundWhatsAppMessage } from '../whatsapp/transport.js';

export interface AudioTranscriber {
  transcribe(audio: Buffer, mime: string | null): Promise<string | null>;
}

export class OpenAiTranscriber implements AudioTranscriber {
  constructor(
    private readonly openai: OpenAI,
    private readonly model: string,
    private readonly logger: Logger,
  ) {}

  async transcribe(audio: Buffer, mime: string | null): Promise<string | null> {
    const startedAt = Date.now();
    const type = mime ?? 'audio/ogg';
    const extension = type.split(';', 1)[0]!.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'ogg';
    const file = await toFile(audio, `audio.${extension}`, { type });
    const result = await this.openai.audio.transcriptions.create({ model: this.model, file, language: 'es' });
    const text = result.text.trim();
    this.logger.info({ durationMs: Date.now() - startedAt, length: text.length }, 'audio transcribed');
    return text || null;
  }
}

export const MAX_AUDIO_SECONDS = 300;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export async function transcribeIfAudio(
  msg: InboundWhatsAppMessage,
  opts: { seconds: number | null; download: () => Promise<Buffer>; transcriber: AudioTranscriber | null; logger: Logger },
): Promise<InboundWhatsAppMessage> {
  if (msg.type !== 'AUDIO' || msg.fromMe || !opts.transcriber || (opts.seconds !== null && opts.seconds > MAX_AUDIO_SECONDS)) {
    return msg;
  }
  try {
    const audio = await opts.download();
    if (audio.length > MAX_AUDIO_BYTES) {
      opts.logger.warn({ length: audio.length }, 'audio transcription skipped: file too large');
      return msg;
    }
    const text = (await opts.transcriber.transcribe(audio, msg.mediaMime))?.trim();
    return text ? { ...msg, text } : msg;
  } catch (error) {
    opts.logger.warn({ errName: error instanceof Error ? error.name : 'unknown' }, 'audio transcription failed');
    return msg;
  }
}

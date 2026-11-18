import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@prisma/client';
import { historyToInput } from '../src/ai/orchestrator.js';
import { createLogger } from '../src/core/logger.js';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  transcribeIfAudio,
  type AudioTranscriber,
} from '../src/ai/transcriber.js';
import type { InboundWhatsAppMessage } from '../src/whatsapp/transport.js';

const logger = createLogger('silent');
const audioMessage = (extra: Partial<InboundWhatsAppMessage> = {}): InboundWhatsAppMessage => ({
  externalId: 'audio-1',
  chatJid: '5493510000001@s.whatsapp.net',
  altJid: null,
  fromMe: false,
  pushName: 'Juli',
  type: 'AUDIO',
  text: null,
  mediaMime: 'audio/ogg',
  timestamp: new Date(),
  ...extra,
});

describe('transcribeIfAudio', () => {
  it('transcribe audio entrante y agrega el texto', async () => {
    const transcriber: AudioTranscriber = { transcribe: vi.fn().mockResolvedValue('Quiero dos kilos de papa') };
    const result = await transcribeIfAudio(audioMessage(), {
      seconds: null,
      download: async () => Buffer.from('audio'),
      transcriber,
      logger,
    });
    expect(result.text).toBe('Quiero dos kilos de papa');
    expect(transcriber.transcribe).toHaveBeenCalledWith(Buffer.from('audio'), 'audio/ogg');
  });

  it('si el transcriptor falla, devuelve el mensaje sin cambios', async () => {
    const msg = audioMessage();
    const result = await transcribeIfAudio(msg, {
      seconds: null,
      download: async () => Buffer.from('audio'),
      transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('failed')) },
      logger,
    });
    expect(result).toBe(msg);
  });

  it('no descarga mensajes propios', async () => {
    const download = vi.fn();
    const result = await transcribeIfAudio(audioMessage({ fromMe: true }), {
      seconds: null,
      download,
      transcriber: { transcribe: vi.fn() },
      logger,
    });
    expect(download).not.toHaveBeenCalled();
    expect(result.fromMe).toBe(true);
  });

  it('no descarga audios de más de cinco minutos', async () => {
    const download = vi.fn();
    const result = await transcribeIfAudio(audioMessage(), {
      seconds: MAX_AUDIO_SECONDS + 1,
      download,
      transcriber: { transcribe: vi.fn() },
      logger,
    });
    expect(download).not.toHaveBeenCalled();
    expect(result.text).toBeNull();
  });

  it('descarta archivos mayores a 10 MiB', async () => {
    const transcribe = vi.fn();
    const result = await transcribeIfAudio(audioMessage(), {
      seconds: null,
      download: async () => Buffer.alloc(MAX_AUDIO_BYTES + 1),
      transcriber: { transcribe },
      logger,
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(result.text).toBeNull();
  });

  it('no cambia el mensaje si no hay transcriptor', async () => {
    const msg = audioMessage();
    const download = vi.fn();
    const result = await transcribeIfAudio(msg, { seconds: null, download, transcriber: null, logger });
    expect(result).toBe(msg);
    expect(download).not.toHaveBeenCalled();
  });

  it('no descarga ni transcribe un mensaje duplicado', async () => {
    const msg = audioMessage();
    const download = vi.fn();
    const transcribe = vi.fn();
    const result = await transcribeIfAudio(msg, {
      seconds: null,
      download,
      transcriber: { transcribe },
      isDuplicate: async () => true,
      logger,
    });
    expect(result).toBe(msg);
    expect(download).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('historial de audios', () => {
  it('incluye la transcripción y conserva la etiqueta para audios sin texto', () => {
    const transcribed = { author: 'CUSTOMER', type: 'AUDIO', text: '¿Hacen envío a Centro?' } as unknown as Message;
    const empty = { author: 'CUSTOMER', type: 'AUDIO', text: null } as unknown as Message;
    expect(historyToInput([transcribed])[0]).toMatchObject({
      role: 'user',
      content: '[Envió un audio; transcripción automática] ¿Hacen envío a Centro?',
    });
    expect(historyToInput([empty])[0]).toMatchObject({
      role: 'user',
      content: '[Envió un audio (no podés escucharlo: pedile que lo escriba)]',
    });
  });
});

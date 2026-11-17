import { describe, expect, it } from 'vitest';
import { anonymize } from '../src/knowledge/anonymize.js';
import { parseWhatsAppExport } from '../src/knowledge/whatsapp-parser.js';

describe('parser de chats exportados', () => {
  it('Android: participantes, multilínea, adjuntos, omitidos y orden cronológico', () => {
    const raw = [
      '16/11/2026, 21:40 - Los mensajes y las llamadas están cifrados de extremo a extremo.',
      '16/11/2026, 21:41 - Juana Pérez: Hola! precio del glitter?',
      'es para revender',
      '16/11/2026, 21:45 - Male Style: Hola Juana! Te paso info 💖',
      '16/11/2026, 21:46 - Male Style: IMG-20261116-WA0001.jpg (archivo adjunto)',
      '16/11/2026, 21:47 - Juana Pérez: <Multimedia omitido>',
      '16/11/2026, 21:43 - Juana Pérez: (mensaje fuera de orden)',
    ].join('\n');
    const chat = parseWhatsAppExport(raw);
    expect(chat.participants).toEqual(['Juana Pérez', 'Male Style']);
    expect(chat.messages).toHaveLength(5);
    expect(chat.messages[0]).toMatchObject({ author: 'Juana Pérez', text: 'Hola! precio del glitter?\nes para revender' });
    expect(chat.messages[1]!.text).toBe('(mensaje fuera de orden)');
    expect(chat.messages[3]).toMatchObject({ mediaFile: 'IMG-20261116-WA0001.jpg', text: '' });
    expect(chat.messages[4]).toMatchObject({ mediaOmitted: true });
    expect(chat.messages[0]!.sentAt.toISOString()).toBe('2026-11-17T00:41:00.000Z');
    expect(chat.skippedLines).toBe(1);
  });

  it('iOS con caracteres invisibles, segundos y a. m./p. m.', () => {
    const raw = '\u200e[16/11/26, 9:05:10 p. m.] Male Style: Buenas!\n[16/11/26, 9:06:00 p. m.] Cliente X: \u200e<adjunto: 00000012-PHOTO-2026-11-16-21-06-00.jpg>';
    const chat = parseWhatsAppExport(raw);
    expect(chat.messages.map((m) => m.author)).toEqual(['Male Style', 'Cliente X']);
    expect(chat.messages[0]!.sentAt.toISOString()).toBe('2026-11-17T00:05:10.000Z');
    expect(chat.messages[1]!.mediaFile).toBe('00000012-PHOTO-2026-11-16-21-06-00.jpg');
  });

  it('anonimiza teléfonos, emails, CBU, documentos y nombres', () => {
    const names = new Map([['Juana Pérez', 'Cliente 1']]);
    const out = anonymize('Soy Juana, mi cel +54 9 351 555-1234, mail juana@mail.com, DNI 30.123.456, CBU 0000003100012345678901, alias juana.mp', names);
    expect(out).toBe('Soy Cliente 1, mi cel [teléfono], mail [email], DNI [documento], CBU [cbu], alias [alias]');
  });
});

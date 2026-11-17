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

  it('anonimiza direcciones y nombres de terceros sin perder el contexto comercial', () => {
    const cases: [string, string][] = [
      ['Mandalo a Av. Colón 1234 piso 3 B, barrio General Paz, CP 5000', 'Mandalo a [dirección] [dirección], barrio [barrio], CP [código postal]'],
      ['Mi dirección es San Martín y Belgrano 450, Córdoba', 'Mi dirección es [dirección], Córdoba'],
      ['Hola Marta! Es para mi hija Sofía, lo retira de parte de Laura Gómez', 'Hola [nombre]! Es para mi hija [nombre], lo retira de parte de [nombre]'],
      ['Gracias Ana Te paso el comprobante', 'Gracias [nombre] Te paso el comprobante'],
      ['Seguime en @juani.ok', 'Seguime en [usuario]'],
      ['Envialo a Belgrano 450', 'Envialo a [dirección]'],
      ['mi dirección es belgrano 450 y llega en 2 días', 'mi dirección es [dirección] y llega en 2 días'],
      ['El envío a domicilio cuesta $3500 y llega en 2 días', 'El envío a domicilio cuesta $3500 y llega en 2 días'],
      ['Domicilio: Rivadavia 1200', 'Domicilio: [dirección]'],
      ['envialo a belgrano 450 en 2 días', 'envialo a [dirección]'],
      ['Envialo a Belgrano al 450', 'Envialo a [dirección]'],
      ['Se entrega en 10 días hábiles en Córdoba', 'Se entrega en 10 días hábiles en Córdoba'],
      ['Entrega en 48 hs y el envío a $3500 en Córdoba', 'Entrega en 48 hs y el envío a $3500 en Córdoba'],
      ['Hola Cliente 1! Buenas tardes, el Glitter Bar para 50 personas el sábado está disponible', 'Hola Cliente 1! Buenas tardes, el Glitter Bar para 50 personas el sábado está disponible'],
      ['Hola Buenas! Retiro en el local o envío por correo, mínimo 10 unidades', 'Hola Buenas! Retiro en el local o envío por correo, mínimo 10 unidades'],
    ];
    for (const [input, expected] of cases) expect(anonymize(input)).toBe(expected);
  });

  it('si la dueña está agendada con el nombre del negocio, el nombre del negocio queda en el texto', () => {
    const names = new Map([['Male Style', 'Dueña'], ['Juana Pérez', 'Cliente 1']]);
    expect(anonymize('Hola Juana! Gracias por escribir a Male Style 💖', names)).toBe('Hola Cliente 1! Gracias por escribir a Male Style 💖');
    expect(anonymize('Vivo en frente de Male Style sobre Belgrano 450', names)).not.toMatch(/450/);
  });
});

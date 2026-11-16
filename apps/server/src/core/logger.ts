import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['*.password', '*.token', '*.apiKey', 'headers.authorization', 'headers.cookie'],
      censor: '[oculto]',
    },
  });
}

export type { Logger };
